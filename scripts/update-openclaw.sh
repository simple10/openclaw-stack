#!/usr/bin/env bash
# Pull upstream OpenClaw and rebuild the gateway image on the VPS.
# Brief downtime during container swap (~5-10s) — docker compose up -d
# detects the new image and recreates the container automatically.
#
# Usage:
#   scripts/update-openclaw.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

OPENCLAW_DIR="/home/openclaw/openclaw"
GATEWAY="openclaw-gateway"

printf '\033[32mUpdating OpenClaw on %s...\033[0m\n' "$VPS1_IP"

# Step 1: Pull upstream changes
printf '\033[33m[1/4] Pulling upstream changes...\033[0m\n'
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo -u openclaw bash -c 'cd $OPENCLAW_DIR && git pull'"

# Step 2: Rebuild gateway image
printf '\033[33m[2/4] Building gateway image...\033[0m\n'
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo -u openclaw $OPENCLAW_DIR/scripts/build-openclaw.sh"

# Step 3: Recreate container with new image (brief downtime)
printf '\033[33m[3/4] Recreating gateway container...\033[0m\n'
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo -u openclaw bash -c 'cd $OPENCLAW_DIR && docker compose up -d'"

# Step 4: Wait for healthy + show version
printf '\033[33m[4/4] Waiting for gateway to be healthy...\033[0m\n'
TIMEOUT=300
ELAPSED=0
while true; do
  STATUS=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker inspect -f '{{.State.Health.Status}}' $GATEWAY 2>/dev/null" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    break
  fi
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "WARNING: Gateway not healthy after ${TIMEOUT}s (status: $STATUS)" >&2
    echo "Check logs: ssh into VPS and run: sudo docker logs $GATEWAY" >&2
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  printf '  Waiting... (%ds, status: %s)\n' "$ELAPSED" "$STATUS"
done

# Show version
echo ""
VERSION=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "openclaw --version 2>/dev/null" || echo "(could not read version)")
printf '\033[32mOpenClaw updated successfully. Version: %s\033[0m\n' "$VERSION"
