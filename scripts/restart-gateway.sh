#!/usr/bin/env bash
# Restart the OpenClaw gateway container on the VPS.
#
# The gateway reads openclaw.json at startup, so a restart is needed
# after config changes (e.g. adding env vars, changing auth settings).
#
# Usage:
#   scripts/restart-gateway.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

GATEWAY="openclaw-gateway"

# Check gateway container exists
if ! ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker inspect -f '{{.State.Running}}' $GATEWAY 2>/dev/null" | grep -q true; then
  echo "Error: $GATEWAY container is not running on VPS" >&2
  exit 1
fi

printf '\033[33mRestarting %s...\033[0m\n' "$GATEWAY"
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart $GATEWAY'"

# Wait for gateway to be healthy
printf '\033[33mWaiting for gateway to be healthy...\033[0m\n'
for i in $(seq 1 30); do
  STATUS=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker inspect -f '{{.State.Health.Status}}' $GATEWAY 2>/dev/null" || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    printf '\033[32mGateway is healthy.\033[0m\n'
    exit 0
  fi
  sleep 2
done

echo "Warning: gateway did not become healthy within 60s. Check logs with:"
echo "  ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} 'sudo docker logs --tail 20 $GATEWAY'"
exit 1
