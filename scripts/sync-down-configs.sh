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

SYNC_INSTANCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) SYNC_INSTANCE="$2"; shift 2 ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

INSTALL_DIR="$STACK__STACK__INSTALL_DIR"
SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }

# Discover instances from stack config
CLAWS_IDS="$STACK__CLAWS__IDS"
if [ -n "$SYNC_INSTANCE" ]; then
  INSTANCE_LIST="$SYNC_INSTANCE"
else
  INSTANCE_LIST=$(echo "$CLAWS_IDS" | tr ',' ' ')
fi

CREATED_FILES=()
DIFFED_FILES=()

for name in $INSTANCE_LIST; do
  remote_file="${INSTALL_DIR}/instances/${name}/.openclaw/openclaw.json"
  local_dir="${REPO_ROOT}/openclaw/${name}"
  local_source="${local_dir}/openclaw.jsonc"
  tmp_file="${local_dir}/.openclaw.live.tmp"

  mkdir -p "$local_dir"

  info "Downloading live config for ${name}..."
  if ! eval rsync -avz -e "'${SSH_CMD}'" --rsync-path="'sudo rsync'" \
    "${VPS}:${remote_file}" "$tmp_file" 2>/dev/null; then
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
    # Local config exists — save as live-version with diff summary header
    local_live="${local_dir}/openclaw.live-version.jsonc"

    # Find what we're diffing against (claw-specific or default template)
    if [ -f "$local_source" ]; then
      diff_against="$local_source"
      diff_label="openclaw/${name}/openclaw.jsonc"
    else
      diff_against="${REPO_ROOT}/openclaw/default/openclaw.jsonc"
      diff_label="openclaw/default/openclaw.jsonc"
    fi

    # Generate diff summary
    diff_output=$(diff --unified=0 "$diff_against" "$tmp_file" 2>/dev/null || true)

    # Build header comment with diff summary
    {
      echo "// Live config downloaded from VPS: ${name}"
      echo "// Downloaded: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "// Compared against: ${diff_label}"
      echo "//"
      if [ -z "$diff_output" ]; then
        echo "// No differences found."
      else
        # Count additions and removals (lines starting with + or - after the header)
        additions=$(echo "$diff_output" | grep -c '^+[^+]' || true)
        removals=$(echo "$diff_output" | grep -c '^-[^-]' || true)
        echo "// Differences: +${additions} added, -${removals} removed"
        echo "//"
        # Include the actual diff lines as comments
        echo "$diff_output" | while IFS= read -r line; do
          # Skip diff file headers (--- and +++ lines)
          case "$line" in
            ---*|+++*) continue ;;
          esac
          echo "// $line"
        done
      fi
      echo "//"
      echo ""
      cat "$tmp_file"
    } > "$local_live"

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
