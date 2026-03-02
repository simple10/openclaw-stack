#!/usr/bin/env bash
# Opens an interactive bash shell inside an OpenClaw gateway container on VPS.
#
# Usage:
#   scripts/ssh-openclaw.sh                      # auto-detect instance
#   scripts/ssh-openclaw.sh --instance main-claw # target specific instance

set -euo pipefail

printf '\033[32mSSH into OpenClaw container \033[0m\n'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

GATEWAY=$(resolve_gateway "$@") || exit 1

printf '\033[32mStarting bash session in %s container \033[0m\n' "$GATEWAY"
printf 'OpenClaw CLI:\033[33m openclaw \033[0m \n'
printf 'Example: openclaw security audit --deep \n'
TERM=xterm-256color ssh -t -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo docker exec -it -u node $GATEWAY bash"
