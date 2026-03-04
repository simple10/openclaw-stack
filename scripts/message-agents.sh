#!/usr/bin/env bash
# Send a message to all agents for a given claw.
#
# Useful for seeding agent workspace files (triggered on first invocation)
# or broadcasting a message to every configured agent.
#
# Usage:
#   scripts/message-agents.sh <claw> "your message"
#   scripts/message-agents.sh <claw> "your message" --agent ops   # one agent only
#   scripts/message-agents.sh <claw> "your message" --timeout 30  # per-agent timeout

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

CLAW=""
MESSAGE=""
SINGLE_AGENT=""
TIMEOUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)    SINGLE_AGENT="$2"; shift 2 ;;
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p; }' "$0"
      exit 0
      ;;
    -*)         echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [ -z "$CLAW" ]; then
        CLAW="$1"
      elif [ -z "$MESSAGE" ]; then
        MESSAGE="$1"
      else
        echo "Error: unexpected argument '$1'" >&2; exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$CLAW" ] || [ -z "$MESSAGE" ]; then
  err "Usage: scripts/message-agents.sh <claw> \"message\" [--agent <id>] [--timeout <seconds>]"
  exit 1
fi

# ── Resolve gateway ──────────────────────────────────────────────────────────

GATEWAY=$(resolve_gateway --instance "$CLAW") || exit 1
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
INSTANCE_NAME="${GATEWAY#${PROJECT_NAME}-openclaw-}"

# Helper to run openclaw CLI on VPS (non-interactive)
run_openclaw() {
  ${SSH_CMD} "${VPS}" "openclaw --instance ${INSTANCE_NAME} $*"
}

# ── Get agent list ───────────────────────────────────────────────────────────

header "Message agents: ${CLAW}"

if [ -n "$SINGLE_AGENT" ]; then
  AGENT_IDS=("$SINGLE_AGENT")
  info "Target agent: ${SINGLE_AGENT}"
else
  info "Fetching agent list..."
  agents_json=$(run_openclaw "agents list --json") || {
    err "Failed to list agents"
    exit 1
  }

  # Extract agent IDs from JSON array
  AGENT_IDS=()
  while IFS= read -r id; do
    AGENT_IDS+=("$id")
  done < <(echo "$agents_json" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    data.forEach(a => console.log(a.id));
  ")

  if [ ${#AGENT_IDS[@]} -eq 0 ]; then
    err "No agents found for claw '${CLAW}'"
    exit 1
  fi

  info "Found ${#AGENT_IDS[@]} agents: ${AGENT_IDS[*]}"
fi

# ── Send message to each agent ───────────────────────────────────────────────

TIMEOUT_FLAG=""
if [ -n "$TIMEOUT" ]; then
  TIMEOUT_FLAG="--timeout ${TIMEOUT}"
fi

succeeded=0
failed=0

for agent_id in "${AGENT_IDS[@]}"; do
  echo ""
  info "Sending to ${agent_id}..."

  # Escape message for shell (single-quote wrapping with escapes)
  escaped_msg=$(printf '%s' "$MESSAGE" | sed "s/'/'\\\\''/g")

  if run_openclaw "agent --agent ${agent_id} --message '${escaped_msg}' ${TIMEOUT_FLAG}" 2>&1; then
    success "${agent_id} — done"
    succeeded=$((succeeded + 1))
  else
    warn "${agent_id} — failed (exit $?)"
    failed=$((failed + 1))
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
if [ "$failed" -eq 0 ]; then
  success "All ${succeeded} agents messaged successfully"
else
  warn "${succeeded} succeeded, ${failed} failed"
  exit 1
fi
