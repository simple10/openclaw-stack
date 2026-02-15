#!/bin/bash
# Host resource monitoring — sends Telegram alerts on threshold breaches.
# Runs via cron every 15 minutes: /etc/cron.d/openclaw-alerts
#
# Requires: HOSTALERT_TELEGRAM_BOT_TOKEN and HOSTALERT_TELEGRAM_CHAT_ID in /home/openclaw/openclaw/.env
# Only alerts on state *change* to avoid spam (tracks state in /tmp/host-alert-state).
#
# Usage:
#   host-alert.sh           Normal mode — alert on state changes only
#   host-alert.sh --report  Daily report — send full status summary (bypasses dedup)
set -euo pipefail

REPORT_MODE=false
if [[ "${1:-}" == "--report" ]]; then
  REPORT_MODE=true
fi

STATE_FILE="/tmp/host-alert-state"
CONFIG_FILE="/home/openclaw/openclaw/.env"

# Load config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

if [[ -z "${HOSTALERT_TELEGRAM_BOT_TOKEN:-}" || -z "${HOSTALERT_TELEGRAM_CHAT_ID:-}" ]]; then
  # Silently exit if Telegram not configured — not an error
  exit 0
fi

# Thresholds
DISK_THRESHOLD=85
MEMORY_THRESHOLD=90

# Collect current state
alerts=()

# Disk usage (root partition)
disk_pct=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if (( disk_pct > DISK_THRESHOLD )); then
  alerts+=("⚠️ Disk usage at ${disk_pct}% (threshold: ${DISK_THRESHOLD}%)")
fi

# Memory usage
mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
mem_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
if (( mem_pct > MEMORY_THRESHOLD )); then
  alerts+=("⚠️ Memory usage at ${mem_pct}% (threshold: ${MEMORY_THRESHOLD}%)")
fi

# Load average (5-min) vs CPU count
cpu_count=$(nproc)
load_avg=$(awk '{print $2}' /proc/loadavg)
load_int=${load_avg%%.*}
if (( load_int >= cpu_count )); then
  alerts+=("⚠️ Load average: ${load_avg} (CPUs: ${cpu_count})")
fi

# Docker daemon health
docker_ok=true
if ! docker info >/dev/null 2>&1; then
  alerts+=("🔴 Docker daemon is not responding")
  docker_ok=false
fi

# Gateway container check
gateway_ok=true
if $docker_ok; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^openclaw-gateway$'; then
    alerts+=("🔴 openclaw-gateway container is NOT running")
    gateway_ok=false
  fi
fi

# Container crash detection (containers in Restarting state)
crashed=""
if $docker_ok; then
  crashed=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | \
    awk '/Restarting/ {print $1}' | tr '\n' ', ' | sed 's/,$//')
  if [[ -n "$crashed" ]]; then
    alerts+=("Containers restarting: $crashed")
  fi
fi

# Backup freshness (warn if no backup in last 36 hours)
backup_dir="/home/openclaw/.openclaw/backups"
backup_ok=true
backup_age_hours=""
if [[ -d "$backup_dir" ]]; then
  latest_backup=$(find "$backup_dir" -name "openclaw_backup_*.tar.gz" -mmin -2160 | head -1)
  if [[ -z "$latest_backup" ]]; then
    alerts+=("⚠️ No backup in last 36 hours")
    backup_ok=false
  else
    # Calculate age for report mode
    backup_age_seconds=$(( $(date +%s) - $(stat -c %Y "$latest_backup" 2>/dev/null || echo 0) ))
    backup_age_hours=$(( backup_age_seconds / 3600 ))
  fi
fi

# --- Report mode: send full status summary and exit ---
if $REPORT_MODE; then
  hostname=$(hostname)
  uptime_str=$(uptime -p 2>/dev/null | sed 's/^up //' || uptime | awk -F'( |,)' '{print $2}')

  # Build report lines with status indicators
  report="🖥️ ${hostname}: Daily Status"

  if (( disk_pct > DISK_THRESHOLD )); then
    report+=$'\n'"  Disk: ${disk_pct}% (threshold: ${DISK_THRESHOLD}%) ⚠️"
  else
    report+=$'\n'"  Disk: ${disk_pct}% (threshold: ${DISK_THRESHOLD}%) ✅"
  fi

  if (( mem_pct > MEMORY_THRESHOLD )); then
    report+=$'\n'"  Memory: ${mem_pct}% (threshold: ${MEMORY_THRESHOLD}%) ⚠️"
  else
    report+=$'\n'"  Memory: ${mem_pct}% (threshold: ${MEMORY_THRESHOLD}%) ✅"
  fi

  if (( load_int >= cpu_count )); then
    report+=$'\n'"  Load: ${load_avg} / ${cpu_count} CPUs ⚠️"
  else
    report+=$'\n'"  Load: ${load_avg} / ${cpu_count} CPUs ✅"
  fi

  if $docker_ok; then
    report+=$'\n'"  Docker: ✅"
  else
    report+=$'\n'"  Docker: ⚠️"
  fi

  if $gateway_ok && $docker_ok; then
    report+=$'\n'"  Gateway: ✅"
  else
    report+=$'\n'"  Gateway: ⚠️"
  fi

  if [[ -z "$crashed" ]]; then
    report+=$'\n'"  Containers: all healthy ✅"
  else
    report+=$'\n'"  Containers: restarting: ${crashed} ⚠️"
  fi

  if $backup_ok && [[ -n "$backup_age_hours" ]]; then
    report+=$'\n'"  Backup: ${backup_age_hours}h ago ✅"
  elif $backup_ok; then
    report+=$'\n'"  Backup: no backups found ⚠️"
  else
    report+=$'\n'"  Backup: >36h ago ⚠️"
  fi

  report+=$'\n'"  Uptime: ${uptime_str}"

  # Send report (do NOT update state file — report is independent of alert dedup)
  response=$(curl -s "https://api.telegram.org/bot${HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${HOSTALERT_TELEGRAM_CHAT_ID}" \
    -d "text=${report}")

  if echo "$response" | grep -q '"ok":true'; then
    exit 0
  else
    echo "Telegram send failed: $response" >&2
    exit 1
  fi
fi

# --- Normal alert mode: only alert on state change ---

# Build current state fingerprint
current_state=$(printf '%s\n' "${alerts[@]}" 2>/dev/null | sort | md5sum | cut -d' ' -f1)
previous_state=$(cat "$STATE_FILE" 2>/dev/null || echo "none")

# Only alert on state change
if [[ "$current_state" == "$previous_state" ]]; then
  exit 0
fi

# Save new state
echo "$current_state" > "$STATE_FILE"

# Send alert (or recovery)
if (( ${#alerts[@]} == 0 )); then
  message="VPS Recovery: ✅ All checks passed"
else
  message="VPS Alert:
$(printf '  - %s\n' "${alerts[@]}")"
fi

hostname=$(hostname)
curl -s "https://api.telegram.org/bot${HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${HOSTALERT_TELEGRAM_CHAT_ID}" \
  -d "text=🖥️ ${hostname}: ${message}" \
  -d "parse_mode=HTML" \
  >/dev/null 2>&1

exit 0
