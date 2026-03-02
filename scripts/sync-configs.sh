#!/usr/bin/env bash
# Syncs OpenClaw configs and workspace from VPS to local synced/<name>/
#
# Usage:
#   ./scripts/sync-configs.sh                          # sync everything for all claws
#   ./scripts/sync-configs.sh --instance main-claw     # sync one claw
#   ./scripts/sync-configs.sh --configs-only            # openclaw.json only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

INSTANCE=""
CONFIGS_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)     INSTANCE="$2"; shift 2 ;;
    --configs-only) CONFIGS_ONLY=true; shift ;;
    *)              echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT}"
LOCAL_BASE="${REPO_ROOT}/synced"

sync_instance() {
  local name="$1"
  local dest="${LOCAL_BASE}/${name}"
  local remote_base="${STACK__STACK__INSTANCES_DIR}/${name}"

  mkdir -p "$dest"

  # openclaw.json
  echo "[$name] Syncing openclaw.json ..."
  rsync -avz \
    -e "$SSH_CMD" \
    --rsync-path="sudo rsync" \
    "${ENV__SSH_USER}@${ENV__VPS_IP}:${remote_base}/.openclaw/openclaw.json" \
    "$dest/openclaw.json"

  if [[ "$CONFIGS_ONLY" == "true" ]]; then
    return
  fi

  # workspace
  echo "[$name] Syncing workspace/ ..."
  mkdir -p "$dest/workspace"
  rsync -avz --progress \
    -e "$SSH_CMD" \
    --rsync-path="sudo rsync" \
    "${ENV__SSH_USER}@${ENV__VPS_IP}:${remote_base}/.openclaw/workspace/" \
    "$dest/workspace/"

}

# Discover instances
if [[ -n "$INSTANCE" ]]; then
  sync_instance "$INSTANCE"
else
  INSTANCES=$(ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" -o ConnectTimeout=10 -o BatchMode=yes \
    "${ENV__SSH_USER}@${ENV__VPS_IP}" \
    "sudo ls -1 ${STACK__STACK__INSTANCES_DIR}/ 2>/dev/null | grep -v '^\\.'" 2>&1) || {
    echo "Error: Could not list instances on VPS" >&2
    exit 1
  }

  if [[ -z "$INSTANCES" ]]; then
    echo "Error: No claw instances found in ${STACK__STACK__INSTANCES_DIR}/" >&2
    exit 1
  fi

  for name in $INSTANCES; do
    sync_instance "$name"
  done
fi

echo "Done."
