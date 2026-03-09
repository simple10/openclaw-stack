#!/bin/bash
set -euo pipefail

# backup.sh — OpenClaw backup (always-multi-claw layout)
# Backs up all claw instances across all registered stacks.

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"
# Cross-stack discovery from /etc/openclaw-stacks/ manifests
source "$(cd "$(dirname "$0")" && pwd)/source-stacks.sh"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Back up all claw instances across all stacks
found_any=false
while IFS= read -r install_dir; do
  [ -n "$install_dir" ] || continue
  instances_dir="${install_dir}/instances"
  [ -d "$instances_dir" ] || continue

  for inst_dir in "${instances_dir}"/*/; do
    [ -d "$inst_dir" ] || continue
    found_any=true
    inst_name=$(basename "$inst_dir")

    BACKUP_DIR="${inst_dir}.openclaw/backups"
    BACKUP_FILE="${BACKUP_DIR}/openclaw_backup_${TIMESTAMP}.tar.gz"

    # Ensure backup directory exists with correct permissions
    mkdir -p "${BACKUP_DIR}"
    chown 1000:1000 "${BACKUP_DIR}"

    # Create backup of this claw's config and data.
    # Include all workspace dirs (main=workspace, agents=workspace-<id>).
    # Include matrix/ when present — contains sync state and E2EE crypto keys.
    # || true: continue to other instances if one fails (error still printed)
    workspace_dirs=$(cd "${inst_dir}" && ls -d .openclaw/workspace .openclaw/workspace-* 2>/dev/null || true)
    matrix_dir=$(cd "${inst_dir}" && ls -d .openclaw/matrix 2>/dev/null || true)
    tar -czf "${BACKUP_FILE}" \
        -C "${inst_dir}" \
        .openclaw/openclaw.json \
        .openclaw/credentials \
        ${workspace_dirs} \
        ${matrix_dir} \
        || true

    # Set ownership so container can also access backups if needed
    if [ -f "${BACKUP_FILE}" ]; then
      chown 1000:1000 "${BACKUP_FILE}"
    fi

    # Verify archive integrity
    if [ -f "${BACKUP_FILE}" ] && tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
        echo "$(date): Backup created for ${inst_name}: ${BACKUP_FILE}"
    else
        echo "$(date): Backup FAILED for ${inst_name} — check disk space and permissions" >&2
    fi

    # Cleanup old backups for this instance
    find "${BACKUP_DIR}" -name "openclaw_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
  done

  # Back up shared deployment config (docker-compose.yml) per stack
  SHARED_BACKUP_DIR="${instances_dir}/.shared-backups"
  mkdir -p "${SHARED_BACKUP_DIR}"
  if [ -f "${install_dir}/docker-compose.yml" ]; then
    cp "${install_dir}/docker-compose.yml" "${SHARED_BACKUP_DIR}/docker-compose.yml.${TIMESTAMP}"
    # Keep only last 10 backups
    find "${SHARED_BACKUP_DIR}" -name "docker-compose.yml.*" -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm
    echo "$(date): docker-compose.yml backed up for $(basename "$install_dir")"
  fi
done < <(all_install_dirs)

if ! $found_any; then
  echo "$(date): No instances found across registered stacks"
  exit 1
fi
