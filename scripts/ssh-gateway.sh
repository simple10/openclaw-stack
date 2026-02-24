#!/usr/bin/env bash
# Opens an interactive bash shell inside an OpenClaw gateway container on VPS-1.
#
# Usage:
#   scripts/ssh-gateway.sh                      # auto-detect instance
#   scripts/ssh-gateway.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

GATEWAY=$(resolve_gateway "$@") || exit 1

printf '\033[32mStarting bash session in %s container \033[0m\n' "$GATEWAY"
printf 'OpenClaw CLI:\033[33m openclaw \033[0m \n'
printf 'Example: openclaw security audit --deep \n'
TERM=xterm-256color ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it -u node $GATEWAY bash"
