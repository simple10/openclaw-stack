#!/usr/bin/env bash
# Opens an interactive bash shell inside the openclaw-gateway container on VPS-1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

printf '\033[32mStarting bash session in OpenClaw Gateway container \033[0m\n'
printf 'OpenClaw CLI:\033[33m openclaw \033[0m \n'
printf 'Example: openclaw security audit --deep \n'
TERM=xterm-256color ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it -u node openclaw-gateway bash"
