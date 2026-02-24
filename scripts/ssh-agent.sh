#!/usr/bin/env bash
# SSH into an agent's sandbox container on the VPS.
#
# Shows available agents, their sandbox status, and lets you pick one.
# If the chosen agent has no sandbox yet, sends a ping via the openclaw CLI
# to trigger creation, waits for it to appear, then execs in.
#
# Usage:
#   ./ssh-agent.sh                      # interactive: pick from available agents
#   ./ssh-agent.sh main                 # exec into the main agent sandbox
#   ./ssh-agent.sh code                 # exec into the code agent sandbox
#   ./ssh-agent.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# Extract --instance before positional args
INSTANCE_ARGS=()
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    *) POSITIONAL_ARGS+=("$1"); shift ;;
  esac
done

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1

printf '\033[33mGetting agents list from %s...\033[0m\n' "$GATEWAY"

AGENT_ARG="${POSITIONAL_ARGS[0]:-}"
MAX_WAIT=60  # seconds to wait for sandbox to appear

# Helper: run a command on the VPS inside the gateway container as node
gw_exec() {
  TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec --user node $GATEWAY $*"
}

# Fetch agents list and sandbox status in one SSH call
COMBINED_JSON=$(TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec --user node $GATEWAY sh -c '
    echo \"===AGENTS===\"
    openclaw agents list --json 2>/dev/null
    echo \"===SANDBOXES===\"
    openclaw sandbox list --json 2>/dev/null
  '" | sed '/^{"time":/d')

AGENTS_JSON=$(echo "$COMBINED_JSON" | sed -n '/===AGENTS===/,/===SANDBOXES===/{ /===AGENTS===/d; /===SANDBOXES===/d; p; }')
SANDBOX_JSON=$(echo "$COMBINED_JSON" | sed -n '/===SANDBOXES===/,$ { /===SANDBOXES===/d; p; }')

# Build a table: id, name, sandbox status
AGENT_TABLE=$(python3 -c "
import json, sys

agents = json.loads('''$AGENTS_JSON''')
sandboxes = json.loads('''$SANDBOX_JSON''')

# Map agent id -> sandbox info
sandbox_map = {}
for c in sandboxes.get('containers', []):
    session = c.get('sessionKey', '')
    parts = session.split(':')
    if len(parts) >= 2:
        agent_id = parts[1]
        status = 'running' if c.get('running') else 'stopped'
        sandbox_map[agent_id] = {'container': c['containerName'], 'status': status}

for a in agents:
    aid = a['id']
    name = a.get('name', aid)
    default = ' (main)' if a.get('isDefault') and name != 'main' else ''
    sbx = sandbox_map.get(aid)
    if sbx:
        sbx_status = sbx['status']
        sbx_container = sbx['container']
    else:
        sbx_status = 'none'
        sbx_container = '-'
    print(f'{aid}\t{name}{default}\t{sbx_status}\t{sbx_container}')
" 2>/dev/null)

if [[ -z "$AGENT_TABLE" ]]; then
  echo "Failed to list agents. Is the gateway running?" >&2
  exit 1
fi

# If no argument provided, show interactive picker
if [[ -z "$AGENT_ARG" ]]; then
  echo ""
  echo "Available agents:"
  echo ""
  I=0
  while IFS=$'\t' read -r id name status container; do
    I=$((I + 1))
    # Color the sandbox status
    case "$status" in
      running) status_display="\033[32m$status\033[0m" ;;
      stopped) status_display="\033[33m$status\033[0m" ;;
      none)    status_display="\033[90mnone\033[0m" ;;
    esac
    printf "  \033[2m[%d]\033[0m \033[33m%-20s\033[0m  \033[2msandbox:\033[0m %b\n" "$I" "$name" "$status_display"
  done <<< "$AGENT_TABLE"
  echo ""
  printf "Select agent [1-%d]: " "$I"
  read -r SELECTION
  if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [[ "$SELECTION" -lt 1 ]] || [[ "$SELECTION" -gt "$I" ]]; then
    echo "Invalid selection." >&2
    exit 1
  fi
  LINE=$(echo "$AGENT_TABLE" | sed -n "${SELECTION}p")
  AGENT=$(echo "$LINE" | cut -f1)
  CONTAINER_STATUS=$(echo "$LINE" | cut -f3)
  CONTAINER_NAME=$(echo "$LINE" | cut -f4)
else
  # Direct agent argument — look it up
  AGENT="$AGENT_ARG"
  LINE=$(echo "$AGENT_TABLE" | awk -F'\t' -v agent="$AGENT" '$1 == agent { print; exit }')
  if [[ -z "$LINE" ]]; then
    echo "Unknown agent '$AGENT'." >&2
    echo ""
    echo "Available agents:"
    echo "$AGENT_TABLE" | awk -F'\t' '{ printf "  %-15s  %s\n", $1, $2 }'
    exit 1
  fi
  CONTAINER_STATUS=$(echo "$LINE" | cut -f3)
  CONTAINER_NAME=$(echo "$LINE" | cut -f4)
fi

# Helper: find sandbox container for an agent from fresh data
find_sandbox() {
  local agent="$1"
  gw_exec "openclaw sandbox list --json 2>/dev/null" \
    | sed '/^{"time":/d' \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('containers', []):
    session = c.get('sessionKey', '')
    parts = session.split(':')
    if len(parts) >= 2 and parts[1] == '$agent':
        status = 'running' if c.get('running') else 'stopped'
        print(c['containerName'] + '\t' + status)
        break
" 2>/dev/null || true
}

# If no sandbox exists, trigger creation via agent message
if [[ "$CONTAINER_STATUS" == "none" ]]; then
  printf '\033[33mNo sandbox for agent "%s" — triggering creation...\033[0m\n' "$AGENT"

  # Send a message to the agent to trigger sandbox creation.
  # The agent loop creates the sandbox container when a tool is needed (requires sandbox.mode = "all" per agent).
  # Stdout suppressed (agent response not needed); stderr preserved so errors are visible.
  TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec --user node $GATEWAY openclaw agent --agent $AGENT --message ping --timeout 60" \
    >/dev/null &
  AGENT_PID=$!

  # Poll for the sandbox container to appear
  ELAPSED=0
  while [[ $ELAPSED -lt $MAX_WAIT ]]; do
    sleep 3
    ELAPSED=$((ELAPSED + 3))

    # Check if the agent command already exited with an error
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      wait "$AGENT_PID" 2>/dev/null
      AGENT_EXIT=$?
      if [[ $AGENT_EXIT -ne 0 ]]; then
        printf '\n\033[31mAgent command failed (exit %d). Check gateway logs.\033[0m\n' "$AGENT_EXIT" >&2
        exit 1
      fi
    fi

    RESULT=$(find_sandbox "$AGENT")
    if [[ -n "$RESULT" ]]; then
      CONTAINER_NAME=$(echo "$RESULT" | cut -f1)
      CONTAINER_STATUS=$(echo "$RESULT" | cut -f2)
      printf '\n\033[32mSandbox appeared after %ds\033[0m\n' "$ELAPSED"
      break
    fi
    printf '  waiting... (%ds/%ds)\r' "$ELAPSED" "$MAX_WAIT"
  done

  # Clean up background process
  kill "$AGENT_PID" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true

  if [[ "$CONTAINER_STATUS" == "none" ]]; then
    echo "" >&2
    printf '\033[31mTimed out waiting for sandbox to appear after %ds.\033[0m\n' "$MAX_WAIT" >&2
    echo "Try: openclaw agent --agent $AGENT --message ping --timeout 60" >&2
    echo "Check gateway logs: openclaw logs --follow" >&2
    exit 1
  fi
fi

# Start container if stopped — if it fails (stale registry entry), trigger recreation
if [[ "$CONTAINER_STATUS" == "stopped" ]]; then
  printf '\033[33mContainer %s is stopped — starting...\033[0m\n' "$CONTAINER_NAME"
  if ! ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker exec $GATEWAY docker start $CONTAINER_NAME" >/dev/null 2>&1; then
    # Container was removed but registry still had an entry (e.g. after restart-sandboxes.sh).
    # Clean the stale entry and trigger fresh sandbox creation via agent message.
    printf '\033[33mContainer no longer exists — cleaning stale entry and recreating...\033[0m\n'
    TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
      "sudo docker exec --user node $GATEWAY openclaw sandbox recreate --all --force" >/dev/null 2>&1 || true

    TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
      "sudo docker exec --user node $GATEWAY openclaw agent --agent $AGENT --message ping --timeout 60" \
      >/dev/null &
    AGENT_PID=$!

    ELAPSED=0
    while [[ $ELAPSED -lt $MAX_WAIT ]]; do
      sleep 3
      ELAPSED=$((ELAPSED + 3))
      if ! kill -0 "$AGENT_PID" 2>/dev/null; then
        wait "$AGENT_PID" 2>/dev/null
        AGENT_EXIT=$?
        if [[ $AGENT_EXIT -ne 0 ]]; then
          printf '\n\033[31mAgent command failed (exit %d). Check gateway logs.\033[0m\n' "$AGENT_EXIT" >&2
          exit 1
        fi
      fi
      RESULT=$(find_sandbox "$AGENT")
      if [[ -n "$RESULT" ]]; then
        CONTAINER_NAME=$(echo "$RESULT" | cut -f1)
        CONTAINER_STATUS=$(echo "$RESULT" | cut -f2)
        printf '\n\033[32mSandbox recreated after %ds\033[0m\n' "$ELAPSED"
        break
      fi
      printf '  waiting... (%ds/%ds)\r' "$ELAPSED" "$MAX_WAIT"
    done

    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true

    if [[ -z "$CONTAINER_NAME" ]] || [[ "$CONTAINER_STATUS" == "none" ]]; then
      echo "" >&2
      printf '\033[31mTimed out waiting for sandbox after %ds.\033[0m\n' "$MAX_WAIT" >&2
      exit 1
    fi
  fi
fi

printf '\033[32mExec into %s (%s agent)\033[0m\n' "$CONTAINER_NAME" "$AGENT"
TERM=xterm-256color ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it $GATEWAY docker exec -it -u 1000:1000 -w /workspace $CONTAINER_NAME bash"
