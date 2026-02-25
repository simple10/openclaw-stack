#!/bin/bash
# Host resource monitoring — sends Telegram alerts on threshold breaches.
# Runs via cron every 15 minutes: /etc/cron.d/openclaw-alerts
#
# Requires: HOSTALERT_TELEGRAM_BOT_TOKEN and HOSTALERT_TELEGRAM_CHAT_ID in ${INSTALL_DIR}/openclaw/.env
# Only alerts on state *change* to avoid spam (tracks state in $INSTALL_DIR/.host-alert-state).
#
# Writes health.json to the agent workspace directory, readable by both
# host scripts (--report mode) and OpenClaw agents (via read tool at host-status/health.json).
#
# Usage:
#   host-alert.sh           Normal mode — alert on state changes only
#   host-alert.sh --report  Daily report — send full status summary (bypasses dedup)
set -euo pipefail

REPORT_MODE=false
if [[ "${1:-}" == "--report" ]]; then
  REPORT_MODE=true
fi

INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"

STATE_FILE="${INSTALL_DIR}/.host-alert-state"
CONFIG_FILE="${INSTALL_DIR}/openclaw/.env"
INSTANCES_DIR="${INSTALL_DIR}/instances"

# Load config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

# Thresholds
DISK_THRESHOLD=85
MEMORY_THRESHOLD=90

# --- Collect metrics (always, regardless of Telegram config) ---
alerts=()

# Disk usage (root partition)
disk_pct=$(df / --output=pcent | tail -1 | tr -dc '0-9')
disk_total_gb=$(df / --output=size | tail -1 | awk '{printf "%.0f", $1/1024/1024}')
if (( disk_pct > DISK_THRESHOLD )); then
  alerts+=("⚠️ Disk usage at ${disk_pct}% of ${disk_total_gb} GB (threshold: ${DISK_THRESHOLD}%)")
fi

# Memory usage
mem_total=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
mem_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
mem_total_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
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

# Gateway container check (any openclaw-* container, excluding utility containers)
gateway_ok=true
if $docker_ok; then
  gateway_containers=$(docker ps --format '{{.Names}}' 2>/dev/null \
    | grep '^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' || true)
  if [[ -z "$gateway_containers" ]]; then
    alerts+=("🔴 No OpenClaw gateway containers running")
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
# Check all instance backup directories
backup_ok=true
backup_age_hours=""
found_any_backup_dir=false
for inst_dir in ${INSTALL_DIR}/instances/*/; do
  [[ -d "$inst_dir" ]] || continue
  backup_dir="${inst_dir}.openclaw/backups"
  [[ -d "$backup_dir" ]] || continue
  found_any_backup_dir=true
  latest_backup=$(find "$backup_dir" -name "openclaw_backup_*.tar.gz" -mmin -2160 | head -1)
  if [[ -z "$latest_backup" ]]; then
    inst_name=$(basename "$inst_dir")
    alerts+=("⚠️ No backup in last 36 hours for ${inst_name}")
    backup_ok=false
  else
    backup_age_seconds=$(( $(date +%s) - $(stat -c %Y "$latest_backup" 2>/dev/null || echo 0) ))
    age_hours=$(( backup_age_seconds / 3600 ))
    # Track the most recent backup age across all instances
    if [[ -z "$backup_age_hours" ]] || (( age_hours < backup_age_hours )); then
      backup_age_hours=$age_hours
    fi
  fi
done
if ! $found_any_backup_dir; then
  alerts+=("⚠️ No backup directories found under ${INSTANCES_DIR}")
  backup_ok=false
fi

# --- Write health snapshot to all instances (always, regardless of Telegram config) ---
health_json="{
  \"timestamp\": \"$(date -Iseconds)\",
  \"disk_pct\": ${disk_pct},
  \"disk_total_gb\": ${disk_total_gb},
  \"disk_threshold\": ${DISK_THRESHOLD},
  \"memory_pct\": ${mem_pct},
  \"memory_total_gb\": ${mem_total_gb},
  \"memory_threshold\": ${MEMORY_THRESHOLD},
  \"load_avg\": \"${load_avg}\",
  \"cpu_count\": ${cpu_count},
  \"docker_ok\": ${docker_ok},
  \"gateway_ok\": ${gateway_ok},
  \"crashed\": \"${crashed}\",
  \"backup_ok\": ${backup_ok},
  \"backup_age_hours\": ${backup_age_hours:-null}
}"

for inst_dir in "${INSTANCES_DIR}"/*/; do
  [ -d "$inst_dir" ] || continue
  status_dir="${inst_dir}.openclaw/workspace/host-status"
  mkdir -p "$status_dir"
  echo "$health_json" > "${status_dir}/health.json"
  chmod 644 "${status_dir}/health.json"
done

# --- Check Telegram config (gates all Telegram-sending logic below) ---
TELEGRAM_CONFIGURED=false
if [[ -n "${HOSTALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${HOSTALERT_TELEGRAM_CHAT_ID:-}" ]]; then
  TELEGRAM_CONFIGURED=true
fi

# --- Report mode: send full status summary and exit ---
if $REPORT_MODE; then
  # Report mode requires Telegram — health.json is already written above
  if ! $TELEGRAM_CONFIGURED; then
    exit 0
  fi

  hostname=$(hostname)
  uptime_str=$(uptime -p 2>/dev/null | sed 's/^up //' || uptime | awk -F'( |,)' '{print $2}')

  # Container count (if docker is up)
  container_total=0
  container_running=0
  if $docker_ok; then
    container_total=$(docker ps -a --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
    container_running=$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  fi

  warn_count=0

  # Header
  report="📊 <b>${hostname}</b> — Daily Status"
  report+=$'\n'

  # Disk
  if (( disk_pct > DISK_THRESHOLD )); then
    report+=$'\n'"⚠️ Disk: ${disk_pct}% of ${disk_total_gb} GB (limit ${DISK_THRESHOLD}%)"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Disk: ${disk_pct}% of ${disk_total_gb} GB (limit ${DISK_THRESHOLD}%)"
  fi

  # Memory
  if (( mem_pct > MEMORY_THRESHOLD )); then
    report+=$'\n'"⚠️ Memory: ${mem_pct}% of ${mem_total_gb} GB (limit ${MEMORY_THRESHOLD}%)"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Memory: ${mem_pct}% of ${mem_total_gb} GB (limit ${MEMORY_THRESHOLD}%)"
  fi

  # Load
  if (( load_int >= cpu_count )); then
    report+=$'\n'"⚠️ Load: ${load_avg} / ${cpu_count} CPUs"
    ((warn_count+=1))
  else
    report+=$'\n'"✅ Load: ${load_avg} / ${cpu_count} CPUs"
  fi

  # Docker
  if $docker_ok; then
    report+=$'\n'"✅ Docker"
  else
    report+=$'\n'"🔴 Docker: not responding"
    ((warn_count+=1))
  fi

  # Gateway
  if $gateway_ok && $docker_ok; then
    report+=$'\n'"✅ Gateway"
  else
    report+=$'\n'"🔴 Gateway: down"
    ((warn_count+=1))
  fi

  # Containers
  if [[ -z "$crashed" ]]; then
    if $docker_ok; then
      report+=$'\n'"✅ Containers: ${container_running}/${container_total} running"
    else
      report+=$'\n'"⚠️ Containers: unknown"
      ((warn_count+=1))
    fi
  else
    report+=$'\n'"⚠️ Containers: ${crashed} restarting"
    ((warn_count+=1))
  fi

  # Backup
  if $backup_ok && [[ -n "$backup_age_hours" ]]; then
    report+=$'\n'"✅ Backup: ${backup_age_hours}h ago"
  elif $backup_ok; then
    report+=$'\n'"⚠️ Backup: none found"
    ((warn_count+=1))
  else
    report+=$'\n'"⚠️ Backup: stale (36h+)"
    ((warn_count+=1))
  fi

  # Maintenance section — read from maintenance.json (first instance found)
  maint_file=""
  for inst_dir in "${INSTANCES_DIR}"/*/; do
    [ -d "$inst_dir" ] || continue
    candidate="${inst_dir}.openclaw/workspace/host-status/maintenance.json"
    if [[ -f "$candidate" ]]; then
      maint_file="$candidate"
      break
    fi
  done
  if [[ -n "$maint_file" && -f "$maint_file" ]]; then
    maint_age_seconds=$(( $(date +%s) - $(stat -c %Y "$maint_file" 2>/dev/null || echo 0) ))
    maint_age_hours=$(( maint_age_seconds / 3600 ))

    if (( maint_age_hours > 26 )); then
      report+=$'\n'
      report+=$'\n'"⚠️ Maintenance: data stale (${maint_age_hours}h old)"
      ((warn_count+=1))
    else
      # Parse maintenance.json fields
      security_updates=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('security_updates', 0))" 2>/dev/null || echo "?")
      total_upgradable=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('total_upgradable', 0))" 2>/dev/null || echo "?")
      reboot_required=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('reboot_required', False))" 2>/dev/null || echo "?")
      failed_services=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('failed_services', 'none'))" 2>/dev/null || echo "?")
      uptime_days=$(python3 -c "import json; d=json.load(open('${maint_file}')); print(d.get('uptime_days', '?'))" 2>/dev/null || echo "?")

      report+=$'\n'
      report+=$'\n'"<b>Maintenance:</b>"

      # Security updates
      if [[ "$security_updates" != "0" && "$security_updates" != "?" ]]; then
        report+=$'\n'"⚠️ Security updates: ${security_updates}"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Security updates: ${security_updates}"
      fi

      # Total upgradable
      report+=$'\n'"📦 Packages upgradable: ${total_upgradable}"

      # Reboot required
      if [[ "$reboot_required" == "True" ]]; then
        report+=$'\n'"⚠️ Reboot required: yes"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Reboot required: no"
      fi

      # Failed services
      if [[ "$failed_services" != "none" && "$failed_services" != "?" ]]; then
        report+=$'\n'"⚠️ Failed services: ${failed_services}"
        ((warn_count+=1))
      else
        report+=$'\n'"✅ Failed services: none"
      fi

      report+=$'\n'"⏳ Uptime: ${uptime_days}d"
    fi
  else
    report+=$'\n'
    report+=$'\n'"ℹ️ Maintenance: no data (checker not yet run)"
  fi

  # Footer
  report+=$'\n'
  report+=$'\n'"⏱ Uptime: ${uptime_str}"
  if (( warn_count > 0 )); then
    report+=$'\n'"⚡ ${warn_count} issue(s) need attention"
  fi

  # Send report with HTML formatting (do NOT update state file — report is independent of alert dedup)
  response=$(curl -s "https://api.telegram.org/bot${HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${HOSTALERT_TELEGRAM_CHAT_ID}" \
    -d "parse_mode=HTML" \
    --data-urlencode "text=${report}")

  if echo "$response" | grep -q '"ok":true'; then
    exit 0
  else
    echo "Telegram send failed: $response" >&2
    exit 1
  fi
fi

# --- Normal alert mode: only alert on state change ---
# Without Telegram, health.json is still written above — exit here
if ! $TELEGRAM_CONFIGURED; then
  exit 0
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
response=$(curl -s "https://api.telegram.org/bot${HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${HOSTALERT_TELEGRAM_CHAT_ID}" \
  -d "text=${hostname}: ${message}" \
  -d "parse_mode=HTML")

if ! echo "$response" | grep -q '"ok":true'; then
  echo "$(date): Telegram alert send failed: $response" >&2
fi

exit 0
