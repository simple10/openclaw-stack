#!/usr/bin/env bash
# Start a browser container for an agent and print the dashboard URL.
#
# Tries to start an existing (stopped) browser container first. If none exists,
# sends a message to the agent to trigger browser creation via the normal
# gateway lifecycle.
#
# Use case: pre-authenticate browser profiles (Gmail, etc.) before asking
# the agent to use the browser.
#
# Usage:
#   ./start-browser.sh              # interactive: pick from available agents
#   ./start-browser.sh main         # start browser for the main agent
#   ./start-browser.sh code         # start browser for the code agent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

GATEWAY="openclaw-gateway"
AGENT_ARG="${1:-}"
MAX_WAIT=90  # seconds to wait for browser container

# Helper: run a command inside the gateway container as node
gw_exec() {
  TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec --user node $GATEWAY $*"
}

# Helper: run a command inside the gateway container as root (for nested docker)
gw_exec_root() {
  TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec $GATEWAY $*"
}

# ── Agent selection ─────────────────────────────────────────────────

printf '\033[33mGetting agents list...\033[0m\n'

AGENTS_JSON=$(gw_exec "openclaw agents list --json 2>/dev/null" | sed '/^{"time":/d')

AGENT_IDS=$(python3 -c "
import json
agents = json.loads('''$AGENTS_JSON''')
for a in agents:
    default = ' (main)' if a.get('isDefault') and a['id'] != 'main' else ''
    print(f\"{a['id']}\t{a.get('name', a['id'])}{default}\")
" 2>/dev/null)

if [[ -z "$AGENT_IDS" ]]; then
  echo "Failed to list agents. Is the gateway running?" >&2
  exit 1
fi

if [[ -z "$AGENT_ARG" ]]; then
  echo ""
  echo "Available agents:"
  echo ""
  I=0
  while IFS=$'\t' read -r id name; do
    I=$((I + 1))
    printf "  \033[2m[%d]\033[0m \033[33m%s\033[0m\n" "$I" "$name"
  done <<< "$AGENT_IDS"
  echo ""
  printf "Select agent [1-%d]: " "$I"
  read -r SELECTION
  if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [[ "$SELECTION" -lt 1 ]] || [[ "$SELECTION" -gt "$I" ]]; then
    echo "Invalid selection." >&2
    exit 1
  fi
  AGENT=$(echo "$AGENT_IDS" | sed -n "${SELECTION}p" | cut -f1)
else
  AGENT="$AGENT_ARG"
  if ! echo "$AGENT_IDS" | awk -F'\t' -v agent="$AGENT" '$1 == agent { found=1 } END { exit !found }'; then
    echo "Unknown agent '$AGENT'." >&2
    echo ""
    echo "Available agents:"
    echo "$AGENT_IDS" | awk -F'\t' '{ printf "  %-15s  %s\n", $1, $2 }'
    exit 1
  fi
fi

printf '\033[33mStarting browser for agent "%s"...\033[0m\n' "$AGENT"

# ── Try to start existing browser container ─────────────────────────

# Look for an existing browser container (running or stopped)
BROWSER_CONTAINER=$(gw_exec_root "docker ps -a --format '{{.Names}}' --filter 'name=openclaw-sbx-browser-agent-${AGENT}-'" 2>/dev/null | head -1)

if [[ -n "$BROWSER_CONTAINER" ]]; then
  # Check if already running
  RUNNING=$(gw_exec_root "docker inspect -f '{{.State.Running}}' $BROWSER_CONTAINER" 2>/dev/null || echo "false")
  if [[ "$RUNNING" == "true" ]]; then
    printf '\033[32mBrowser container already running: %s\033[0m\n' "$BROWSER_CONTAINER"
  else
    printf '\033[33mStarting stopped browser container: %s\033[0m\n' "$BROWSER_CONTAINER"
    if gw_exec_root "docker start $BROWSER_CONTAINER" >/dev/null 2>&1; then
      printf '\033[32mBrowser container started.\033[0m\n'
    else
      printf '\033[33mFailed to start existing container (may be stale). Falling back to agent message...\033[0m\n'
      BROWSER_CONTAINER=""
    fi
  fi
fi

# ── Fall back: trigger browser creation via agent message ───────────

if [[ -z "$BROWSER_CONTAINER" ]]; then
  printf '\033[33mNo existing browser container. Sending agent message to trigger creation...\033[0m\n'

  # Send a message that reliably triggers the browser tool
  TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec --user node $GATEWAY openclaw agent --agent $AGENT \
      --message 'Use the browser tool to navigate to about:blank. Do nothing else after that.' \
      --timeout 90" >/dev/null 2>&1 &
  AGENT_PID=$!

  # Poll for the browser container to appear
  ELAPSED=0
  while [[ $ELAPSED -lt $MAX_WAIT ]]; do
    sleep 3
    ELAPSED=$((ELAPSED + 3))

    # Check if the agent command failed
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      wait "$AGENT_PID" 2>/dev/null
      AGENT_EXIT=$?
      if [[ $AGENT_EXIT -ne 0 ]]; then
        printf '\n\033[31mAgent command failed (exit %d). Check gateway logs.\033[0m\n' "$AGENT_EXIT" >&2
        exit 1
      fi
    fi

    BROWSER_CONTAINER=$(gw_exec_root "docker ps --format '{{.Names}}' --filter 'name=openclaw-sbx-browser-agent-${AGENT}-' --filter 'status=running'" 2>/dev/null | head -1)
    if [[ -n "$BROWSER_CONTAINER" ]]; then
      printf '\n\033[32mBrowser container appeared after %ds: %s\033[0m\n' "$ELAPSED" "$BROWSER_CONTAINER"
      break
    fi
    printf '  waiting... (%ds/%ds)\r' "$ELAPSED" "$MAX_WAIT"
  done

  # Clean up background process
  kill "$AGENT_PID" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true

  if [[ -z "$BROWSER_CONTAINER" ]]; then
    echo "" >&2
    printf '\033[31mTimed out waiting for browser container after %ds.\033[0m\n' "$MAX_WAIT" >&2
    echo "Check gateway logs: scripts/logs-openclaw.sh" >&2
    exit 1
  fi
fi

# ── Wait for noVNC to be ready ──────────────────────────────────────

printf '\033[33mWaiting for noVNC to be ready...\033[0m\n'
for i in $(seq 1 10); do
  # Read the noVNC port from browsers.json
  NOVNC_PORT=$(gw_exec "cat /home/node/.openclaw/sandbox/browsers.json 2>/dev/null" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for e in data.get('entries', []):
        if e['sessionKey'] == 'agent:$AGENT':
            print(e['noVncPort'])
            break
except: pass
" 2>/dev/null)

  if [[ -n "$NOVNC_PORT" ]]; then
    # TCP probe
    OPEN=$(gw_exec "timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/$NOVNC_PORT' 2>/dev/null && echo yes || echo no")
    if [[ "$OPEN" == "yes" ]]; then
      break
    fi
  fi
  sleep 2
done

# ── Print dashboard URL ─────────────────────────────────────────────

DASHBOARD_BASE="https://${OPENCLAW_DASHBOARD_DOMAIN}${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"
# WebSocket path is relative (no leading /)
WS_PREFIX="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"
WS_PREFIX="${WS_PREFIX#/}"  # strip leading /

VNC_URL="${DASHBOARD_BASE}/browser/${AGENT}/vnc.html?path=${WS_PREFIX:+${WS_PREFIX}/}browser/${AGENT}/websockify"

echo ""
printf '\033[32m=== Browser ready for agent "%s" ===\033[0m\n' "$AGENT"
echo ""
printf '\033[36m%s\033[0m\n' "$VNC_URL"
echo ""
echo "Open this URL to view/control the browser session."
echo "Pre-authenticate any services you need, then ask the agent to use the browser."
