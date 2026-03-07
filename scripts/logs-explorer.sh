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
  source "$SCRIPT_DIR/lib/source-config.sh"
  printf '\033[36mOpenClaw Session Debug Tool\033[0m (VPS: %s)\n\n' "$ENV__VPS_IP"
  echo "Interactive TUI (no args):"
  echo "  $0"
  echo ""
  echo "Direct mode:"
  python3 "$SCRIPT_DIR/lib/logs-explorer/debug-sessions.py" --help 2>&1 || true
  exit 0
fi

# ─── Direct mode: SCP + SSH ──────────────────────────────────────────────────

source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/select-claw.sh"
source "$SCRIPT_DIR/lib/ssh.sh"

# Common SSH/SCP options (scp uses -P for port, ssh uses -p)
SSH_OPTS=("${SSH_ARGS[@]}" -o ConnectTimeout=10)
SCP_OPTS=("${SCP_ARGS[@]}" -o ConnectTimeout=10)

# Resolve instance if not specified
if [[ -z "$INSTANCE" ]]; then
  # adminclaw can't traverse /home/openclaw (750), so use sudo ls
  INSTANCES=$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes \
    "$VPS" \
    "sudo ls -1 ${STACK__STACK__INSTALL_DIR}/instances/ 2>/dev/null | grep -v '^\\.'" 2>&1) || {
    echo "Error: SSH connection failed. Check ENV__SSH_KEY/agent, ENV__SSH_PORT, ENV__SSH_USER, ENV__VPS_IP in stack.env" >&2
    echo "  ENV__SSH_USER=${ENV__SSH_USER} ENV__SSH_PORT=${ENV__SSH_PORT} ENV__VPS_IP=${ENV__VPS_IP}" >&2
    exit 1
  }

  if [[ -z "$INSTANCES" ]]; then
    echo "Error: No claw instances found in ${STACK__STACK__INSTALL_DIR}/instances/" >&2
    exit 1
  fi

  INSTANCE=$(select_claw "$INSTANCES") || exit 1
fi

INSTANCE_DIR="${STACK__STACK__INSTALL_DIR}/instances/${INSTANCE}/.openclaw"
PYTHON_SCRIPT="$SCRIPT_DIR/lib/logs-explorer/debug-sessions.py"
REMOTE_SCRIPT="/tmp/debug-sessions.py"
BASE_DIR="${INSTANCE_DIR}/agents"
LLM_LOG="${INSTANCE_DIR}/logs/telemetry.log"

if [[ ! -f "$PYTHON_SCRIPT" ]]; then
  echo "Error: debug-sessions.py not found at $PYTHON_SCRIPT" >&2
  exit 1
fi

# Copy script to VPS
if ! scp -q "${SCP_OPTS[@]}" "$PYTHON_SCRIPT" "${VPS}:${REMOTE_SCRIPT}"; then
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
TERM=xterm-256color ssh $SSH_TTY_FLAG "${SSH_OPTS[@]}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo python3 ${REMOTE_SCRIPT} $* ${EXTRA_ARGS}"
