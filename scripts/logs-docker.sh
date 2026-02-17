#!/usr/bin/env bash
# Stream logs from ALL Docker containers on VPS-1
#
# Usage:
#   ./scripts/logs-all.sh              # stream all logs (tail -f)
#   ./scripts/logs-all.sh 100          # show last 100 lines then follow
#   ./scripts/logs-all.sh --no-follow  # dump all logs and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

COMPOSE_DIR="/home/openclaw/openclaw"
COMPOSE_ARGS=("logs")

if [[ "${1:-}" == "--no-follow" ]]; then
  shift
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  COMPOSE_ARGS+=("--tail" "$1" "-f")
  shift
else
  COMPOSE_ARGS+=("--tail" "100" "-f")
fi

printf "\033[32mStreaming logs from all containers on VPS-1 (%s)\033[0m\n" "$VPS1_IP"

ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo -u openclaw bash -c 'cd $COMPOSE_DIR && docker compose ${COMPOSE_ARGS[*]}'"

# Alternate if multiple compose files:
# docker ps -q | xargs -I {} docker logs -f {}
