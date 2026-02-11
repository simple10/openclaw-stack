#!/usr/bin/env bash
# Start a Claude Code session in a sandbox container on the VPS.
#
# Runs a fresh claude sandbox container inside the gateway's nested Docker,
# mounting .claude-sandbox credentials so auth persists across sessions.
#
# Chain: local -> VPS (SSH) -> gateway (docker exec) -> sandbox (docker run) -> claude
#
# Usage:
#   ./claude-sandbox.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

GATEWAY="openclaw-gateway"

printf 'Start a Claude Code session in a remote sandbox on %s? [Y/n] ' "$VPS1_IP"
read -r CONFIRM
if [[ "$CONFIRM" =~ ^[Nn]$ ]]; then
  echo "Cancelled."
  exit 0
fi

printf '\033[32mConnecting to remote sandbox...\033[0m\n'
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -t "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it $GATEWAY docker run --rm -it \
    -v /home/node/.claude-sandbox:/home/linuxbrew/.claude \
    --tmpfs /home/linuxbrew:uid=1000,gid=1000 \
    --tmpfs /tmp \
    -u 1000:1000 \
    openclaw-sandbox-common:bookworm-slim claude"
