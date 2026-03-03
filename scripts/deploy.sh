#!/usr/bin/env bash
# deploy.sh — Orchestrates a full deployment: build artifacts, sync configs +
# workspaces to VPS, and auto-restart services that need it.
#
# Usage:
#   scripts/deploy.sh                        # Deploy everything (all claws)
#   scripts/deploy.sh --instance <claw>      # Deploy one claw only
#   scripts/deploy.sh --force                # Overwrite VPS configs + workspaces
#   scripts/deploy.sh --no-restart           # Skip auto-restart (print warning instead)
#   scripts/deploy.sh -n | --dry-run         # Preview only (no transfers, no restart)
#   scripts/deploy.sh -y | --yes             # Skip confirmation prompt
#
# Steps:
#   1. npm run pre-deploy       — build deployment artifacts
#   2. sync-deploy.sh           — push stack artifacts + configs to VPS
#   3. sync-workspaces.sh up    — push workspace files (--ignore-existing by default)
#   4. Auto-restart             — recreate services listed in .restart-required
#   5. Clean up + summary
#
# Does NOT handle fresh deploys (use sync-deploy.sh --fresh) or tagging
# (use tag-deploy.sh after verification).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────

INSTANCE=""
FORCE=false
NO_RESTART=false
DRY_RUN=false
YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)    INSTANCE="$2"; shift 2 ;;
    --force)       FORCE=true; shift ;;
    --no-restart)  NO_RESTART=true; shift ;;
    -n|--dry-run)  DRY_RUN=true; shift ;;
    -y|--yes)      YES=true; shift ;;
    --help|-h)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p; }' "$0"
      exit 0
      ;;
    *)             echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }
err()     { echo -e "\033[31m✗ $1\033[0m"; }
header()  { echo -e "\n\033[1;34m── $1 ──\033[0m"; }

# ── Confirmation ──────────────────────────────────────────────────────────────

if ! $DRY_RUN && ! $YES; then
  echo ""
  echo -e "\033[1mDeploy overview:\033[0m"
  if [ -n "$INSTANCE" ]; then
    echo "  Instance:   ${INSTANCE}"
  else
    echo "  Instance:   all claws"
  fi
  echo "  Steps:      pre-deploy → sync configs → sync workspaces → auto-restart"
  $FORCE && echo "  Force:      yes (overwrite VPS configs + workspaces)"
  $NO_RESTART && echo "  Restart:    skip (manual restart required if needed)"
  echo ""
  read -r -p "Continue? [Y/n] " reply
  case "${reply:-Y}" in
    [yY]|[yY][eE][sS]|"") ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ── Step 1: Build deployment artifacts ────────────────────────────────────────

header "Step 1/4: Build deployment artifacts"

if $DRY_RUN; then
  info "Dry run — running pre-deploy:dry"
  npm run --prefix "$REPO_ROOT" pre-deploy:dry
else
  npm run --prefix "$REPO_ROOT" pre-deploy
fi

success "Artifacts built"

# ── Step 2: Sync deploy artifacts to VPS ──────────────────────────────────────

header "Step 2/4: Sync configs to VPS"

SYNC_ARGS=()
if [ -n "$INSTANCE" ]; then
  SYNC_ARGS+=(--instance "$INSTANCE")
else
  SYNC_ARGS+=(--all)
fi
$FORCE && SYNC_ARGS+=(--force)
$DRY_RUN && SYNC_ARGS+=(--dry-run)

sync_exit=0
"$SCRIPT_DIR/sync-deploy.sh" "${SYNC_ARGS[@]}" || sync_exit=$?

if [ "$sync_exit" -ne 0 ]; then
  echo ""
  err "Config sync failed (exit code ${sync_exit})"
  echo ""
  success "[1] pre-deploy — artifacts built in .deploy/"
  err "[2] sync-deploy — config drift detected or sync error (see above)"
  echo "  [3] sync workspaces — skipped"
  echo "  [4] auto-restart — skipped"
  echo ""
  warn "To resolve: review openclaw/<claw>/openclaw.live-version.jsonc"
  warn "  then re-run with --force to overwrite, or merge changes into openclaw.jsonc"
  exit "$sync_exit"
fi

success "Config sync complete"

# ── Step 3: Sync workspaces ──────────────────────────────────────────────────

if ! $DRY_RUN; then
  header "Step 3/4: Sync workspaces"

  WS_ARGS=(up)
  if [ -n "$INSTANCE" ]; then
    WS_ARGS+=(--instance "$INSTANCE")
  fi
  $FORCE && WS_ARGS+=(--force)

  "$SCRIPT_DIR/sync-workspaces.sh" "${WS_ARGS[@]}"

  success "Workspace sync complete"
else
  header "Step 3/4: Sync workspaces"
  info "Dry run — skipping workspace sync"
fi

# ── Step 4: Auto-restart if needed ────────────────────────────────────────────

header "Step 4/4: Service restart"

DEPLOY_DIR="${REPO_ROOT}/.deploy"
RESTART_FILE="${DEPLOY_DIR}/.restart-required"

if $DRY_RUN; then
  info "Dry run — skipping restart check"
elif [ ! -f "$RESTART_FILE" ]; then
  info "No restart required — all config changes are hot-reloadable"
else
  # Source config for SSH and project name
  source "$SCRIPT_DIR/lib/source-config.sh"

  SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
  VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"
  INSTALL_DIR="$STACK__STACK__INSTALL_DIR"
  PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"

  # Parse .restart-required (format: "instance:key1,key2\n...")
  restart_instances=""
  all_restart_keys=""
  services=""
  while IFS=: read -r inst keys; do
    [ -z "$inst" ] && continue

    # If --instance is set, only restart that instance
    if [ -n "$INSTANCE" ] && [ "$inst" != "$INSTANCE" ]; then
      continue
    fi

    restart_instances="${restart_instances:+${restart_instances} }${inst}"
    service="${PROJECT_NAME}-openclaw-${inst}"
    services="${services:+${services} }${service}"

    for k in $(echo "$keys" | tr ',' ' '); do
      case ",$all_restart_keys," in
        *",$k,"*) ;;
        *) all_restart_keys="${all_restart_keys:+${all_restart_keys}, }${k}" ;;
      esac
    done
  done < "$RESTART_FILE"

  if [ -z "$services" ]; then
    info "No restart required for selected instance(s)"
  elif $NO_RESTART; then
    warn "Restart required for: ${restart_instances}"
    warn "  Changed keys: ${all_restart_keys}"
    warn "  Skipped (--no-restart). Run manually:"
    warn "  sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose up -d --force-recreate ${services}'"
  else
    info "Restarting services: ${services}"
    info "  Changed keys: ${all_restart_keys}"

    ${SSH_CMD} "${VPS}" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose up -d --force-recreate ${services}'"

    # Wait for health checks
    info "Waiting for services to become healthy..."
    TIMEOUT=300
    ELAPSED=0
    all_healthy=false

    while ! $all_healthy; do
      all_healthy=true
      for service in $services; do
        STATUS=$(${SSH_CMD} "${VPS}" \
          "sudo docker inspect -f '{{.State.Health.Status}}' ${service} 2>/dev/null" 2>/dev/null || echo "unknown")
        if [ "$STATUS" != "healthy" ]; then
          all_healthy=false
          break
        fi
      done

      if $all_healthy; then
        break
      fi

      if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
        warn "Services not healthy after ${TIMEOUT}s (last status: ${STATUS})"
        warn "Check logs: ssh into VPS and run: sudo docker logs <service>"
        # Don't clean up .restart-required on timeout so user can retry
        exit 1
      fi

      sleep 5
      ELAPSED=$((ELAPSED + 5))
      printf '  Waiting... (%ds)\n' "$ELAPSED"
    done

    success "All services healthy"

    # Clean up .restart-required after successful restart
    rm -f "$RESTART_FILE"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
if $DRY_RUN; then
  echo "Dry run complete — no changes made."
else
  success "Deploy complete"
  echo ""
  info "Next steps:"
  info "  1. Verify: run § 7.1 checks"
  info "  2. Tag:    scripts/tag-deploy.sh \"description of changes\""
fi
