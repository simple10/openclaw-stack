#!/usr/bin/env bash
# Remove running sandbox containers so OpenClaw recreates them from current images.
#
# Sandbox containers are persistent (scope: "agent", prune.idleHours: 24) and
# keep running old images after a rebuild. This script removes them — OpenClaw
# automatically recreates them on the next agent request using the new images.
#
# Note: changes to openclaw.json may not be picked up and propagated to the sandboxes
# until the gateway is restarted.
#
# Usage:
#   scripts/restart-sandboxes.sh                      # restart agent sandboxes
#   scripts/restart-sandboxes.sh --all                # also restart browser sandboxes
#   scripts/restart-sandboxes.sh --dry-run            # show what would be removed
#   scripts/restart-sandboxes.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

ALL=false
DRY_RUN=false
FORCE=false
INSTANCE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)      ALL=true; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --force|-f) FORCE=true; shift ;;
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--all] [--force] [--dry-run] [--instance <name>]"
      echo ""
      echo "Remove sandbox containers so OpenClaw recreates them from current images."
      echo "Containers are recreated automatically on the next agent request."
      echo ""
      echo "Options:"
      echo "  --all              Also restart browser sandbox containers"
      echo "  --force            Skip confirmation prompt"
      echo "  --dry-run          Show what would be removed without executing"
      echo "  --instance <name>  Target a specific OpenClaw instance"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1

# Check gateway container is running
if ! ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker inspect -f '{{.State.Running}}' $GATEWAY 2>/dev/null" | grep -q true; then
  echo "Error: $GATEWAY container is not running on VPS" >&2
  exit 1
fi

# List sandbox containers inside the gateway's nested Docker.
# Agent sandboxes: openclaw-sbx-<agent> (e.g. openclaw-sbx-main, openclaw-sbx-code)
# Browser sandboxes: openclaw-sbx-browser-<agent>
# Filter pattern excludes browser containers unless --all is set.
if [ "$ALL" = true ]; then
  FILTER="name=openclaw-sbx-"
else
  # Match agent sandboxes but not browser sandboxes
  # List all openclaw-sbx-* then exclude openclaw-sbx-browser-*
  FILTER="name=openclaw-sbx-"
fi

CONTAINERS=$(TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GATEWAY docker ps -a --filter '$FILTER' --format '{{.Names}}\t{{.Status}}\t{{.Image}}'" 2>/dev/null || true)

# Filter out browser containers unless --all
if [ "$ALL" = false ] && [ -n "$CONTAINERS" ]; then
  CONTAINERS=$(echo "$CONTAINERS" | grep -v 'openclaw-sbx-browser-' || true)
fi

if [ -z "$CONTAINERS" ]; then
  echo "No sandbox containers found."
  exit 0
fi

# Display what we found
COUNT=$(echo "$CONTAINERS" | wc -l | tr -d ' ')
printf '\033[33mFound %s sandbox container(s):\033[0m\n' "$COUNT"
echo ""
while IFS=$'\t' read -r name status image; do
  printf "  %-35s  %-25s  %s\n" "$name" "$status" "$image"
done <<< "$CONTAINERS"
echo ""

NAMES=$(echo "$CONTAINERS" | cut -f1 | tr '\n' ' ')

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would remove: $NAMES"
  echo "[dry-run] OpenClaw would recreate them on the next agent request."
  exit 0
fi

if [ "$FORCE" = false ]; then
  printf 'Remove these containers? They will be recreated on next use. [y/N] '
  read -r CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Graceful stop (SIGTERM + 10s grace period) before removal.
printf '\033[33mStopping sandbox containers...\033[0m\n'
TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GATEWAY docker stop $NAMES" 2>/dev/null || true

# Use 'openclaw sandbox recreate' to remove containers AND clean the internal
# sandbox registry. Raw 'docker rm' leaves stale registry entries — OpenClaw
# thinks the containers still exist and tries to start them instead of creating new ones.
RECREATE_FLAGS="--all --force"
if [ "$ALL" = false ]; then
  RECREATE_FLAGS="--force"
fi
printf '\033[33mRemoving sandbox containers...\033[0m\n'
TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec --user node $GATEWAY openclaw sandbox recreate $RECREATE_FLAGS"

echo ""
printf '\033[32mDone. Removed %s sandbox container(s).\033[0m\n' "$COUNT"
echo "OpenClaw will recreate them on the next agent request using the new images."
