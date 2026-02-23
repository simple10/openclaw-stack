#!/bin/bash
set -euo pipefail

BACKUP_DIR="/home/openclaw/.openclaw/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/openclaw_backup_${TIMESTAMP}.tar.gz"
RETENTION_DAYS=30

# Ensure backup directory exists with correct permissions
mkdir -p "${BACKUP_DIR}"
chown 1000:1000 "${BACKUP_DIR}"

# Create backup
tar -czf "${BACKUP_FILE}" \
    -C /home/openclaw \
    .openclaw/openclaw.json \
    .openclaw/credentials \
    .openclaw/workspace \
    openclaw/.env \
    sandboxes-home \
    2>/dev/null || true

# Set ownership so container can also access backups if needed
chown 1000:1000 "${BACKUP_FILE}"

# Verify
if tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
    echo "$(date): Backup created: ${BACKUP_FILE}"
else
    echo "$(date): Backup failed!"
    exit 1
fi

# Cleanup old backups
find "${BACKUP_DIR}" -name "openclaw_backup_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
