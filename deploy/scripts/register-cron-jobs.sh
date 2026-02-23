#!/bin/bash
set -euo pipefail

# register-cron-jobs.sh — Register OpenClaw internal cron jobs after gateway startup
#
# Runs on the VPS host via the openclaw CLI wrapper (which uses docker exec).
# Registers the "Daily VPS Health Check" cron job defined in deploy/openclaw-crons.jsonc.
#
# Interface:
#   Env vars in: HOSTALERT_TELEGRAM_CHAT_ID (optional), HOSTALERT_DAILY_REPORT_TIME (optional)
#   Exit: 0 success, 1 failure
#
# Prerequisites: Gateway container must be running and healthy.

# Parse schedule from HOSTALERT_DAILY_REPORT_TIME
# Default: "9:30 AM PST" → cron "30 9 * * *" in America/Los_Angeles
CRON_EXPR="${CRON_EXPR:-30 9 * * *}"
CRON_TZ="${CRON_TZ:-America/Los_Angeles}"

# Check if already registered (idempotent)
if openclaw cron list 2>/dev/null | grep -q "Daily VPS Health Check"; then
  echo "Cron job 'Daily VPS Health Check' already registered, skipping."
  exit 0
fi

# Build delivery flags
DELIVERY_FLAGS=""
if [ -n "${HOSTALERT_TELEGRAM_CHAT_ID:-}" ]; then
  DELIVERY_FLAGS="--channel telegram --to ${HOSTALERT_TELEGRAM_CHAT_ID}"
fi

# Register the cron job
# shellcheck disable=SC2086
openclaw cron add \
  --name "Daily VPS Health Check" \
  --cron "${CRON_EXPR}" \
  --tz "${CRON_TZ}" \
  --session isolated \
  --wake next-heartbeat \
  --agent main \
  --announce \
  --best-effort-deliver \
  ${DELIVERY_FLAGS} \
  --message "Read the VPS health report files and analyze them:

1. Read host-status/health.json (resource metrics)
2. Read host-status/maintenance.json (OS maintenance)

Analyze for issues that need human attention:

Health (health.json):
- disk_pct approaching or exceeding disk_threshold
- memory_pct approaching or exceeding memory_threshold
- load_avg significantly above cpu_count
- docker_ok or gateway_ok is false
- crashed is non-empty (containers restarting)
- backup_ok is false or backup_age_hours > 36
- timestamp older than 30 minutes (monitoring may be broken)

Maintenance (maintenance.json):
- security_updates > 0 (pending security patches)
- reboot_required is true
- failed_services is not \"none\"
- uptime_days > 90 (consider scheduled reboot)
- timestamp older than 26 hours (checker may not be running)

If everything looks healthy, respond with exactly: HEARTBEAT_OK

If any issues are found, send a concise alert with:
- What's wrong (use emoji indicators: critical, warning)
- Why it matters (one line per issue)
- Recommended action
Keep it brief - this goes to Telegram."

echo "Registered 'Daily VPS Health Check' cron job."
