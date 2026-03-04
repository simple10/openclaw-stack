#!/usr/bin/env bash
# Sync a single claw's openclaw.jsonc config to VPS and optionally restart.
#
# Focused alternative to deploy.sh — only pushes the config file, no stack-level
# syncs, no drift detection, no deploy tracking. For quick config iterations.
#
# Usage:
#   scripts/sync-claw-config.sh <claw>              # Sync config, prompt for restart
#   scripts/sync-claw-config.sh <claw> -y           # Auto-restart if needed
#   scripts/sync-claw-config.sh <claw> --restart      # Always restart after sync
#   scripts/sync-claw-config.sh <claw> --no-restart  # Sync only, skip restart
#   scripts/sync-claw-config.sh <claw> -n            # Dry run (preview only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/spinner.sh"
source "$SCRIPT_DIR/lib/ssh.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

CLAW=""
FORCE_RESTART=false
NO_RESTART=false
YES=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart)     FORCE_RESTART=true; shift ;;
    --no-restart)  NO_RESTART=true; shift ;;
    -y|--yes)      YES=true; shift ;;
    -n|--dry-run)  DRY_RUN=true; RSYNC_EXTRA="--dry-run"; shift ;;
    --help|-h)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p; }' "$0"
      exit 0
      ;;
    -*)            echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [ -z "$CLAW" ]; then
        CLAW="$1"; shift
      else
        echo "Error: unexpected argument '$1'" >&2; exit 1
      fi
      ;;
  esac
done

# ── Validate claw ─────────────────────────────────────────────────────────────

if [ -z "$CLAW" ]; then
  err "Usage: scripts/sync-claw-config.sh <claw> [-y | --no-restart | -n]"
  exit 1
fi

# Validate claw name against stack config
IFS=',' read -ra VALID_CLAWS <<< "$STACK__CLAWS__IDS"
claw_valid=false
for id in "${VALID_CLAWS[@]}"; do
  if [ "$id" = "$CLAW" ]; then
    claw_valid=true
    break
  fi
done
if ! $claw_valid; then
  err "Unknown claw '${CLAW}'. Available: ${STACK__CLAWS__IDS}"
  exit 1
fi

# ── Locate local config ──────────────────────────────────────────────────────

local_dir="${REPO_ROOT}/openclaw/${CLAW}"
local_file="${local_dir}/openclaw.jsonc"

# Auto-migrate: rename .json → .jsonc if needed
if [ ! -f "$local_file" ] && [ -f "${local_dir}/openclaw.json" ]; then
  mv "${local_dir}/openclaw.json" "$local_file"
  info "Renamed openclaw/${CLAW}/openclaw.json → openclaw.jsonc"
fi

if [ ! -f "$local_file" ]; then
  err "No openclaw.jsonc for '${CLAW}'"
  err "  Copy openclaw/default/openclaw.jsonc to openclaw/${CLAW}/openclaw.jsonc"
  exit 1
fi

# ── Step 1: Pre-deploy (resolve config vars) ─────────────────────────────────

header "Sync config: ${CLAW}"

info "Building deployment artifacts..."
if $DRY_RUN; then
  npm run --prefix "$REPO_ROOT" pre-deploy:dry --silent 2>&1 | tail -1 || true
else
  npm run --prefix "$REPO_ROOT" pre-deploy --silent 2>&1 | tail -1 || true
fi

DEPLOY_DIR="${REPO_ROOT}/.deploy"
RESOLVE_SCRIPT="${DEPLOY_DIR}/openclaw-stack/resolve-config-vars.mjs"
CONFIG_DIFF="${DEPLOY_DIR}/openclaw-stack/config-diff.mjs"
TMP_DIR="${DEPLOY_DIR}/.tmp/${CLAW}"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# Build resolved upload file
upload_file="${TMP_DIR}/upload.json"
node "$RESOLVE_SCRIPT" "$local_file" "$CLAW" > "$upload_file"
success "Config resolved"

# ── Step 2: Rsync config to VPS ──────────────────────────────────────────────

remote_dir="${INSTALL_DIR}/instances/${CLAW}/.openclaw"

# Ensure remote directory exists with correct permissions
${SSH_CMD} "${VPS}" "sudo mkdir -p ${remote_dir} && \
  sudo chown openclaw:openclaw ${INSTALL_DIR}/instances/${CLAW} && \
  sudo chown 1000:1000 ${remote_dir} && \
  sudo chmod 700 ${remote_dir}"

# Download live config for restart-required analysis
has_live_config=false
do_rsync \
  --include='openclaw.json' --exclude='*' \
  "${VPS}:${remote_dir}/" "$TMP_DIR/" 2>/dev/null || true

if [ -f "$TMP_DIR/openclaw.json" ]; then
  mv "$TMP_DIR/openclaw.json" "$TMP_DIR/live.json"
  has_live_config=true
fi

# Upload
info "Syncing config to VPS..."
do_rsync "$upload_file" "${VPS}:${remote_dir}/openclaw.json"
if ! $DRY_RUN; then
  ${SSH_CMD} "${VPS}" "sudo chown 1000:1000 ${remote_dir}/openclaw.json"
fi
success "openclaw/${CLAW}/openclaw.jsonc → instances/${CLAW}/.openclaw/openclaw.json"

if $DRY_RUN; then
  echo ""
  info "Dry run complete — no changes made."
  exit 0
fi

# ── Step 3: Restart check ────────────────────────────────────────────────────

restart_keys=""
hot_keys=""

if $has_live_config; then
  diff_json=$(node "$CONFIG_DIFF" "$TMP_DIR/live.json" "$upload_file" 2>/dev/null) || diff_json=""
  if [ -n "$diff_json" ]; then
    restart_keys=$(echo "$diff_json" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
      if (d.restartRequired) process.stdout.write(d.restartKeys.join(','));
    " 2>/dev/null) || restart_keys=""

    hot_keys=$(echo "$diff_json" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
      if (d.hotReloadKeys.length) process.stdout.write(d.hotReloadKeys.join(','));
    " 2>/dev/null) || hot_keys=""
  fi
fi

if [ -n "$hot_keys" ]; then
  info "Hot-reloaded: ${hot_keys}"
fi

PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
SERVICE="${PROJECT_NAME}-openclaw-${CLAW}"

if [ -z "$restart_keys" ] && ! $FORCE_RESTART; then
  if ! $has_live_config; then
    success "Config synced (first deploy — restart when ready)"
  else
    success "Done — no restart required"
  fi
  exit 0
fi

if $NO_RESTART; then
  warn "Restart required for changed keys: ${restart_keys}"
  warn "Skipped (--no-restart). Restart manually:"
  warn "  scripts/restart-gateway.sh --instance ${CLAW}"
  exit 0
fi

restart_reason=""
if [ -n "$restart_keys" ]; then
  restart_reason="changed keys: ${restart_keys}"
elif $FORCE_RESTART; then
  restart_reason="--restart"
fi

if $YES || $FORCE_RESTART; then
  info "Restarting ${SERVICE} (${restart_reason})..."
else
  echo ""
  warn "Restart required — ${restart_reason}"
  read -r -p "Restart ${SERVICE}? [Y/n] " reply </dev/tty
  case "${reply:-Y}" in
    [yY]|[yY][eE][sS]|"") ;;
    *)
      warn "Skipped. Restart manually: scripts/restart-gateway.sh --instance ${CLAW}"
      exit 0
      ;;
  esac
  info "Restarting ${SERVICE}..."
fi

${SSH_CMD} "${VPS}" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose up -d --force-recreate ${SERVICE}'"

# Stream container logs while waiting for the heartbeat line that signals
# successful startup. A spinner runs until the first log line appears
# (SSH + container startup lag).
DIM=$'\033[2m'
RST=$'\033[0m'
GOT_LOGS="${TMP_DIR}/.got-logs"
READY_SIGNAL="${TMP_DIR}/.ready"
rm -f "$GOT_LOGS" "$READY_SIGNAL"

spinner_start "Connecting to container logs..."

# Tail logs in background — new container has no history, so -f gets everything.
# On first line: kill spinner, print header, then continue streaming.
# On heartbeat line: touch ready signal so the wait loop exits immediately.
${SSH_CMD} "${VPS}" "sudo docker logs -f ${SERVICE}" 2>&1 | \
  while IFS= read -r line; do
    if [ ! -f "$GOT_LOGS" ]; then
      touch "$GOT_LOGS"
      spinner_stop
      info "Streaming startup logs (waiting for heartbeat)..."
      echo ""
    fi
    printf '  %s│%s %s\n' "$DIM" "$RST" "$line"
    # gateway/heartbeat "started" = container is fully initialized
    if [[ "$line" == *gateway/heartbeat*heartbeat:\ started* ]]; then
      touch "$READY_SIGNAL"
    fi
  done &
LOG_PID=$!

cleanup_logs() { spinner_stop; kill $LOG_PID 2>/dev/null; wait $LOG_PID 2>/dev/null || true; }
trap cleanup_logs EXIT

# Wait for the heartbeat signal from the log stream, polling every 0.5s.
# Also detect if the log stream dies before we see the signal (e.g. container crash).
TIMEOUT=120
ELAPSED=0

while true; do
  sleep 0.5

  if [ -f "$READY_SIGNAL" ]; then
    cleanup_logs
    trap - EXIT
    echo ""
    success "Gateway restarted successfully (${CLAW})"
    break
  fi

  # Check if log stream process is still alive
  if ! kill -0 $LOG_PID 2>/dev/null; then
    # Log stream exited — check if it signaled ready before dying
    if [ -f "$READY_SIGNAL" ]; then
      trap - EXIT
      echo ""
      success "Gateway restarted successfully (${CLAW})"
      break
    fi
    spinner_stop
    trap - EXIT
    echo ""
    warn "Log stream ended without heartbeat — container may have crashed"
    warn "Check logs: sudo docker logs --tail 30 ${SERVICE}"
    exit 1
  fi

  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$((TIMEOUT * 2))" ]; then
    cleanup_logs
    trap - EXIT
    echo ""
    warn "Service not ready after ${TIMEOUT}s — no heartbeat seen in logs"
    warn "Check logs: sudo docker logs --tail 30 ${SERVICE}"
    exit 1
  fi
done
