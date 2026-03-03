#!/usr/bin/env bash
# sync-workspaces.sh — Bidirectional sync of agent workspace files between
# local openclaw/<claw>/workspace/<agent>/ and VPS instances/<claw>/workspace[-<agent>]/
#
# Directory mapping:
#   Local: openclaw/<claw>/workspace/main/       → VPS: instances/<claw>/workspace/
#   Local: openclaw/<claw>/workspace/<agent-id>/  → VPS: instances/<claw>/workspace-<agent-id>/
#
# Usage:
#   ./scripts/sync-workspaces.sh up   [--instance <claw>] [--force]          # Local → VPS
#   ./scripts/sync-workspaces.sh down [--instance <claw>] [--all] [--force]  # VPS → Local

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/instances.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

DIRECTION=""
SYNC_INSTANCE=""
FORCE=false
ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    up|down)      DIRECTION="$1"; shift ;;
    --instance)   SYNC_INSTANCE="$2"; shift 2 ;;
    --force)      FORCE=true; shift ;;
    --all)        ALL=true; shift ;;
    *)            echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$DIRECTION" ]; then
  echo "Usage: sync-workspaces.sh <up|down> [--instance <claw>] [--force] [--all]" >&2
  exit 1
fi

# Extra rsync flags for workspace sync (itemize changes, exclude dotfiles)
RSYNC_EXTRA="--itemize-changes --exclude=.*"

resolve_instance_list "${SYNC_INSTANCE:-all}"

# ── Map agent name ↔ VPS directory ───────────────────────────────────────────
# "main" maps to bare workspace/, others to workspace-<agent-id>/

vps_workspace_dir() {
  local claw="$1" agent="$2"
  if [ "$agent" = "main" ]; then
    echo "${INSTALL_DIR}/instances/${claw}/.openclaw/workspace/"
  else
    echo "${INSTALL_DIR}/instances/${claw}/.openclaw/workspace-${agent}/"
  fi
}

# ── Sync log ─────────────────────────────────────────────────────────────────

write_sync_log() {
  local claw="$1" agents="$2" rsync_output="$3"
  local log_dir="${REPO_ROOT}/openclaw/${claw}/workspace"
  mkdir -p "$log_dir"
  local log_file="${log_dir}/.sync-log"

  local mode_label="$DIRECTION"
  $FORCE && mode_label="${mode_label} (force)"
  $ALL && mode_label="${mode_label} (all)"

  {
    echo ""
    echo "# ── Workspace sync: ${mode_label} ───────────────────────────"
    echo "# Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Instance: ${claw}"
    echo "# Agents: ${agents}"
    echo "$rsync_output"
  } >> "$log_file"
}

# ── UP: local → VPS ─────────────────────────────────────────────────────────

do_up() {
  local claw="$1"
  local workspace_root="${REPO_ROOT}/openclaw/${claw}/workspace"

  if [ ! -d "$workspace_root" ]; then
    warn "No workspace directory for '${claw}' (openclaw/${claw}/workspace/)"
    return
  fi

  # Discover agents from local subdirs
  local agents=()
  for agent_dir in "$workspace_root"/*/; do
    [ -d "$agent_dir" ] || continue
    agents+=("$(basename "$agent_dir")")
  done

  if [ ${#agents[@]} -eq 0 ]; then
    warn "No agent directories in openclaw/${claw}/workspace/"
    return
  fi

  info "Uploading workspaces for ${claw}: ${agents[*]}"

  local all_output=""
  for agent in "${agents[@]}"; do
    local local_dir="${workspace_root}/${agent}/"
    local remote_dir
    remote_dir=$(vps_workspace_dir "$claw" "$agent")

    # Ensure remote dir exists with correct ownership
    ${SSH_CMD} "${VPS}" "sudo mkdir -p ${remote_dir} && sudo chown -R 1000:1000 ${remote_dir}"

    local extra_flags=()
    if ! $FORCE; then
      extra_flags+=(--ignore-existing)
    fi

    info "  ${agent}: openclaw/${claw}/workspace/${agent}/ → ${remote_dir}"
    local output
    output=$(do_rsync "${extra_flags[@]}" "$local_dir" "${VPS}:${remote_dir}" 2>&1) || true
    echo "$output" | grep -v '^$' || true
    all_output="${all_output}
--- ${agent} ---
${output}"

    # Fix ownership after upload
    ${SSH_CMD} "${VPS}" "sudo chown -R 1000:1000 ${remote_dir}"
  done

  write_sync_log "$claw" "$(IFS=,; echo "${agents[*]}")" "$all_output"
  success "Upload complete for ${claw}"
}

# ── DOWN: VPS → local ───────────────────────────────────────────────────────

do_down() {
  local claw="$1"

  # Discover agents from VPS workspace dirs
  local raw_dirs
  raw_dirs=$(${SSH_CMD} "${VPS}" "sudo bash -c 'ls -1d ${INSTALL_DIR}/instances/${claw}/.openclaw/workspace* 2>/dev/null'" 2>/dev/null) || true

  if [ -z "$raw_dirs" ]; then
    warn "No workspace directories found on VPS for '${claw}'"
    return
  fi

  local agents=()
  while IFS= read -r dir_path; do
    local dirname
    dirname=$(basename "$dir_path")
    if [ "$dirname" = "workspace" ]; then
      agents+=("main")
    else
      # workspace-<agent-id> → <agent-id>
      agents+=("${dirname#workspace-}")
    fi
  done <<< "$raw_dirs"

  info "Downloading workspaces for ${claw}: ${agents[*]}"

  local all_output=""
  for agent in "${agents[@]}"; do
    local remote_dir
    remote_dir=$(vps_workspace_dir "$claw" "$agent")
    local local_dir="${REPO_ROOT}/openclaw/${claw}/workspace/${agent}/"

    mkdir -p "$local_dir"

    local extra_flags=()

    if $ALL; then
      # All files
      if ! $FORCE; then
        extra_flags+=(--ignore-existing)
      fi
    else
      # Markdown only (default)
      extra_flags+=(--include='*/' --include='*.md' --exclude='*')
      if ! $FORCE; then
        extra_flags+=(--ignore-existing)
      fi
    fi

    info "  ${agent}: ${remote_dir} → openclaw/${claw}/workspace/${agent}/"
    local output
    output=$(do_rsync "${extra_flags[@]}" "${VPS}:${remote_dir}" "$local_dir" 2>&1) || true
    echo "$output" | grep -v '^$' || true
    all_output="${all_output}
--- ${agent} ---
${output}"
  done

  write_sync_log "$claw" "$(IFS=,; echo "${agents[*]}")" "$all_output"
  success "Download complete for ${claw}"
}

# ── Main ─────────────────────────────────────────────────────────────────────

for claw in $INSTANCE_LIST; do
  if [ "$DIRECTION" = "up" ]; then
    do_up "$claw"
  else
    do_down "$claw"
  fi
done

echo ""
success "Workspace sync ($DIRECTION) complete."
