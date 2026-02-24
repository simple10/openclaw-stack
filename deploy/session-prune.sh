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

  # ── Prune old session transcripts ────────────────────────────────────
  # Session files: instances/<name>/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
  SESSIONS_DIR="${OPENCLAW_DIR}/agents"
  if [ -d "$SESSIONS_DIR" ]; then
    found=$(find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f 2>/dev/null | wc -l)
    if [ "$found" -gt 0 ]; then
      find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f -delete
      session_count=$((session_count + found))
    fi
  fi

  # ── Prune stale log files from old plugins ───────────────────────────
  # Clean up debug.log and llm.log if they linger after migration to telemetry plugin.
  # Rotated copies (*.log.1, *.log.*.gz) are also cleaned.
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
