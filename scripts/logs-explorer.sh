#!/usr/bin/env bash
# Debug & analyze OpenClaw session JSONL files and LLM logs on the VPS.
#
# No arguments: launches interactive TUI (requires bun)
# With arguments: runs Python script directly via SSH
#
# Usage:
#   scripts/logs-explorer.sh                              # Interactive TUI
#   scripts/logs-explorer.sh --instance test-claw         # TUI for specific instance
#   scripts/logs-explorer.sh list                         # Direct: list sessions
#   scripts/logs-explorer.sh list --agent personal        # Direct: list filtered
#   scripts/logs-explorer.sh trace 4e29832a               # Direct: trace session
#   scripts/logs-explorer.sh metrics 4e29832a             # Direct: session metrics
#   scripts/logs-explorer.sh errors 4e29832a              # Direct: session errors
#   scripts/logs-explorer.sh summary                      # Direct: agent summary
#   scripts/logs-explorer.sh llm-list                     # Direct: list LLM calls
#   scripts/logs-explorer.sh llm-list --agent personal    # Direct: filtered LLM calls
#   scripts/logs-explorer.sh llm-trace 4e29832a           # Direct: LLM trace for session
#   scripts/logs-explorer.sh llm-summary                  # Direct: LLM stats
#
# All flags (--full, --json, --no-color, --agent) are passed through in direct mode.
# --base-dir and --llm-log are set automatically to the VPS paths.
# --instance selects which claw to debug (auto-detects if only one is running).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Extract --instance flag early (before TUI/direct mode split) ────────────

INSTANCE=""
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2 ;;
    *) REMAINING_ARGS+=("$1"); shift ;;
  esac
done
set -- ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}

# Fall back to env var
INSTANCE="${INSTANCE:-${OPENCLAW_INSTANCE:-}}"

# ─── No args or --tui: launch interactive TUI ────────────────────────────────

if [[ $# -eq 0 ]] || [[ "${1:-}" == "--tui" ]]; then
  if command -v bun &>/dev/null; then
    OPENCLAW_INSTANCE="${INSTANCE}" exec bun "$SCRIPT_DIR/lib/logs-explorer/main.ts"
  else
    echo "Error: bun is required for the interactive TUI." >&2
    echo "Install: curl -fsSL https://bun.sh/install | bash" >&2
    echo "" >&2
    echo "Or use direct mode: $0 list" >&2
    exit 1
  fi
fi

# ─── Help ─────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
  source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"
  printf '\033[36mOpenClaw Session Debug Tool\033[0m (VPS: %s)\n\n' "$VPS1_IP"
  echo "Interactive TUI (no args):"
  echo "  $0"
  echo ""
  echo "Direct mode:"
  python3 "$SCRIPT_DIR/lib/logs-explorer/debug-sessions.py" --help 2>&1 || true
  exit 0
fi

# ─── Direct mode: SCP + SSH ──────────────────────────────────────────────────

source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"

# Common SSH/SCP options (scp uses -P for port, ssh uses -p)
SSH_COMMON=(-i "${SSH_KEY_PATH}" -o ConnectTimeout=10)
SSH_OPTS=("${SSH_COMMON[@]}" -p "${SSH_PORT}")
SCP_OPTS=("${SSH_COMMON[@]}" -P "${SSH_PORT}")

# Resolve instance if not specified
if [[ -z "$INSTANCE" ]]; then
  # adminclaw can't traverse /home/openclaw (750), so use sudo ls
  INSTANCES=$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes \
    "${SSH_USER}@${VPS1_IP}" \
    "sudo ls -1 ${INSTALL_DIR}/instances/ 2>/dev/null | grep -v '^\\.'" 2>&1) || {
    echo "Error: SSH connection failed. Check SSH_KEY_PATH, SSH_PORT, SSH_USER, VPS1_IP in openclaw-config.env" >&2
    echo "  SSH_USER=${SSH_USER} SSH_PORT=${SSH_PORT} VPS1_IP=${VPS1_IP}" >&2
    exit 1
  }

  COUNT=$(echo "$INSTANCES" | grep -c . || true)

  if [[ "$COUNT" -eq 1 ]]; then
    INSTANCE="$INSTANCES"
    printf '\033[33mAuto-detected single claw: %s\033[0m\n' "$INSTANCE"
  elif [[ "$COUNT" -eq 0 ]]; then
    echo "Error: No claw instances found in ${INSTALL_DIR}/instances/" >&2
    exit 1
  else
    echo "Error: Multiple claw instances found. Specify which one:" >&2
    while IFS= read -r inst; do
      echo "  --instance $inst" >&2
    done <<< "$INSTANCES"
    exit 1
  fi
fi

INSTANCE_DIR="${INSTALL_DIR}/instances/${INSTANCE}/.openclaw"
PYTHON_SCRIPT="$SCRIPT_DIR/lib/logs-explorer/debug-sessions.py"
REMOTE_SCRIPT="/tmp/debug-sessions.py"
BASE_DIR="${INSTANCE_DIR}/agents"
LLM_LOG="${INSTANCE_DIR}/logs/telemetry.log"

if [[ ! -f "$PYTHON_SCRIPT" ]]; then
  echo "Error: debug-sessions.py not found at $PYTHON_SCRIPT" >&2
  exit 1
fi

# Copy script to VPS
if ! scp -q "${SCP_OPTS[@]}" "$PYTHON_SCRIPT" "${SSH_USER}@${VPS1_IP}:${REMOTE_SCRIPT}"; then
  echo "Error: Failed to copy debug script to VPS" >&2
  exit 1
fi

# Run on VPS — inject --base-dir and --llm-log, pass through all user args
# Use -t for TTY (color support) only when stdout is a terminal
SSH_TTY_FLAG=""
if [[ -t 1 ]]; then
  SSH_TTY_FLAG="-t"
fi

# Inject --llm-log for llm-* subcommands
EXTRA_ARGS="--base-dir ${BASE_DIR}"
case "${1:-}" in
  llm-*) EXTRA_ARGS="${EXTRA_ARGS} --llm-log ${LLM_LOG}" ;;
esac

# sudo: adminclaw can't read /home/openclaw directly
TERM=xterm-256color ssh $SSH_TTY_FLAG "${SSH_OPTS[@]}" "${SSH_USER}@${VPS1_IP}" \
  "sudo python3 ${REMOTE_SCRIPT} $* ${EXTRA_ARGS}"
