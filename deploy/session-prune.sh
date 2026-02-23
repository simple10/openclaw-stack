#!/bin/bash
# Session & log pruning — deletes old session transcripts and stale log files.
# Runs daily via cron: /etc/cron.d/openclaw-session-prune
#
# Must run as root because .openclaw is owned by uid 1000 (container's node user),
# not the host's openclaw user (uid 1002).
set -euo pipefail

OPENCLAW_DIR="/home/openclaw/.openclaw"
SESSIONS_DIR="${OPENCLAW_DIR}/agents"
LOGS_DIR="${OPENCLAW_DIR}/logs"
RETENTION_DAYS="${1:-30}"

# ── Prune old session transcripts ────────────────────────────────────
# Session files: ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
session_count=0
if [ -d "$SESSIONS_DIR" ]; then
  session_count=$(find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f 2>/dev/null | wc -l)
  if [ "$session_count" -gt 0 ]; then
    find "$SESSIONS_DIR" -name '*.jsonl' -mtime +"$RETENTION_DAYS" -type f -delete
  fi
fi

# ── Prune stale log files from old plugins ───────────────────────────
# Clean up debug.log and llm.log if they linger after migration to telemetry plugin.
# Rotated copies (*.log.1, *.log.*.gz) are also cleaned.
stale_count=0
if [ -d "$LOGS_DIR" ]; then
  for pattern in 'debug.log*' 'llm.log*'; do
    found=$(find "$LOGS_DIR" -maxdepth 1 -name "$pattern" -mtime +"$RETENTION_DAYS" -type f 2>/dev/null | wc -l)
    if [ "$found" -gt 0 ]; then
      find "$LOGS_DIR" -maxdepth 1 -name "$pattern" -mtime +"$RETENTION_DAYS" -type f -delete
      stale_count=$((stale_count + found))
    fi
  done
fi

echo "$(date): Pruned ${session_count} session files, ${stale_count} stale log files (retention: ${RETENTION_DAYS} days)"
