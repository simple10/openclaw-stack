#!/bin/bash
set -euo pipefail

# start-claws.sh — Build image and start claw containers (playbook 04, §4.4)
#
# Multi-claw: starts only the first claw for sandbox builds.
# Single-claw: starts all services.
# Does NOT wait for sandbox builds — caller handles the wait.
#
# Interface:
#   Env vars in: ENABLE_VECTOR_LOG_SHIPPING (optional)
#   Stdout: FIRST_CLAW=<container-name>, CLAW_COUNT=N, then START_CLAWS_OK
#   Stderr: progress
#   Exit: 0 success, 1 failure

OPENCLAW_HOME="${INSTALL_DIR:-/home/openclaw}"

# Discover configured instances from staging dir
STAGING_DIR="${STAGING_DIR:-${INSTALL_DIR}/.deploy-staging}"
if [ -d "${STAGING_DIR}/openclaws" ]; then
  INSTANCE_NAMES=$(ls -d "${STAGING_DIR}"/openclaws/*/ 2>/dev/null \
    | xargs -I{} basename {} | grep -v '^_' | tr '\n' ' ')
fi
INSTANCE_NAMES="${INSTANCE_NAMES:-main-claw}"
CLAW_COUNT=$(echo "$INSTANCE_NAMES" | wc -w | tr -d ' ')
FIRST_CLAW=$(echo "$INSTANCE_NAMES" | awk '{print $1}')

echo "Instances: ${INSTANCE_NAMES}(${CLAW_COUNT} claw(s))" >&2

# Build image
echo "Building openclaw:local image..." >&2
sudo -u openclaw "${OPENCLAW_HOME}/scripts/build-openclaw.sh" >&2

# Start containers
if [ "$CLAW_COUNT" -gt 1 ]; then
  echo "Multi-claw: starting openclaw-${FIRST_CLAW} first for sandbox builds..." >&2
  sudo -u openclaw bash -c \
    "cd ${OPENCLAW_HOME}/openclaw && docker compose up -d openclaw-${FIRST_CLAW}"
else
  echo "Single-claw: starting all services..." >&2
  sudo -u openclaw bash -c \
    "cd ${OPENCLAW_HOME}/openclaw && docker compose up -d"
fi

# Start Vector if enabled
if [ "${ENABLE_VECTOR_LOG_SHIPPING:-false}" = "true" ]; then
  echo "Starting Vector..." >&2
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/vector && docker compose up -d" >&2
fi

# Output for caller
echo "FIRST_CLAW=openclaw-${FIRST_CLAW}"
echo "CLAW_COUNT=${CLAW_COUNT}"
echo "START_CLAWS_OK"
