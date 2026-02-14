# 06 - Backup Setup

Configure automated backups for OpenClaw on VPS-1.

## Overview

This playbook configures:

- Backup script for OpenClaw configuration and data
- Automated daily backups via cron
- 30-day retention policy

## Prerequisites

- [04-vps1-openclaw.md](04-vps1-openclaw.md) completed
- OpenClaw running and configured
- SSH access as `adminclaw` on port 222

## Variables

No external variables required.

---

## 6.1 Create Backup Script

```bash
#!/bin/bash
# IMPORTANT: Backup script must run as root because:
# - .openclaw directory is owned by uid 1000 (container's node user)
# - openclaw user on host is uid 1002 (different from container user)
# - Only root can reliably read/write to uid 1000 owned directories
sudo tee /home/openclaw/scripts/backup.sh << 'EOF'
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
EOF

sudo chmod +x /home/openclaw/scripts/backup.sh
```

---

## 6.2 Schedule Cron Job

```bash
#!/bin/bash
# IMPORTANT: Use /etc/cron.d instead of user crontab because backup runs as root
# This avoids permission issues with uid 1000 owned directories
sudo tee /etc/cron.d/openclaw-backup << 'EOF'
# OpenClaw daily backup - runs as root to access uid 1000 owned directories
0 3 * * * root /home/openclaw/scripts/backup.sh >> /home/openclaw/.openclaw/logs/backup.log 2>&1
EOF

sudo chmod 644 /etc/cron.d/openclaw-backup

# Ensure log directory exists
sudo mkdir -p /home/openclaw/.openclaw/logs
sudo chown 1000:1000 /home/openclaw/.openclaw/logs
```

---

## 6.3 Test Backup Manually

```bash
# Run backup manually
sudo /home/openclaw/scripts/backup.sh

# Verify backup was created
sudo ls -la /home/openclaw/.openclaw/backups/

# Verify backup contents
sudo tar -tzf /home/openclaw/.openclaw/backups/openclaw_backup_*.tar.gz
```

**If backup script fails with "No such file or directory":**

> "Some backup paths don't exist yet. This is normal on first boot before
> the gateway has created all directories. The `2>/dev/null || true` in the
> script allows partial backups. Verify the script completed and check which
> files were included with `tar -tzf`."

**If backup is empty or very small (< 1KB):**

> "The backup archive is too small — it may not contain any files. Check that
> the gateway has been started at least once (directories are created on first
> boot). Verify paths exist:"
>
> `sudo ls -la /home/openclaw/.openclaw/openclaw.json /home/openclaw/openclaw/.env`

---

## Verification

```bash
# Check cron job is installed
cat /etc/cron.d/openclaw-backup

# Check backup directory exists (sudo required — .openclaw is owned by uid 1000)
sudo ls -la /home/openclaw/.openclaw/backups/

# Check backup log (after first run)
sudo cat /home/openclaw/.openclaw/logs/backup.log
```

---

## What Gets Backed Up

### VPS-1 (OpenClaw)

| Path | Description |
|------|-------------|
| `.openclaw/openclaw.json` | OpenClaw configuration |
| `.openclaw/credentials/` | API keys and tokens |
| `.openclaw/workspace/` | User workspaces and data |
| `openclaw/.env` | Environment variables |
| `sandboxes-home/` | Persistent sandbox home directories (credentials, dotfiles, SSH keys) |

---

## Restore Procedure

```bash
# List available backups (sudo required — .openclaw is owned by uid 1000)
sudo ls -la /home/openclaw/.openclaw/backups/

# Stop OpenClaw
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose down'

# Restore from backup
BACKUP_FILE="/home/openclaw/.openclaw/backups/openclaw_backup_YYYYMMDD_HHMMSS.tar.gz"
sudo tar -xzf "${BACKUP_FILE}" -C /home/openclaw

# Fix permissions
sudo chown -R 1000:1000 /home/openclaw/.openclaw

# Restart OpenClaw
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
```

---

## Troubleshooting

### Permission Denied

```bash
# Symptom: Backup cron job fails with permission denied
# Cause: .openclaw owned by uid 1000, but openclaw user is uid 1002

# Check ownership (sudo required — .openclaw is owned by uid 1000)
sudo ls -la /home/openclaw/.openclaw/
# Shows: drwx------ 1000 1000 ... (container's node user, NOT host's openclaw)

# Solution: Backup runs as root via /etc/cron.d (not user crontab)
cat /etc/cron.d/openclaw-backup
# Should show: 0 3 * * * root /home/openclaw/scripts/backup.sh ...
```

### Backup Not Running

```bash
# Check cron service
sudo systemctl status cron

# Check cron logs
sudo grep CRON /var/log/syslog | tail -20

# Test script manually
sudo /home/openclaw/scripts/backup.sh
```

### Backup File Empty or Corrupted

```bash
# Check disk space
df -h

# Check backup contents
tar -tzf /home/openclaw/.openclaw/backups/openclaw_backup_*.tar.gz

# Check for errors in log
cat /home/openclaw/.openclaw/logs/backup.log
```

---

## Off-Site Backup (Optional)

Sync backups to external storage via `rclone sync /home/openclaw/.openclaw/backups remote:openclaw-backups` or `rsync -avz /home/openclaw/.openclaw/ user@backup-server:/path/to/backups/`.

---

## Security Notes

- Backup script runs as root to access uid 1000 owned directories
- Backup files are owned by uid 1000 (container can access if needed)
- Credentials and API keys are included in backup - store securely
- Consider encrypting backups if storing off-site
