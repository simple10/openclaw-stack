#!/usr/bin/env bash
# Debug & analyze OpenClaw session JSONL files on the VPS.
#
# No arguments: launches interactive TUI (requires bun)
# With arguments: runs Python script directly via SSH
#
# Usage:
#   scripts/debug-sessions.sh                         # Interactive TUI
#   scripts/debug-sessions.sh list                    # Direct: list sessions
#   scripts/debug-sessions.sh list --agent personal   # Direct: list filtered
#   scripts/debug-sessions.sh trace 4e29832a          # Direct: trace session
#   scripts/debug-sessions.sh metrics 4e29832a        # Direct: session metrics
#   scripts/debug-sessions.sh errors 4e29832a         # Direct: session errors
#   scripts/debug-sessions.sh summary                 # Direct: agent summary
#
# All flags (--full, --json, --no-color, --agent) are passed through in direct mode.
# --base-dir is set automatically to the VPS agents directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

# ─── No args or --tui: launch interactive TUI ────────────────────────────────

if [[ $# -eq 0 ]] || [[ "${1:-}" == "--tui" ]]; then
  if command -v bun &>/dev/null; then
    exec bun "$SCRIPT_DIR/debug-sessions/main.ts"
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
  source "$CONFIG_FILE"
  printf '\033[36mOpenClaw Session Debug Tool\033[0m (VPS: %s)\n\n' "$VPS1_IP"
  echo "Interactive TUI (no args):"
  echo "  $0"
  echo ""
  echo "Direct mode:"
  python3 "$SCRIPT_DIR/utils/debug-sessions.py" --help 2>&1 || true
  exit 0
fi

# ─── Direct mode: SCP + SSH ──────────────────────────────────────────────────

source "$CONFIG_FILE"

PYTHON_SCRIPT="$SCRIPT_DIR/utils/debug-sessions.py"
REMOTE_SCRIPT="/tmp/debug-sessions.py"
BASE_DIR="/home/openclaw/.openclaw/agents"

if [[ ! -f "$PYTHON_SCRIPT" ]]; then
  echo "Error: debug-sessions.py not found at $PYTHON_SCRIPT" >&2
  exit 1
fi

# Copy script to VPS
scp -q -i "${SSH_KEY_PATH}" -P "${SSH_PORT}" "$PYTHON_SCRIPT" "${SSH_USER}@${VPS1_IP}:${REMOTE_SCRIPT}" 2>/dev/null

# Run on VPS — inject --base-dir, pass through all user args
# Use -t for TTY (color support) only when stdout is a terminal
SSH_TTY_FLAG=""
if [[ -t 1 ]]; then
  SSH_TTY_FLAG="-t"
fi

ssh $SSH_TTY_FLAG -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo python3 ${REMOTE_SCRIPT} $* --base-dir ${BASE_DIR}"
