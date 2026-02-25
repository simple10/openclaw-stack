#!/usr/bin/env bash
# Syncs media files from the VPS to local ./media/
#
# Usage:
#   ./scripts/sync-media.sh                        # sync all claws to ./media/<claw>/
#   ./scripts/sync-media.sh --instance main-claw   # sync one claw to ./media/main-claw/
#   ./scripts/sync-media.sh --instance main-claw /tmp/out  # sync one claw to custom path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"
INSTANCE=""
LOCAL_DIR=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      INSTANCE="$2"
      shift 2
      ;;
    *)
      LOCAL_DIR="$1"
      shift
      ;;
  esac
done

LOCAL_DIR="${LOCAL_DIR:-$SCRIPT_DIR/../media}"
SSH_CMD="TERM=xterm-256color ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT}"

sync_instance() {
  local name="$1"
  local dest="$2"
  local remote="${INSTALL_DIR}/instances/${name}/.openclaw/media/"

  mkdir -p "$dest"
  echo "Syncing ${name} → $dest ..."
  rsync -avz --progress \
    -e "$SSH_CMD" \
    --rsync-path="sudo rsync" \
    "${SSH_USER}@${VPS1_IP}:${remote}" \
    "$dest/"
}

if [[ -n "$INSTANCE" ]]; then
  # Sync a single claw
  sync_instance "$INSTANCE" "$LOCAL_DIR/$INSTANCE"
else
  # Discover all instances and sync each
  INSTANCES=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -o ConnectTimeout=10 -o BatchMode=yes \
    "${SSH_USER}@${VPS1_IP}" \
    "sudo ls -1 ${INSTALL_DIR}/instances/ 2>/dev/null | grep -v '^\\.'" 2>&1) || {
    echo "Error: Could not list instances on VPS" >&2
    exit 1
  }

  if [[ -z "$INSTANCES" ]]; then
    echo "Error: No claw instances found in ${INSTALL_DIR}/instances/" >&2
    exit 1
  fi

  for name in $INSTANCES; do
    sync_instance "$name" "$LOCAL_DIR/$name"
  done
fi

echo "Done."
