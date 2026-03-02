#!/usr/bin/env bash
# Stream logs from ALL Docker containers on VPS-1
#
# Usage:
#   ./scripts/logs-all.sh              # stream all logs (tail -f)
#   ./scripts/logs-all.sh 100          # show last 100 lines then follow
#   ./scripts/logs-all.sh --no-follow  # dump all logs and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

COMPOSE_DIR="${STACK__STACK__INSTALL_DIR}"
COMPOSE_ARGS=("logs")

if [[ "${1:-}" == "--no-follow" ]]; then
  shift
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  COMPOSE_ARGS+=("--tail" "$1" "-f")
  shift
else
  COMPOSE_ARGS+=("--tail" "100" "-f")
fi

printf "\033[32mStreaming logs from all containers on VPS-1 (%s)\033[0m\n" "$ENV__VPS_IP"

TERM=xterm-256color ssh -t -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo -u openclaw bash -c 'cd $COMPOSE_DIR && docker compose ${COMPOSE_ARGS[*]}'"

# Alternate if multiple compose files:
# docker ps -q | xargs -I {} docker logs -f {}
