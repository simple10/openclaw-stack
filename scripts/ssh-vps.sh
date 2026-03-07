#!/usr/bin/env bash
# SSH into VPS-1 (openclaw)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/ssh.sh"

printf "\033[32mSSH'ing into OpenClaw VPS as ${ENV__SSH_USER} \033[0m\n"
# Set TERM to fix issues when running this script via ghostty
TERM=xterm-256color "${SSH_CMD[@]}" -t "$VPS"
