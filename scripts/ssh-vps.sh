#!/usr/bin/env bash
# SSH into VPS-1 (openclaw)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"

printf "\033[32mSSH'ing into OpenClaw VPS as ${SSH_USER} \033[0m\n"
# Set TERM to fix issues when running this script via ghostty
TERM=xterm-256color ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}"
