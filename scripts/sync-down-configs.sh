#!/usr/bin/env bash
# sync-down-configs.sh — Download live openclaw.json configs from VPS
#
# If no local openclaw.jsonc exists for a claw, saves directly as openclaw.jsonc
# (establishing it as the local source of truth for that claw).
# If a local openclaw.jsonc already exists, saves as openclaw.live-version.jsonc
# with a diff summary prepended as comments.
#
# Usage:
#   ./scripts/sync-down-configs.sh                    # All instances
#   ./scripts/sync-down-configs.sh --instance <name>  # One instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/instances.sh"

SYNC_INSTANCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) SYNC_INSTANCE="$2"; shift 2 ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

resolve_instance_list "${SYNC_INSTANCE:-all}"

CREATED_FILES=()
DIFFED_FILES=()

for name in $INSTANCE_LIST; do
  remote_file="${INSTALL_DIR}/instances/${name}/.openclaw/openclaw.json"
  local_dir="${REPO_ROOT}/openclaw/${name}"
  local_source="${local_dir}/openclaw.jsonc"
  tmp_file="${local_dir}/.openclaw.live.tmp"

  mkdir -p "$local_dir"

  info "Downloading live config for ${name}..."
  if ! do_rsync "${VPS}:${remote_file}" "$tmp_file" 2>/dev/null; then
    warn "No live config found for ${name} (not yet deployed?)"
    rm -f "$tmp_file"
    continue
  fi

  if [ ! -f "$local_source" ]; then
    # No local config exists — adopt the live config as the source of truth
    mv "$tmp_file" "$local_source"
    success "Created ${local_source} (no local config existed)"
    CREATED_FILES+=("$name")
  else
    # Local config exists — save as live-version with annotated drift comments
    local_live="${local_dir}/openclaw.live-version.jsonc"

    # Find what we're diffing against (claw-specific or default template)
    if [ -f "$local_source" ]; then
      diff_against="$local_source"
    else
      diff_against="${REPO_ROOT}/openclaw/default/openclaw.jsonc"
    fi

    # Format live version with key-order matching and inline drift annotations
    # --claw resolves ${VAR} refs using env vars from .deploy/docker-compose.yml
    FORMAT_SCRIPT="${REPO_ROOT}/deploy/openclaw-stack/format-live-version.mjs"
    node "$FORMAT_SCRIPT" --claw "$name" "$diff_against" "$tmp_file" > "$local_live"

    rm -f "$tmp_file"
    success "${local_live}"
    DIFFED_FILES+=("$name")
  fi
done

# Summary
echo ""
if [ ${#CREATED_FILES[@]} -gt 0 ]; then
  echo "New local configs created (adopted from live):"
  for name in "${CREATED_FILES[@]}"; do
    echo "  openclaw/${name}/openclaw.jsonc"
  done
  echo ""
fi

if [ ${#DIFFED_FILES[@]} -gt 0 ]; then
  echo "Review changes with:"
  for name in "${DIFFED_FILES[@]}"; do
    echo "  diff openclaw/${name}/openclaw.jsonc openclaw/${name}/openclaw.live-version.jsonc"
  done
fi
