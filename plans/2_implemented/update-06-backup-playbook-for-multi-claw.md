# Update Playbook 06 & session-prune.sh for Multi-Claw

## Context

Playbook 06 (`playbooks/06-backup.md`) has 18+ stale `/home/openclaw/.openclaw` references that don't exist in the always-multi-claw architecture. The backup script (`deploy/backup.sh`) was already updated to iterate over instances, but `deploy/session-prune.sh` and the playbook itself still assume a single shared `.openclaw` directory.

**Goal:** Fix `session-prune.sh` to iterate per-instance (matching `backup.sh` pattern), fix all stale paths in the playbook, and update the restore procedure to be instance-aware.

---

## Key Design Decision: Cron Log Location

Backup and session-prune are **host-level scripts** that iterate over ALL instances. Their logs should NOT go into a per-instance `.openclaw/logs/` — they belong in a shared host-level location.

**Choice:** `/home/openclaw/logs/` — a shared directory under the openclaw home, alongside `instances/`, `scripts/`, `openclaw/`. Simple, doesn't require system directory creation.

---

## 1. Fix `deploy/session-prune.sh`

Currently hardcodes `OPENCLAW_DIR="/home/openclaw/.openclaw"`. Needs to iterate over instances like `backup.sh` does.

**Changes:**

- Replace single `OPENCLAW_DIR` with `INSTANCES_DIR="/home/openclaw/instances"` + loop
- Iterate `for inst_dir in "${INSTANCES_DIR}"/*/` like backup.sh
- Accumulate counts across all instances
- Keep the same retention logic per-instance

```bash
#!/bin/bash
# Session & log pruning — deletes old session transcripts and stale log files.
# Runs daily via cron: /etc/cron.d/openclaw-session-prune
#
# Always-multi-claw: iterates all instances under /home/openclaw/instances/
# Must run as root because .openclaw is owned by uid 1000 (container's node user),
# not the host's openclaw user (uid 1002).
set -euo pipefail

INSTANCES_DIR="/home/openclaw/instances"
RETENTION_DAYS="${1:-30}"

session_count=0
stale_count=0

if [ ! -d "$INSTANCES_DIR" ]; then
  echo "$(date): No instances directory found at ${INSTANCES_DIR}"
  exit 1
fi

for inst_dir in "${INSTANCES_DIR}"/*/; do
  [ -d "$inst_dir" ] || continue
  inst_name=$(basename "$inst_dir")
  OPENCLAW_DIR="${inst_dir}.openclaw"

  # Prune old session transcripts
  SESSIONS_DIR="${OPENCLAW_DIR}/agents"
  if [ -d "$SESSIONS_DIR" ]; then
    found=$(find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f 2>/dev/null | wc -l)
    if [ "$found" -gt 0 ]; then
      find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f -delete
      session_count=$((session_count + found))
    fi
  fi

  # Prune stale log files
  LOGS_DIR="${OPENCLAW_DIR}/logs"
  if [ -d "$LOGS_DIR" ]; then
    for pattern in 'debug.log*' 'llm.log*'; do
      found=$(find "$LOGS_DIR" -maxdepth 1 -name "$pattern" -mtime +"$RETENTION_DAYS" -type f 2>/dev/null | wc -l)
      if [ "$found" -gt 0 ]; then
        find "$LOGS_DIR" -maxdepth 1 -name "$pattern" -mtime +"$RETENTION_DAYS" -type f -delete
        stale_count=$((stale_count + found))
      fi
    done
  fi
done

echo "$(date): Pruned ${session_count} session files, ${stale_count} stale log files (retention: ${RETENTION_DAYS} days)"
```

---

## 2. Fix Playbook `06-backup.md`

### §6.2 Cron Job — Fix log paths (lines 47-56)

| Current | Fixed |
|---------|-------|
| `>> /home/openclaw/.openclaw/logs/backup.log 2>&1` | `>> /home/openclaw/logs/backup.log 2>&1` |
| `sudo mkdir -p /home/openclaw/.openclaw/logs` | `sudo mkdir -p /home/openclaw/logs` |
| `sudo chown 1000:1000 /home/openclaw/.openclaw/logs` | `sudo chown openclaw:openclaw /home/openclaw/logs` |

Note: Shared log dir is owned by `openclaw` user (not uid 1000), since the cron scripts run as root and write here directly on the host. The old `.openclaw/logs` was uid 1000 because it was container-side, but `/home/openclaw/logs/` is host-side.

### §6.3 Test Backup — Fix paths (lines 67-71, 87)

Replace single-path commands with per-instance loops:

```bash
# Verify backup was created (per-instance)
for inst_dir in /home/openclaw/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups yet)"
done

# Verify backup contents (latest from first instance)
FIRST_INST=$(ls -d /home/openclaw/instances/*/ | head -1)
sudo tar -tzf "${FIRST_INST}.openclaw/backups"/openclaw_backup_*.tar.gz | head -20
```

Fix the "backup is empty" troubleshooting hint (line 87):

```bash
sudo ls -la /home/openclaw/instances/*/.openclaw/openclaw.json /home/openclaw/openclaw/.env
```

### §6.4 Cron Job — Fix log path (line 111)

| Current | Fixed |
|---------|-------|
| `>> /home/openclaw/.openclaw/logs/session-prune.log 2>&1` | `>> /home/openclaw/logs/session-prune.log 2>&1` |

### Verification section — Fix all paths (lines 137-143)

```bash
# Check backup directories exist (per-instance)
for inst_dir in /home/openclaw/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups yet)"
done

# Check backup log (after first run)
cat /home/openclaw/logs/backup.log

# Check prune log (after first run)
cat /home/openclaw/logs/session-prune.log
```

### What Gets Backed Up table — Clarify per-instance (lines 152-158)

Add "Per-instance" qualifier and fix paths:

| Path | Description |
|------|-------------|
| `instances/<name>/.openclaw/openclaw.json` | OpenClaw configuration (per-claw) |
| `instances/<name>/.openclaw/credentials/` | API keys and tokens (per-claw) |
| `instances/<name>/.openclaw/workspace/` | User workspaces and data (per-claw) |
| `openclaw/.env` | Shared environment variables |
| `instances/<name>/sandboxes-home/` | Persistent sandbox home directories (per-claw) |

### Restore Procedure — Instance-aware rewrite (lines 164-180)

The restore procedure needs to accept an instance name and use per-instance paths:

```bash
# List available backups per instance
for inst_dir in /home/openclaw/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/backups/" 2>/dev/null || echo "  (no backups)"
done

# Stop all claws (or just the one being restored)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose down'

# Restore a specific claw from backup
INSTANCE="main-claw"  # ← change to the claw being restored
BACKUP_FILE="/home/openclaw/instances/${INSTANCE}/.openclaw/backups/openclaw_backup_YYYYMMDD_HHMMSS.tar.gz"
sudo tar -xzf "${BACKUP_FILE}" -C "/home/openclaw/instances/${INSTANCE}"

# Fix permissions for the restored instance
sudo chown -R 1000:1000 "/home/openclaw/instances/${INSTANCE}/.openclaw"

# Restart
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
```

### Troubleshooting — Fix paths (lines 193, 221, 224)

| Current | Fixed |
|---------|-------|
| `sudo ls -la /home/openclaw/.openclaw/` | `sudo ls -la /home/openclaw/instances/*/.openclaw/` |
| `tar -tzf /home/openclaw/.openclaw/backups/openclaw_backup_*.tar.gz` | `sudo tar -tzf /home/openclaw/instances/*/.openclaw/backups/openclaw_backup_*.tar.gz` |
| `cat /home/openclaw/.openclaw/logs/backup.log` | `cat /home/openclaw/logs/backup.log` |

### Off-Site Backup — Fix paths (line 231)

```
rclone sync /home/openclaw/instances/ remote:openclaw-backups
rsync -avz /home/openclaw/instances/ user@backup-server:/path/to/backups/
```

Sync the entire `instances/` directory, which captures all per-claw backups and data.

### Terminology — "gateway" → "claw" (lines 77, 84)

Replace "the gateway has created all directories" → "OpenClaw has created all directories" and "the gateway has been started" → "OpenClaw has been started"

---

## Files to Modify

| File | Action |
|------|--------|
| `deploy/session-prune.sh` | **Rewrite** — iterate per-instance like backup.sh |
| `playbooks/06-backup.md` | **Modify** — fix all 18+ stale path references |

---

## Verification

1. `grep -n '/home/openclaw/\.openclaw' playbooks/06-backup.md` — should return zero matches
2. `deploy/session-prune.sh` uses `INSTANCES_DIR` and loops, not hardcoded `OPENCLAW_DIR`
3. Cron log paths point to `/home/openclaw/logs/`, not `/home/openclaw/.openclaw/logs/`
4. Restore procedure references `instances/<name>/` with explicit `INSTANCE` variable
5. Off-site backup syncs `instances/` not `.openclaw/`
