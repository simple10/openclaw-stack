#!/usr/bin/env bash
# Reset SSH known_hosts entry for the VPS and reconnect.
# Use after reinstalling the OS to re-confirm the new host key fingerprint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${SCRIPT_DIR}/../openclaw-config.env"

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG" >&2
  exit 1
fi

source "$CONFIG"

: "${VPS1_IP:?VPS1_IP not set in openclaw-config.env}"
: "${SSH_KEY_PATH:=~/.ssh/vps1_openclaw_ed25519}"
: "${SSH_USER:=ubuntu}"
: "${SSH_PORT:=22}"

# Expand ~ in SSH_KEY_PATH
SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"

echo "Removing $VPS1_IP from known_hosts (all ports)..."
ssh-keygen -R "$VPS1_IP" 2>/dev/null || true
ssh-keygen -R "[$VPS1_IP]:$SSH_PORT" 2>/dev/null || true

echo ""
echo "Connecting to $SSH_USER@$VPS1_IP:$SSH_PORT"
echo "You will be prompted to confirm the new host key fingerprint."
echo ""

exec ssh -t -i "$SSH_KEY_PATH" -p "$SSH_PORT" "$SSH_USER@$VPS1_IP"
