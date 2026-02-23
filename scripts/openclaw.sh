#!/usr/bin/env bash
# Run openclaw CLI commands on the VPS via SSH
# Usage: scripts/openclaw.sh <command> [args...]
# Examples:
#   scripts/openclaw.sh status
#   scripts/openclaw.sh doctor --deep
#   scripts/openclaw.sh security audit --deep
#   scripts/openclaw.sh devices list

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

if [[ $# -eq 0 ]]; then
  echo "Usage: $(basename "$0") <command> [args...]" >&2
  echo "Runs 'openclaw <command>' on the VPS via SSH." >&2
  exit 1
fi

TERM=xterm-256color ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" "openclaw $*"
