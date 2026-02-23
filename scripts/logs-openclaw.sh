#!/usr/bin/env bash
# Stream logs from the openclaw-gateway container on VPS-1
#
# Usage:
#   ./scripts/logs-openclaw.sh              # stream all logs (tail -f)
#   ./scripts/logs-openclaw.sh 100          # show last 100 lines then follow
#   ./scripts/logs-openclaw.sh --no-follow  # dump all logs and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

CONTAINER="openclaw-gateway"
DOCKER_ARGS=("logs")

if [[ "${1:-}" == "--no-follow" ]]; then
  # Dump all logs without following
  shift
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  # Tail N lines then follow
  DOCKER_ARGS+=("--tail" "$1" "-f")
  shift
else
  # Default: follow from current position
  DOCKER_ARGS+=("--tail" "100" "-f")
fi

DOCKER_ARGS+=("$CONTAINER")

printf "\033[32mStreaming logs from %s on VPS-1 (%s)\033[0m\n" "$CONTAINER" "$VPS1_IP"

TERM=xterm-256color ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker ${DOCKER_ARGS[*]}"
