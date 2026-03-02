#!/usr/bin/env bash
# Run health checks on the VPS: Docker containers and OpenClaw gateway
#
# Usage:
#   scripts/health-check.sh                      # run all checks (auto-detect instance)
#   scripts/health-check.sh --quiet               # exit code only (0 = healthy, 1 = unhealthy)
#   scripts/health-check.sh --instance test-claw  # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

QUIET=false
INSTANCE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet|-q) QUIET=true; shift ;;
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--quiet] [--instance <name>]"
      echo ""
      echo "Run health checks on the VPS."
      echo ""
      echo "Checks:"
      echo "  - Docker container status (gateway, vector if enabled)"
      echo "  - Docker container health (healthcheck status)"
      echo "  - OpenClaw gateway health (openclaw health)"
      echo ""
      echo "Options:"
      echo "  --quiet, -q        Suppress output, exit code only (0 = healthy, 1 = unhealthy)"
      echo "  --instance <name>  Target a specific OpenClaw instance"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

export TERM=xterm-256color
SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} ${ENV__SSH_USER}@${ENV__VPS_IP}"
FAILURES=0

log() {
  if [ "$QUIET" = false ]; then
    echo "$@"
  fi
}

pass() {
  log "  $(printf '\033[32m✓\033[0m') $1"
}

fail() {
  log "  $(printf '\033[31m✗\033[0m') $1"
  FAILURES=$((FAILURES + 1))
}

warn() {
  log "  $(printf '\033[33m!\033[0m') $1"
}

# --- SSH connectivity ---
log ""
log "Checking VPS connectivity..."
if ! $SSH_CMD "true" 2>/dev/null; then
  fail "Cannot reach VPS at ${ENV__VPS_IP}:${ENV__SSH_PORT}"
  log ""
  log "$(printf '\033[31m%s check(s) failed.\033[0m')" "$FAILURES"
  exit 1
fi
pass "SSH connection OK"

# --- Docker containers ---
log ""
log "Checking Docker containers..."

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1
CONTAINERS="$GATEWAY"
if [ "${STACK__STACK__LOGGING__VECTOR:-true}" = "true" ]; then
  CONTAINERS="$CONTAINERS vector"
fi
for CONTAINER in $CONTAINERS; do
  STATUS=$($SSH_CMD "sudo docker inspect -f '{{.State.Status}}' $CONTAINER 2>/dev/null" 2>/dev/null || echo "not_found")

  if [ "$STATUS" = "running" ]; then
    pass "$CONTAINER is running"
  elif [ "$STATUS" = "not_found" ]; then
    fail "$CONTAINER container not found"
    continue
  else
    fail "$CONTAINER is $STATUS (expected: running)"
    continue
  fi

  # Check Docker healthcheck status if the container defines one
  HEALTH=$($SSH_CMD "sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $CONTAINER 2>/dev/null" 2>/dev/null || echo "unknown")

  case "$HEALTH" in
    healthy)   pass "$CONTAINER healthcheck: healthy" ;;
    none)      ;; # no healthcheck defined, skip
    starting)  warn "$CONTAINER healthcheck: starting (container may still be booting)" ;;
    unhealthy) fail "$CONTAINER healthcheck: unhealthy" ;;
    *)         warn "$CONTAINER healthcheck: $HEALTH" ;;
  esac
done

# --- Container restarts ---
log ""
log "Checking for recent container restarts..."
for CONTAINER in $CONTAINERS; do
  RESTART_COUNT=$($SSH_CMD "sudo docker inspect -f '{{.RestartCount}}' $CONTAINER 2>/dev/null" 2>/dev/null || echo "unknown")
  if [ "$RESTART_COUNT" = "unknown" ]; then
    continue
  elif [ "$RESTART_COUNT" -gt 0 ] 2>/dev/null; then
    warn "$CONTAINER has restarted $RESTART_COUNT time(s)"
  else
    pass "$CONTAINER has not restarted"
  fi
done

# --- OpenClaw gateway health ---
log ""
log "Checking OpenClaw gateway health..."

# Pass --instance to avoid interactive picker when multiple claws are running
INSTANCE_NAME="${GATEWAY#openclaw-}"
HEALTH_OUTPUT=$($SSH_CMD "openclaw --instance $INSTANCE_NAME health 2>&1" 2>/dev/null) && HEALTH_EXIT=0 || HEALTH_EXIT=$?

if [ "$HEALTH_EXIT" -eq 0 ]; then
  pass "openclaw health: OK"
else
  fail "openclaw health: failed (exit $HEALTH_EXIT)"
fi
if [ "$QUIET" = false ] && [ -n "$HEALTH_OUTPUT" ]; then
  while IFS= read -r line; do
    log "    $line"
  done <<< "$HEALTH_OUTPUT"
fi

# --- Summary ---
log ""
if [ "$FAILURES" -eq 0 ]; then
  log "$(printf '\033[32mAll checks passed.\033[0m')"
else
  log "$(printf '\033[31m%s check(s) failed.\033[0m' "$FAILURES")"
fi

exit "$FAILURES"
