#!/usr/bin/env bash
# Syncs media files from the VPS to local ./media/
#
# Usage:
#   ./scripts/sync-media.sh           # sync to ./media/
#   ./scripts/sync-media.sh /tmp/out  # sync to custom path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

LOCAL_DIR="${1:-$SCRIPT_DIR/../media}"
REMOTE_PATH="${INSTALL_DIR:-/home/openclaw}/.openclaw/media/"

mkdir -p "$LOCAL_DIR"

echo "Syncing media from VPS to $LOCAL_DIR ..."
rsync -avz --progress \
  -e "TERM=xterm-256color ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT}" \
  --rsync-path="sudo rsync" \
  "${SSH_USER}@${VPS1_IP}:${REMOTE_PATH}" \
  "$LOCAL_DIR/"

echo "Done."
