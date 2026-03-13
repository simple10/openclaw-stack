#!/usr/bin/env bash
# Pull upstream OpenClaw and rebuild the gateway image on the VPS.
# Brief downtime during container swap (~5-10s) — docker compose up -d
# detects the new image and recreates the container automatically.
#
# Usage:
#   scripts/update-openclaw.sh                      # update all claws
#   scripts/update-openclaw.sh --instance test-claw # update specific instance only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

OPENCLAW_DIR="${STACK__STACK__INSTALL_DIR}/openclaw"
INSTANCE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--instance <name>]"
      echo ""
      echo "Pull upstream OpenClaw, rebuild the image, and recreate containers."
      echo ""
      echo "Options:"
      echo "  --instance <name>  Only recreate a specific claw (image rebuild affects all)"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
INSTANCE_NAME="${GATEWAY#${PROJECT_NAME}-openclaw-}"

printf '\033[32mUpdating OpenClaw on %s...\033[0m\n' "$ENV__VPS_IP"

# Step 1: Pull upstream changes
printf '\033[33m[1/4] Pulling upstream changes...\033[0m\n'
TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo -u openclaw bash -c 'cd $OPENCLAW_DIR && git pull'"

# Step 2: Rebuild gateway image(s) (per-claw version tags from stack.env)
printf '\033[33m[2/4] Building gateway image...\033[0m\n'
TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo -u openclaw ${STACK__STACK__INSTALL_DIR}/host/build-openclaw.sh"

# Step 3: Recreate container(s) with new image (brief downtime)
if [[ ${#INSTANCE_ARGS[@]} -gt 0 ]]; then
  printf '\033[33m[3/4] Recreating %s container...\033[0m\n' "$GATEWAY"
  TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
    "sudo -u openclaw bash -c 'cd ${STACK__STACK__INSTALL_DIR} && docker compose up -d $GATEWAY'"
else
  printf '\033[33m[3/4] Recreating all gateway containers...\033[0m\n'
  TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
    "sudo -u openclaw bash -c 'cd ${STACK__STACK__INSTALL_DIR} && docker compose up -d'"
fi

# Step 4: Wait for healthy + show version
printf '\033[33m[4/4] Waiting for %s to be healthy...\033[0m\n' "$GATEWAY"
TIMEOUT=300
ELAPSED=0
while true; do
  STATUS=$(TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
    "sudo docker inspect -f '{{.State.Health.Status}}' $GATEWAY 2>/dev/null" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    break
  fi
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "WARNING: $GATEWAY not healthy after ${TIMEOUT}s (status: $STATUS)" >&2
    echo "Check logs: ssh into VPS and run: sudo docker logs $GATEWAY" >&2
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  printf '  Waiting... (%ds, status: %s)\n' "$ELAPSED" "$STATUS"
done

# Show version
echo ""
VERSION=$(TERM=xterm-256color ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "openclaw --instance $INSTANCE_NAME --version 2>/dev/null" || echo "(could not read version)")
printf '\033[32mOpenClaw updated successfully. Version: %s\033[0m\n' "$VERSION"
