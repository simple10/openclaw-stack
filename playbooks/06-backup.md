# 06 - Backup Setup

Configure automated backups for OpenClaw on VPS-1.

## Overview

This playbook configures:

- Backup script for OpenClaw configuration and data
- Automated daily backups via cron
- Session transcript and stale log file pruning
- 30-day retention policy

## Prerequisites

- [04-vps1-openclaw.md](04-vps1-openclaw.md) completed
- OpenClaw running and configured
- SSH access as `adminclaw` on port `<SSH_PORT>`

## Variables

No external variables required.

---

## 6.1 Create Backup Script

IMPORTANT: Backup script must run as root because `.openclaw` is owned by uid 1000 (container's node user), not the host's `openclaw` user (uid 1002).

```bash
# SOURCE: deploy/backup.sh
sudo tee <INSTALL_DIR>/scripts/backup.sh << 'EOF'
# <<< deploy/backup.sh >>>
EOF

sudo chmod +x <INSTALL_DIR>/scripts/backup.sh
```

---

## 6.2 Schedule Cron Job

```bash
#!/bin/bash
# IMPORTANT: Use /etc/cron.d instead of user crontab because backup runs as root
# This avoids permission issues with uid 1000 owned directories
sudo tee /etc/cron.d/openclaw-backup << 'EOF'
# OpenClaw daily backup - runs as root to access uid 1000 owned directories
0 3 * * * root <INSTALL_DIR>/scripts/backup.sh >> <INSTALL_DIR>/logs/backup.log 2>&1
EOF

sudo chmod 644 /etc/cron.d/openclaw-backup

# Ensure shared log directory exists (host-level, not per-instance)
sudo mkdir -p <INSTALL_DIR>/logs
sudo chown openclaw:openclaw <INSTALL_DIR>/logs
```

---

## 6.3 Test Backup Manually

```bash
# Run backup manually
sudo <INSTALL_DIR>/scripts/backup.sh

# Verify backup was created (per-instance)
for inst_dir in <INSTALL_DIR>/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups yet)"
done

# Verify backup contents (latest from first instance)
FIRST_INST=$(ls -d <INSTALL_DIR>/instances/*/ | head -1)
sudo tar -tzf "${FIRST_INST}.openclaw/backups"/openclaw_backup_*.tar.gz | head -20
```

**If backup script fails with "No such file or directory":**

> "Some backup paths don't exist yet. This is normal on first boot before
> OpenClaw has created all directories. The `2>/dev/null || true` in the
> script allows partial backups. Verify the script completed and check which
> files were included with `tar -tzf`."

**If backup is empty or very small (< 1KB):**

> "The backup archive is too small — it may not contain any files. Check that
> OpenClaw has been started at least once (directories are created on first
> boot). Verify paths exist:"
>
> `sudo ls -la <INSTALL_DIR>/instances/*/.openclaw/openclaw.json <INSTALL_DIR>/openclaw/.env`

---

## 6.4 Session & Log Pruning

Session transcripts (`instances/<name>/.openclaw/agents/<agentId>/sessions/*.jsonl`) accumulate indefinitely. This cron job deletes session files and stale log files older than 30 days.

### Install Prune Script

```bash
# SOURCE: deploy/session-prune.sh
sudo tee <INSTALL_DIR>/scripts/session-prune.sh << 'EOF'
# <<< deploy/session-prune.sh >>>
EOF

sudo chmod +x <INSTALL_DIR>/scripts/session-prune.sh
```

### Schedule Cron Job

```bash
sudo tee /etc/cron.d/openclaw-session-prune << 'EOF'
# OpenClaw session & log pruning — runs as root (uid 1000 owned directories)
30 3 * * * root <INSTALL_DIR>/scripts/session-prune.sh >> <INSTALL_DIR>/logs/session-prune.log 2>&1
EOF

sudo chmod 644 /etc/cron.d/openclaw-session-prune
```

### Test Manually

```bash
sudo <INSTALL_DIR>/scripts/session-prune.sh
# Expected: "<date>: Pruned 0 session files, 0 stale log files (retention: 30 days)"

# Optional: test with a shorter retention to verify it works
# sudo <INSTALL_DIR>/scripts/session-prune.sh 1
```

---

## Verification

```bash
# Check cron jobs are installed
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-session-prune

# Check backup directories exist (per-instance)
for inst_dir in <INSTALL_DIR>/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups yet)"
done

# Check backup log (after first run)
cat <INSTALL_DIR>/logs/backup.log

# Check prune log (after first run)
cat <INSTALL_DIR>/logs/session-prune.log
```

---

## What Gets Backed Up

### VPS-1 (OpenClaw)

| Path | Description |
|------|-------------|
| `instances/<name>/.openclaw/openclaw.json` | OpenClaw configuration (per-claw) |
| `instances/<name>/.openclaw/credentials/` | API keys and tokens (per-claw) |
| `instances/<name>/.openclaw/workspace/` | User workspaces and data (per-claw) |
| `openclaw/.env` | Shared environment variables |

---

## Restore Procedure

```bash
# List available backups per instance
for inst_dir in <INSTALL_DIR>/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups)"
done

# Stop all claws (or just the one being restored)
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose down'

# Restore a specific claw from backup
INSTANCE="main-claw"  # ← change to the claw being restored
BACKUP_FILE="<INSTALL_DIR>/instances/${INSTANCE}/.openclaw/backups/openclaw_backup_YYYYMMDD_HHMMSS.tar.gz"
sudo tar -xzf "${BACKUP_FILE}" -C "<INSTALL_DIR>/instances/${INSTANCE}"

# Fix permissions for the restored instance
sudo chown -R 1000:1000 "<INSTALL_DIR>/instances/${INSTANCE}/.openclaw"

# Restart
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose up -d'
```

---

## Troubleshooting

### Permission Denied

```bash
# Symptom: Backup cron job fails with permission denied
# Cause: .openclaw owned by uid 1000, but openclaw user is uid 1002

# Check ownership (sudo required — .openclaw is owned by uid 1000)
sudo ls -la <INSTALL_DIR>/instances/*/.openclaw/
# Shows: drwx------ 1000 1000 ... (container's node user, NOT host's openclaw)

# Solution: Backup runs as root via /etc/cron.d (not user crontab)
cat /etc/cron.d/openclaw-backup
# Should show: 0 3 * * * root <INSTALL_DIR>/scripts/backup.sh ...
```

### Backup Not Running

```bash
# Check cron service
sudo systemctl status cron

# Check cron logs
sudo grep CRON /var/log/syslog | tail -20

# Test script manually
sudo <INSTALL_DIR>/scripts/backup.sh
```

### Backup File Empty or Corrupted

```bash
# Check disk space
df -h

# Check backup contents (pick an instance)
sudo tar -tzf <INSTALL_DIR>/instances/main-claw/.openclaw/backups/openclaw_backup_*.tar.gz

# Check for errors in log
cat <INSTALL_DIR>/logs/backup.log
```

---

## Off-Site Backup (Optional)

Sync the entire `instances/` directory to capture all per-claw backups and data:

```bash
rclone sync <INSTALL_DIR>/instances/ remote:openclaw-backups
rsync -avz <INSTALL_DIR>/instances/ user@backup-server:/path/to/backups/
```

---

## Security Notes

- Backup script runs as root to access uid 1000 owned directories
- Backup files are owned by uid 1000 (container can access if needed)
- Credentials and API keys are included in backup - store securely
- Consider encrypting backups if storing off-site
