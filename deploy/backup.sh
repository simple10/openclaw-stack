#!/bin/bash
set -euo pipefail

# backup.sh — OpenClaw backup (always-multi-claw layout)
# Backs up all claw instances under /home/openclaw/instances/

INSTANCES_DIR="/home/openclaw/instances"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Verify instances directory exists
if [ ! -d "$INSTANCES_DIR" ]; then
  echo "$(date): No instances directory found at ${INSTANCES_DIR}"
  exit 1
fi

# Back up each claw instance
for inst_dir in "${INSTANCES_DIR}"/*/; do
  [ -d "$inst_dir" ] || continue
  inst_name=$(basename "$inst_dir")

  BACKUP_DIR="${inst_dir}.openclaw/backups"
  BACKUP_FILE="${BACKUP_DIR}/openclaw_backup_${TIMESTAMP}.tar.gz"

  # Ensure backup directory exists with correct permissions
  mkdir -p "${BACKUP_DIR}"
  chown 1000:1000 "${BACKUP_DIR}"

  # Create backup of this claw's config and data
  tar -czf "${BACKUP_FILE}" \
      -C "${inst_dir}" \
      .openclaw/openclaw.json \
      .openclaw/credentials \
      .openclaw/workspace \
      sandboxes-home \
      2>/dev/null || true

  # Set ownership so container can also access backups if needed
  chown 1000:1000 "${BACKUP_FILE}"

  # Verify
  if tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
      echo "$(date): Backup created for ${inst_name}: ${BACKUP_FILE}"
  else
      echo "$(date): Backup failed for ${inst_name}!"
  fi

  # Cleanup old backups for this instance
  find "${BACKUP_DIR}" -name "openclaw_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
done

# Back up shared .env file
SHARED_BACKUP_DIR="/home/openclaw/instances/.shared-backups"
mkdir -p "${SHARED_BACKUP_DIR}"
if [ -f /home/openclaw/openclaw/.env ]; then
  cp /home/openclaw/openclaw/.env "${SHARED_BACKUP_DIR}/.env.${TIMESTAMP}"
  # Keep only last 10 .env backups
  find "${SHARED_BACKUP_DIR}" -name ".env.*" -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm
  echo "$(date): Shared .env backed up"
fi
