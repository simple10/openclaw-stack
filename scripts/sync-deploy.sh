#!/usr/bin/env bash
# Syncs .deploy/ artifacts from local machine to VPS via rsync.
# Replaces the old .deploy-staging + manual cp workflow.
#
# Usage:
#   ./scripts/sync-deploy.sh                          # Stack-level files only (safe for updates)
#   ./scripts/sync-deploy.sh --all                    # Stack files + all instance configs
#   ./scripts/sync-deploy.sh --instance <name>        # Stack files + one instance's config
#   ./scripts/sync-deploy.sh --fresh                  # Implies --all, prints post-sync next-steps
#   ./scripts/sync-deploy.sh -n | --dry-run           # Preview without transferring

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

SYNC_INSTANCES=""      # "" = none, "all" = all, or a specific name
FRESH=false
DRY_RUN=false
RSYNC_DRY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)        SYNC_INSTANCES="all"; shift ;;
    --instance)   SYNC_INSTANCES="$2"; shift 2 ;;
    --fresh)      SYNC_INSTANCES="all"; FRESH=true; shift ;;
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
  # Discover instance names from .deploy/instances/
  INSTANCES_DIR="${DEPLOY_DIR}/instances"
  if [ ! -d "$INSTANCES_DIR" ]; then
    echo "Error: No instances found in .deploy/instances/. Run 'npm run pre-deploy'." >&2
    exit 1
  fi

  if [ "$SYNC_INSTANCES" = "all" ]; then
    INSTANCE_LIST=$(ls -1 "$INSTANCES_DIR")
  else
    if [ ! -d "${INSTANCES_DIR}/${SYNC_INSTANCES}" ]; then
      echo "Error: Instance '${SYNC_INSTANCES}' not found in .deploy/instances/." >&2
      exit 1
    fi
    INSTANCE_LIST="$SYNC_INSTANCES"
  fi

  for name in $INSTANCE_LIST; do
    local_file="${INSTANCES_DIR}/${name}/.openclaw/openclaw.json"
    if [ ! -f "$local_file" ]; then
      echo "Warning: No openclaw.json for instance '${name}', skipping." >&2
      continue
    fi

    # Stage config for merge at container startup (preserves runtime changes).
    # --fresh bypasses staging and overwrites directly (clean slate).
    if $FRESH; then
      target_filename="openclaw.json"
    else
      target_filename="openclaw.json.staged"
    fi

    info "Syncing instance config: ${name} (→ ${target_filename})..."
    # Ensure remote directory exists (setup-infra.sh creates these, but be safe)
    ${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/instances/${name}/.openclaw"
    do_rsync \
      "$local_file" \
      "${VPS}:${INSTALL_DIR}/instances/${name}/.openclaw/${target_filename}"
    # Instance .openclaw is owned by uid 1000 (container's node user)
    # Chown both the directory and the target file so setup-infra.sh can create
    # subdirectories as the openclaw user (which runs as uid 1000 in container)
    ${SSH_CMD} "${VPS}" "sudo chown 1000:1000 ${INSTALL_DIR}/instances/${name}/.openclaw ${INSTALL_DIR}/instances/${name}/.openclaw/${target_filename}"
    success "instances/${name}/.openclaw/${target_filename} (owner: 1000:1000)"
  done
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
fi
