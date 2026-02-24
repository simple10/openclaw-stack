#!/usr/bin/env bash
# Stream logs from an OpenClaw gateway container on VPS-1
#
# Usage:
#   ./scripts/logs-openclaw.sh                      # stream all logs (tail -f)
#   ./scripts/logs-openclaw.sh 100                  # show last 100 lines then follow
#   ./scripts/logs-openclaw.sh --no-follow          # dump all logs and exit
#   ./scripts/logs-openclaw.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# Extract --instance before other args
INSTANCE_ARGS=()
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    *) POSITIONAL_ARGS+=("$1"); shift ;;
  esac
done

CONTAINER=$(resolve_gateway "${INSTANCE_ARGS[@]}" ) || exit 1
DOCKER_ARGS=("logs")

if [[ "${POSITIONAL_ARGS[0]:-}" == "--no-follow" ]]; then
  # Dump all logs without following
  true
elif [[ "${POSITIONAL_ARGS[0]:-}" =~ ^[0-9]+$ ]]; then
  # Tail N lines then follow
  DOCKER_ARGS+=("--tail" "${POSITIONAL_ARGS[0]}" "-f")
else
  # Default: follow from current position
  DOCKER_ARGS+=("--tail" "100" "-f")
fi

DOCKER_ARGS+=("$CONTAINER")

printf "\033[32mStreaming logs from %s on VPS-1 (%s)\033[0m\n" "$CONTAINER" "$VPS1_IP"

TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker ${DOCKER_ARGS[*]}"
