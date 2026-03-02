#!/bin/bash
set -euo pipefail

# start-claws.sh — Build image and start claw containers (playbook 04, §4.4)
#
# Multi-claw: starts only the first claw for sandbox builds.
# Single-claw: starts all services.
# Does NOT wait for sandbox builds — caller handles the wait.
#
# Interface:
#   Env vars in: STACK__STACK__LOGGING__VECTOR (optional, from source-config.sh)
#   Stdout: FIRST_CLAW=<container-name>, CLAW_COUNT=N, then START_CLAWS_OK
#   Stderr: progress
#   Exit: 0 success, 1 failure

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"
OPENCLAW_HOME="$STACK__STACK__INSTALL_DIR"

# Discover configured instances from instances directory
INSTANCES_DIR="${STACK__STACK__INSTANCES_DIR:-${OPENCLAW_HOME}/instances}"
if [ -d "${INSTANCES_DIR}" ]; then
  INSTANCE_NAMES=$(ls -d "${INSTANCES_DIR}"/*/ 2>/dev/null \
    | xargs -I{} basename {} | grep -v '^_' | tr '\n' ' ')
fi
INSTANCE_NAMES="${INSTANCE_NAMES:-personal-claw}"
CLAW_COUNT=$(echo "$INSTANCE_NAMES" | wc -w | tr -d ' ')
FIRST_CLAW=$(echo "$INSTANCE_NAMES" | awk '{print $1}')

echo "Instances: ${INSTANCE_NAMES}(${CLAW_COUNT} claw(s))" >&2

# Build image
echo "Building ${STACK__STACK__IMAGE} image..." >&2
sudo -u openclaw INSTALL_DIR="${STACK__STACK__INSTALL_DIR}" "${OPENCLAW_HOME}/host/build-openclaw.sh" >&2

# Start containers (Vector is included in the main compose when enabled)
COMPOSE_DIR="${OPENCLAW_HOME}"
if [ "$CLAW_COUNT" -gt 1 ] && [ -z "${STACK__STACK__SANDBOX_REGISTRY__PORT:-}" ] && [ -z "${STACK__STACK__SANDBOX_REGISTRY__URL:-}" ]; then
  # No registry: stagger startup so first claw builds sandbox images before others start
  SERVICE="${STACK__STACK__PROJECT_NAME}-openclaw-${FIRST_CLAW}"
  echo "Multi-claw (no registry): starting ${SERVICE} first for sandbox builds..." >&2
  sudo -u openclaw bash -c \
    "cd ${COMPOSE_DIR} && docker compose up -d ${SERVICE}"
else
  # Single-claw, or registry available (all claws pull simultaneously)
  echo "Starting all services..." >&2
  sudo -u openclaw bash -c \
    "cd ${COMPOSE_DIR} && docker compose up -d"
fi

# Output for caller
echo "FIRST_CLAW=${STACK__STACK__PROJECT_NAME}-openclaw-${FIRST_CLAW}"
echo "CLAW_COUNT=${CLAW_COUNT}"
echo "START_CLAWS_OK"
