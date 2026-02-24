#!/usr/bin/env bash
# Force-rebuild sandbox images on the VPS without gateway downtime.
# Builds happen inside the running gateway's nested Docker — new sandbox
# containers launched by agents automatically use the fresh images.
#
# Usage:
#   scripts/update-sandboxes.sh                      # rebuild toolkit (+ base if needed)
#   scripts/update-sandboxes.sh --all                # also rebuild browser sandbox
#   scripts/update-sandboxes.sh --dry-run            # show what would be rebuilt
#   scripts/update-sandboxes.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# Pass through flags to rebuild-sandboxes.sh
FLAGS="--force"
INSTANCE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)      FLAGS="$FLAGS --all"; shift ;;
    --dry-run)  FLAGS="$FLAGS --dry-run"; shift ;;
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--all] [--dry-run] [--instance <name>]"
      echo ""
      echo "Force-rebuild sandbox images on the VPS without gateway downtime."
      echo ""
      echo "Options:"
      echo "  --all              Also rebuild browser sandbox image"
      echo "  --dry-run          Show what would be rebuilt without executing"
      echo "  --instance <name>  Target a specific OpenClaw instance"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

GATEWAY=$(resolve_gateway "${INSTANCE_ARGS[@]}" ) || exit 1

printf '\033[32mRebuilding sandbox images on %s...\033[0m\n' "$VPS1_IP"

# Check gateway container is running
if ! ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker inspect -f '{{.State.Running}}' $GATEWAY 2>/dev/null" | grep -q true; then
  echo "Error: $GATEWAY container is not running on VPS" >&2
  exit 1
fi

# Run rebuild-sandboxes.sh inside the running gateway container
TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -t "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GATEWAY /app/deploy/rebuild-sandboxes.sh $FLAGS"

echo ""
printf '\033[32mDone. New sandbox containers will use the rebuilt images.\033[0m\n'
