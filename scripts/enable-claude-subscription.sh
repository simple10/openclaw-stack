#!/usr/bin/env bash
# Set the Claude Code OAuth setup token on both:
#   1. The AI Gateway worker (via wrangler secret)
#   2. Selected OpenClaw agents on the VPS (via auth-profiles.json)
#
# Usage:
#   ./set-claude-oauth-token.sh           # interactive: pick agents
#   ./set-claude-oauth-token.sh --all     # apply to all agents

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"
WORKER_DIR="$SCRIPT_DIR/../workers/ai-gateway"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

# ── Info ──────────────────────────────────────────────────────────

printf '\n\033[33m  OpenClaw Anthropic Subscription Token Setup\033[0m\n\n'
printf '  You need a claude setup token before proceeding\n'
printf '  Run: \033[32mclaude setup-token\033[0m\n\n'
printf '\033[90m  This script saves your setup token to your Cloudflare AI worker.\n'
printf '  The token is not shared with OpenClaw or saved on your VPS.\n\n'
printf '  Selected agents will use your claude subscription through the proxy.\n'
printf '  Agents skipped here will fall back to the Anthropic API key\n'
printf '  configured in your Cloudflare worker secrets (if any).\033[0m\n\n'

# ── Step 1: Prompt for setup token ────────────────────────────────

echo "Paste your claude setup token (input hidden):"
read -rs TOKEN

if [[ -z "$TOKEN" ]]; then
  echo "Error: token cannot be empty" >&2
  exit 1
fi

# ── Step 2: Set secret on AI Gateway worker ───────────────────────

printf '\n\033[33mSetting CLAUDE_CODE_OAUTH_TOKEN on AI Gateway worker...\033[0m\n'
echo "$TOKEN" | wrangler secret put CLAUDE_CODE_OAUTH_TOKEN --cwd "$WORKER_DIR"
printf '\033[90mYour token was securely stored in you Cloudflare worker.\033[0m\n\n'

# ── Step 3: Configure OpenClaw agents on VPS ──────────────────────

GATEWAY="openclaw-gateway"
ALL_FLAG="${1:-}"

# Helper: run a command on the VPS
vps_ssh() {
  ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" "$@"
}

# ── Fetch agents list ──────────────────────────────────────────────

printf '\033[33mGetting agents list from openclaw gateway...\033[0m\n'

AGENTS_JSON=$(vps_ssh \
  "sudo docker exec --user node $GATEWAY openclaw agents list --json 2>/dev/null" \
  | sed '/^{"time":/d')

AGENT_TABLE=$(python3 -c "
import json, sys
agents = json.loads('''$AGENTS_JSON''')
for a in agents:
    aid = a['id']
    name = a.get('name', aid)
    default = ' (default)' if a.get('isDefault') else ''
    print(f'{aid}\t{name}{default}')
" 2>/dev/null)

if [[ -z "$AGENT_TABLE" ]]; then
  echo "Failed to list agents. Is the gateway running?" >&2
  exit 1
fi

# ── Select agents ──────────────────────────────────────────────────

SELECTED_IDS=()

if [[ "$ALL_FLAG" == "--all" ]]; then
  while IFS=$'\t' read -r id _name; do
    SELECTED_IDS+=("$id")
  done <<< "$AGENT_TABLE"
else
  echo ""
  echo "Available agents:"
  echo ""
  I=0
  while IFS=$'\t' read -r id name; do
    I=$((I + 1))
    printf "  \033[2m[%d]\033[0m \033[33m%-20s\033[0m\n" "$I" "$name"
  done <<< "$AGENT_TABLE"
  echo ""
  printf "Select agents (comma-separated, e.g. 1,3 or 'all'): "
  read -r SELECTION

  if [[ "$SELECTION" == "all" ]]; then
    while IFS=$'\t' read -r id _name; do
      SELECTED_IDS+=("$id")
    done <<< "$AGENT_TABLE"
  else
    IFS=',' read -ra PICKS <<< "$SELECTION"
    TOTAL=$(echo "$AGENT_TABLE" | wc -l | tr -d ' ')
    for pick in "${PICKS[@]}"; do
      pick=$(echo "$pick" | tr -d ' ')
      if ! [[ "$pick" =~ ^[0-9]+$ ]] || [[ "$pick" -lt 1 ]] || [[ "$pick" -gt "$TOTAL" ]]; then
        echo "Invalid selection: $pick" >&2
        exit 1
      fi
      LINE=$(echo "$AGENT_TABLE" | sed -n "${pick}p")
      SELECTED_IDS+=("$(echo "$LINE" | cut -f1)")
    done
  fi
fi

if [[ ${#SELECTED_IDS[@]} -eq 0 ]]; then
  echo "No agents selected." >&2
  exit 1
fi

# ── Write auth-profiles.json ──────────────────────────────────────

AUTH_PROFILE=$(cat <<EOF
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "token",
      "provider": "anthropic",
      "token": "$TOKEN"
    }
  }
}
EOF
)

echo ""
for AGENT_ID in "${SELECTED_IDS[@]}"; do
  PROFILE_DIR="/home/node/.openclaw/agents/${AGENT_ID}/agent"
  PROFILE_PATH="${PROFILE_DIR}/auth-profiles.json"

  printf '  Writing auth-profiles.json for agent \033[33m%s\033[0m ... ' "$AGENT_ID"
  vps_ssh "sudo docker exec --user node $GATEWAY sh -c 'mkdir -p \"$PROFILE_DIR\" && cat > \"$PROFILE_PATH\"'" <<< "$AUTH_PROFILE"
  printf '\033[32mdone\033[0m\n'
done

# ── Restart gateway ───────────────────────────────────────────────

echo ""
printf '\033[33mRestarting gateway...\033[0m\n'
vps_ssh "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'" >/dev/null 2>&1
printf '\033[32mGateway restarted. Token applied to %d agent(s).\033[0m\n' "${#SELECTED_IDS[@]}"

printf '\n\033[33m  Next step:\033[0m Send a message to one of your configured agents\n'
printf '\033[90m  to verify it can reach Anthropic through your subscription.\033[0m\n\n'
