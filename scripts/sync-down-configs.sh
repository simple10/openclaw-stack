#!/usr/bin/env bash
# sync-down-configs.sh — Download live openclaw.json configs from VPS
#
# Downloads the running config for each claw and saves it locally as
# openclaw/<claw>/openclaw.live-version.jsonc for inspection and diffing.
#
# Usage:
#   ./scripts/sync-down-configs.sh                    # All instances
#   ./scripts/sync-down-configs.sh --instance <name>  # One instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

SYNC_INSTANCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) SYNC_INSTANCE="$2"; shift 2 ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

INSTALL_DIR="$STACK__STACK__INSTALL_DIR"
SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }

# Discover instances from stack config
CLAWS_IDS="$STACK__CLAWS__IDS"
if [ -n "$SYNC_INSTANCE" ]; then
  INSTANCE_LIST="$SYNC_INSTANCE"
else
  INSTANCE_LIST=$(echo "$CLAWS_IDS" | tr ',' ' ')
fi

for name in $INSTANCE_LIST; do
  remote_file="${INSTALL_DIR}/instances/${name}/.openclaw/openclaw.json"
  local_dir="${REPO_ROOT}/openclaw/${name}"
  local_file="${local_dir}/openclaw.live-version.jsonc"

  mkdir -p "$local_dir"

  info "Downloading live config for ${name}..."
  if eval rsync -avz -e "'${SSH_CMD}'" --rsync-path="'sudo rsync'" \
    "${VPS}:${remote_file}" "$local_file" 2>/dev/null; then
    success "${local_file}"
  else
    warn "No live config found for ${name} (not yet deployed?)"
    continue
  fi
done

echo ""
echo "Review changes with:"
for name in $INSTANCE_LIST; do
  live_file="openclaw/${name}/openclaw.live-version.jsonc"
  [ -f "${REPO_ROOT}/${live_file}" ] || continue
  # Find the source config for this claw
  if [ -f "${REPO_ROOT}/openclaw/${name}/openclaw.jsonc" ]; then
    echo "  diff openclaw/${name}/openclaw.jsonc ${live_file}"
  else
    echo "  diff openclaw/default/openclaw.jsonc ${live_file}"
  fi
done
