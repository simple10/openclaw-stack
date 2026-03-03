#!/usr/bin/env bash
# Syncs .deploy/ artifacts from local machine to VPS via rsync.
# Replaces the old .deploy-staging + manual cp workflow.
#
# Usage:
#   ./scripts/sync-deploy.sh                          # Stack-level files only (safe for updates)
#   ./scripts/sync-deploy.sh --all                    # Stack files + all instance configs
#   ./scripts/sync-deploy.sh --instance <name>        # Stack files + one instance's config
#   ./scripts/sync-deploy.sh --fresh                  # Implies --all, prints post-sync next-steps
#   ./scripts/sync-deploy.sh --force                  # Skip drift detection, overwrite live configs
#   ./scripts/sync-deploy.sh -n | --dry-run           # Preview without transferring

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

SYNC_INSTANCES=""      # "" = none, "all" = all, or a specific name
FRESH=false
FORCE=false
DRY_RUN=false
RSYNC_DRY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)        SYNC_INSTANCES="all"; shift ;;
    --instance)   SYNC_INSTANCES="$2"; shift 2 ;;
    --fresh)      SYNC_INSTANCES="all"; FRESH=true; shift ;;
    --force)      FORCE=true; shift ;;
    -n|--dry-run) DRY_RUN=true; RSYNC_DRY="--dry-run"; shift ;;
    *)            echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────

DEPLOY_DIR="${REPO_ROOT}/.deploy"
if [ ! -d "$DEPLOY_DIR" ]; then
  echo "Error: .deploy/ not found. Run 'npm run pre-deploy' first." >&2
  exit 1
fi

INSTALL_DIR="$STACK__STACK__INSTALL_DIR"
SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
RSYNC_SSH="-e '${SSH_CMD}'"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"

# Common rsync flags
RSYNC_BASE="rsync -avz ${RSYNC_DRY} --rsync-path='sudo rsync'"

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }
err()     { echo -e "\033[31m✗ $1\033[0m"; }

# Helper: run rsync with our SSH config
do_rsync() {
  eval ${RSYNC_BASE} -e "'${SSH_CMD}'" "$@"
}

# ── Sync stack-level files ────────────────────────────────────────────────────

# Ensure target directories exist on VPS
info "Ensuring target directories on VPS..."
${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/{host,openclaw-stack,setup}"

# .gitignore for deploy tracking repo
GITIGNORE_SRC="${REPO_ROOT}/deploy/vps-gitignore"
if [ -f "$GITIGNORE_SRC" ]; then
  info "Syncing .gitignore..."
  do_rsync "$GITIGNORE_SRC" "${VPS}:${INSTALL_DIR}/.gitignore"
  success ".gitignore"
fi

# Root files (compose, stack.env, stack.json) — no --delete (would nuke siblings)
info "Syncing root files (docker-compose.yml, stack.env, stack.json)..."
do_rsync \
  "${DEPLOY_DIR}/docker-compose.yml" \
  "${DEPLOY_DIR}/stack.env" \
  "${DEPLOY_DIR}/stack.json" \
  "${VPS}:${INSTALL_DIR}/"
success "Root files"

# host/ — deploy-managed, --delete to remove stale scripts
info "Syncing host/..."
do_rsync --delete \
  "${DEPLOY_DIR}/host/" \
  "${VPS}:${INSTALL_DIR}/host/"
success "host/"

# openclaw-stack/ — deploy-managed, --delete to remove stale files
info "Syncing openclaw-stack/..."
do_rsync --delete \
  "${DEPLOY_DIR}/openclaw-stack/" \
  "${VPS}:${INSTALL_DIR}/openclaw-stack/"
success "openclaw-stack/"

# setup/ — deploy-managed, --delete
info "Syncing setup/..."
do_rsync --delete \
  "${DEPLOY_DIR}/setup/" \
  "${VPS}:${INSTALL_DIR}/setup/"
success "setup/"

# egress-proxy/ — deploy-managed, single file
if [ -d "${DEPLOY_DIR}/egress-proxy" ]; then
  info "Syncing egress-proxy/..."
  ${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/egress-proxy"
  do_rsync --delete \
    "${DEPLOY_DIR}/egress-proxy/" \
    "${VPS}:${INSTALL_DIR}/egress-proxy/"
  success "egress-proxy/"
fi

# sandbox-registry/ — htpasswd auth file
if [ -d "${DEPLOY_DIR}/sandbox-registry" ]; then
  info "Syncing sandbox-registry/..."
  ${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/sandbox-registry/data"
  do_rsync --delete --exclude='data/' \
    "${DEPLOY_DIR}/sandbox-registry/" \
    "${VPS}:${INSTALL_DIR}/sandbox-registry/"
  success "sandbox-registry/"
fi

# vector/vector.yaml — single file, protect vector/data/
if [ -f "${DEPLOY_DIR}/vector/vector.yaml" ]; then
  info "Syncing vector/vector.yaml..."
  ${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/vector"
  do_rsync \
    "${DEPLOY_DIR}/vector/vector.yaml" \
    "${VPS}:${INSTALL_DIR}/vector/vector.yaml"
  success "vector/vector.yaml"
fi

# Fix ownership on stack-level files (all owned by openclaw)
info "Fixing ownership on stack-level files..."
${SSH_CMD} "${VPS}" "sudo chown -R openclaw:openclaw \
  ${INSTALL_DIR}/docker-compose.yml \
  ${INSTALL_DIR}/stack.env \
  ${INSTALL_DIR}/stack.json \
  ${INSTALL_DIR}/host \
  ${INSTALL_DIR}/openclaw-stack \
  ${INSTALL_DIR}/setup && \
  [ -f ${INSTALL_DIR}/.gitignore ] && sudo chown openclaw:openclaw ${INSTALL_DIR}/.gitignore || true"

if [ -f "${DEPLOY_DIR}/vector/vector.yaml" ]; then
  ${SSH_CMD} "${VPS}" "sudo chown openclaw:openclaw ${INSTALL_DIR}/vector/vector.yaml"
fi
if [ -d "${DEPLOY_DIR}/egress-proxy" ]; then
  ${SSH_CMD} "${VPS}" "sudo chown -R openclaw:openclaw ${INSTALL_DIR}/egress-proxy"
fi
if [ -d "${DEPLOY_DIR}/sandbox-registry" ]; then
  ${SSH_CMD} "${VPS}" "sudo chown -R openclaw:openclaw ${INSTALL_DIR}/sandbox-registry"
fi
success "Ownership fixed"

# ── Sync per-instance configs ─────────────────────────────────────────────────

if [ -n "$SYNC_INSTANCES" ]; then
  # Discover instances from stack config (not .deploy/instances/)
  CLAWS_IDS="$STACK__CLAWS__IDS"
  if [ "$SYNC_INSTANCES" = "all" ]; then
    INSTANCE_LIST=$(echo "$CLAWS_IDS" | tr ',' ' ')
  else
    if ! echo ",$CLAWS_IDS," | grep -q ",${SYNC_INSTANCES},"; then
      echo "Error: Instance '${SYNC_INSTANCES}' not found in stack config." >&2
      exit 1
    fi
    INSTANCE_LIST="$SYNC_INSTANCES"
  fi

  CONFIG_HASH="${DEPLOY_DIR}/openclaw-stack/config-hash.mjs"
  CONFIG_DIFF="${DEPLOY_DIR}/openclaw-stack/config-diff.mjs"
  EMPTY_VARS_FILE="${DEPLOY_DIR}/openclaw-stack/empty-env-vars"
  DRIFT_DETECTED=false
  RESTART_SUMMARY=""       # "instance:key1,key2\n..." accumulated across loop
  RESTART_REQUIRED_FILE="${DEPLOY_DIR}/.restart-required"
  rm -f "$RESTART_REQUIRED_FILE"

  for name in $INSTANCE_LIST; do
    # Resolve local config: openclaw/<claw>/openclaw.jsonc (source of truth)
    # Always .jsonc locally, uploaded as .json remotely (both support comments).
    local_dir="${REPO_ROOT}/openclaw/${name}"
    local_file="${local_dir}/openclaw.jsonc"

    # Normalize: rename .json → .jsonc if needed
    if [ ! -f "$local_file" ] && [ -f "${local_dir}/openclaw.json" ]; then
      mv "${local_dir}/openclaw.json" "$local_file"
      info "Renamed openclaw/${name}/openclaw.json → openclaw.jsonc"
    fi

    if [ ! -f "$local_file" ]; then
      warn "No openclaw.jsonc for '${name}' — copy openclaw/default/openclaw.jsonc to openclaw/${name}/openclaw.jsonc"
      continue
    fi

    remote_dir="${INSTALL_DIR}/instances/${name}/.openclaw"
    live_version="${REPO_ROOT}/openclaw/${name}/openclaw.live-version.jsonc"

    # Ensure remote directory exists and fix permissions to match setup-infra.sh:
    #   instances/<name>/  → openclaw:openclaw 755 (host scripts can traverse)
    #   .openclaw/         → 1000:1000 700 (container's node user, private data)
    ${SSH_CMD} "${VPS}" "sudo mkdir -p ${remote_dir} && \
      sudo chown openclaw:openclaw ${INSTALL_DIR}/instances/${name} && \
      sudo chown 1000:1000 ${remote_dir} && \
      sudo chmod 700 ${remote_dir}"

    # Download live config for drift detection (normal mode) or diff comparison (fresh/force).
    tmp_dir=$(mktemp -d)
    has_live_config=false

    # Pull live config + stored hash locally. Runs in all modes so we can
    # detect restart-required changes even on --fresh/--force deploys.
    do_rsync \
      --include='openclaw.json' --include='openclaw.json.sha256' --exclude='*' \
      "${VPS}:${remote_dir}/" "$tmp_dir/" 2>/dev/null || true

    if [ -f "$tmp_dir/openclaw.json" ]; then
      has_live_config=true
    fi

    if ! $FRESH && ! $FORCE && $has_live_config && [ -f "$tmp_dir/openclaw.json.sha256" ]; then
      # Drift detection — compare stored hash vs live content hash
      stored_hash=$(cat "$tmp_dir/openclaw.json.sha256")
      live_hash=$(node "$CONFIG_HASH" "$tmp_dir/openclaw.json")

      if [ "$stored_hash" != "$live_hash" ]; then
        rm -rf "$tmp_dir"
        # Drift: download live-version with diff for user review
        rm -f "$live_version"
        "${SCRIPT_DIR}/sync-down-configs.sh" --instance "$name"
        warn "Config drift detected for '${name}'!"
        warn "  Review: openclaw/${name}/openclaw.live-version.jsonc"
        warn "  Re-run with --force to overwrite."
        DRIFT_DETECTED=true
        continue
      fi
    fi

    # No drift — clean up any stale live-version from previous drift
    rm -f "$live_version"

    # Upload config (always as openclaw.json — no staging)
    # Resolve empty env vars so OpenClaw's ${VAR} substitution doesn't throw
    # MissingEnvVarError on hot-reload. Source file stays clean with ${VAR} refs.
    upload_file="$local_file"
    if [ -f "$EMPTY_VARS_FILE" ]; then
      upload_tmp=$(mktemp)
      cp "$local_file" "$upload_tmp"
      while IFS= read -r var; do
        [ -n "$var" ] && sed -i '' "s/\${${var}}//g" "$upload_tmp"
      done < "$EMPTY_VARS_FILE"
      upload_file="$upload_tmp"
    fi

    info "Syncing instance config: ${name}..."
    do_rsync "$upload_file" "${VPS}:${remote_dir}/openclaw.json"
    ${SSH_CMD} "${VPS}" "sudo chown 1000:1000 ${remote_dir}/openclaw.json"

    # Write deploy hash for future drift detection (hash the uploaded version, with empty vars resolved)
    local_hash=$(node "$CONFIG_HASH" "$upload_file")

    # Detect restart-required changes by comparing live config to uploaded config
    if $has_live_config; then
      diff_json=$(node "$CONFIG_DIFF" "$tmp_dir/openclaw.json" "$upload_file" 2>/dev/null) || diff_json=""
      if [ -n "$diff_json" ]; then
        restart_keys=$(echo "$diff_json" | node -e "
          const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
          if (d.restartRequired) process.stdout.write(d.restartKeys.join(','));
        " 2>/dev/null) || restart_keys=""
        if [ -n "$restart_keys" ]; then
          RESTART_SUMMARY="${RESTART_SUMMARY}${name}:${restart_keys}\n"
        fi
        # Log hot-reload changes for visibility
        hot_keys=$(echo "$diff_json" | node -e "
          const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
          if (d.hotReloadKeys.length) process.stdout.write(d.hotReloadKeys.join(','));
        " 2>/dev/null) || hot_keys=""
        if [ -n "$hot_keys" ]; then
          info "  Hot-reloaded: ${hot_keys}"
        fi
      fi
    fi

    [ -n "${upload_tmp:-}" ] && rm -f "$upload_tmp"
    rm -rf "$tmp_dir"
    ${SSH_CMD} "${VPS}" "echo ${local_hash} | sudo tee ${remote_dir}/openclaw.json.sha256 > /dev/null && sudo chown 1000:1000 ${remote_dir}/openclaw.json.sha256"
    success "openclaw/${name}/openclaw.jsonc → instances/${name}/.openclaw/openclaw.json (hash: ${local_hash:0:12}...)"
  done

  if $DRIFT_DETECTED; then
    err "Deploy aborted — config drift detected (see warnings above)."
    exit 1
  fi

  # Write restart-required summary if any instances need it
  if [ -n "$RESTART_SUMMARY" ]; then
    printf "%b" "$RESTART_SUMMARY" > "$RESTART_REQUIRED_FILE"
  fi
fi

# ── Deploy tracking (diff + auto-commit) ─────────────────────────────────────

if ! $DRY_RUN; then
  info "Deploy diff..."
  ${SSH_CMD} "${VPS}" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && \
    if [ -d .git ]; then \
      git add -A && \
      DIFF=\$(git diff --cached --stat) && \
      if [ -n \"\$DIFF\" ]; then echo \"\$DIFF\"; else echo \"(no changes)\"; fi; \
    else \
      echo \"(deploy tracking not initialized — run setup-infra.sh first)\"; \
    fi'"

  # Auto-commit if there are staged changes
  ${SSH_CMD} "${VPS}" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && \
    if [ -d .git ] && ! git diff --cached --quiet 2>/dev/null; then \
      git commit -m \"deploy: sync \$(date -u +%Y-%m-%dT%H:%M:%SZ)\"; \
    fi'"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
if $DRY_RUN; then
  echo "Dry run complete — no files transferred."
else
  success "Sync complete → ${VPS}:${INSTALL_DIR}/"

  if $FRESH; then
    echo ""
    echo "Fresh deployment — next steps:"
    echo "  1. Run setup-infra.sh to create directories and clone the repo:"
    echo "     ssh ... \"env INSTANCE_NAMES='...' bash ${INSTALL_DIR}/setup/setup-infra.sh\""
    echo "  2. Start claws:"
    echo "     ssh ... \"bash ${INSTALL_DIR}/host/start-claws.sh\""
  fi

  # Restart-required summary
  if [ -f "${DEPLOY_DIR}/.restart-required" ]; then
    echo ""
    # Collect instance names and all changed keys
    restart_instances=""
    all_restart_keys=""
    while IFS=: read -r inst keys; do
      restart_instances="${restart_instances:+${restart_instances}, }${inst}"
      for k in $(echo "$keys" | tr ',' ' '); do
        case ",$all_restart_keys," in
          *",$k,"*) ;;  # already listed
          *) all_restart_keys="${all_restart_keys:+${all_restart_keys}, }${k}" ;;
        esac
      done
    done < "${DEPLOY_DIR}/.restart-required"

    warn "Restart required for: ${restart_instances}"
    warn "  Changed keys: ${all_restart_keys}"
    warn "  Run: sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose up -d --force-recreate'"
  fi
fi
