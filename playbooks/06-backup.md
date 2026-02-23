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
sudo tee /home/openclaw/scripts/backup.sh << 'EOF'
# <<< deploy/backup.sh >>>
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

## 6.4 Session & Log Pruning

Session transcripts (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`) accumulate indefinitely. This cron job deletes session files and stale log files older than 30 days.

### Install Prune Script

```bash
# SOURCE: deploy/session-prune.sh
sudo tee /home/openclaw/scripts/session-prune.sh << 'EOF'
# <<< deploy/session-prune.sh >>>
EOF

sudo chmod +x /home/openclaw/scripts/session-prune.sh
```

### Schedule Cron Job

```bash
sudo tee /etc/cron.d/openclaw-session-prune << 'EOF'
# OpenClaw session & log pruning — runs as root (uid 1000 owned directories)
30 3 * * * root /home/openclaw/scripts/session-prune.sh >> /home/openclaw/.openclaw/logs/session-prune.log 2>&1
EOF

sudo chmod 644 /etc/cron.d/openclaw-session-prune
```

### Test Manually

```bash
sudo /home/openclaw/scripts/session-prune.sh
# Expected: "<date>: Pruned 0 session files, 0 stale log files (retention: 30 days)"

# Optional: test with a shorter retention to verify it works
# sudo /home/openclaw/scripts/session-prune.sh 1
```

---

## Verification

```bash
# Check cron jobs are installed
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-session-prune

# Check backup directory exists (sudo required — .openclaw is owned by uid 1000)
sudo ls -la /home/openclaw/.openclaw/backups/

# Check backup log (after first run)
sudo cat /home/openclaw/.openclaw/logs/backup.log

# Check prune log (after first run)
sudo cat /home/openclaw/.openclaw/logs/session-prune.log
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
