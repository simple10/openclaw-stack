#!/usr/bin/env bash
# Restart the OpenClaw gateway container on the VPS.
#
# The gateway reads openclaw.json at startup, so a restart is needed
# after config changes (e.g. adding env vars, changing auth settings).
#
# Usage:
#   scripts/restart-gateway.sh                      # auto-detect instance
#   scripts/restart-gateway.sh --instance test-claw  # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

GATEWAY=$(resolve_gateway "$@") || exit 1

# Check gateway container exists
if ! "${SSH_CMD[@]}" "$VPS" \
  "sudo docker inspect -f '{{.State.Running}}' $GATEWAY 2>/dev/null" | grep -q true; then
  echo "Error: $GATEWAY container is not running on VPS" >&2
  exit 1
fi

printf '\033[33mRestarting %s...\033[0m\n' "$GATEWAY"
TERM=xterm-256color "${SSH_CMD[@]}" "$VPS" \
  "sudo -u openclaw bash -c 'cd ${STACK__STACK__INSTALL_DIR} && docker compose restart $GATEWAY'"

# Wait for gateway to be healthy
printf '\033[33mWaiting for gateway to be healthy...\033[0m\n'
for i in $(seq 1 30); do
  STATUS=$(TERM=xterm-256color "${SSH_CMD[@]}" "$VPS" \
    "sudo docker inspect -f '{{.State.Health.Status}}' $GATEWAY 2>/dev/null" || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    printf '\033[32mGateway is healthy.\033[0m\n'
    exit 0
  fi
  sleep 2
done

echo "Warning: gateway did not become healthy within 60s. Check logs with:"
if [ -n "${ENV__SSH_KEY:-}" ]; then
  echo "  ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} ${ENV__SSH_USER}@${ENV__VPS_IP} 'sudo docker logs --tail 20 $GATEWAY'"
elif [ -n "${ENV__SSH_IDENTITY_AGENT:-}" ]; then
  echo "  ssh -o IdentityAgent=${ENV__SSH_IDENTITY_AGENT} -p ${ENV__SSH_PORT} ${ENV__SSH_USER}@${ENV__VPS_IP} 'sudo docker logs --tail 20 $GATEWAY'"
else
  echo "  ssh -p ${ENV__SSH_PORT} ${ENV__SSH_USER}@${ENV__VPS_IP} 'sudo docker logs --tail 20 $GATEWAY'"
fi
exit 1
