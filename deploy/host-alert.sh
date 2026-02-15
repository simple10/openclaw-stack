#!/bin/bash
# Host resource monitoring — sends Telegram alerts on threshold breaches.
# Runs via cron every 15 minutes: /etc/cron.d/openclaw-alerts
#
# Requires: HOSTALERT_HOSTALERT_TELEGRAM_BOT_TOKEN and HOSTALERT_HOSTALERT_TELEGRAM_CHAT_ID in /home/openclaw/openclaw/.env
# Only alerts on state *change* to avoid spam (tracks state in /tmp/host-alert-state).
set -euo pipefail

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
if ! docker info >/dev/null 2>&1; then
  alerts+=("🔴 Docker daemon is not responding")
fi

# Gateway container check
if docker info >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^openclaw-gateway$'; then
    alerts+=("🔴 openclaw-gateway container is NOT running")
  fi
fi

# Container crash detection (containers in Restarting state)
crashed=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | \
  awk '/Restarting/ {print $1}' | tr '\n' ', ' | sed 's/,$//')
if [[ -n "$crashed" ]]; then
  alerts+=("Containers restarting: $crashed")
fi

# Backup freshness (warn if no backup in last 36 hours)
backup_dir="/home/openclaw/.openclaw/backups"
if [[ -d "$backup_dir" ]]; then
  latest_backup=$(find "$backup_dir" -name "openclaw_backup_*.tar.gz" -mmin -2160 | head -1)
  if [[ -z "$latest_backup" ]]; then
    alerts+=("⚠️ No backup in last 36 hours")
  fi
fi

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
