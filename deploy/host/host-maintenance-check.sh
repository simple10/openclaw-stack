#!/bin/bash
# Host maintenance checker — detects pending OS updates, required reboots, and failed services.
# Runs daily via cron: /etc/cron.d/openclaw-maintenance
#
# Writes maintenance.json to the agent workspace directory, readable by both
# host scripts (host-alert.sh --report) and OpenClaw agents (via read tool at host-status/maintenance.json).
#
# Runs as root (needs apt and systemctl access). No Telegram dependency.
set -euo pipefail

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"
# Cross-stack discovery from /etc/openclaw-stacks/ manifests
source "$(cd "$(dirname "$0")" && pwd)/source-stacks.sh"

# --- Security updates ---
# Simulate upgrade and count packages from security sources
security_updates=0
if command -v apt-get >/dev/null 2>&1; then
  security_updates=$(apt-get -s upgrade 2>/dev/null | grep -ci "^inst.*security" || true)
fi

# --- Total upgradable packages ---
total_upgradable=0
if command -v apt >/dev/null 2>&1; then
  # apt list --upgradable outputs one header line ("Listing...") plus one line per package
  total_upgradable=$(apt list --upgradable 2>/dev/null | grep -c "upgradable" || true)
fi

# --- Reboot required ---
reboot_required=false
if [[ -f /var/run/reboot-required ]]; then
  reboot_required=true
fi

# --- Failed systemd services ---
failed_services="none"
failed_list=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ', ' | sed 's/,$//')
if [[ -n "$failed_list" ]]; then
  failed_services="$failed_list"
fi

# --- System uptime ---
uptime_seconds=$(awk '{print int($1)}' /proc/uptime)
uptime_days=$(( uptime_seconds / 86400 ))
uptime_hours=$(( (uptime_seconds % 86400) / 3600 ))

# --- Write maintenance.json to all instances ---
maintenance_json="{
  \"timestamp\": \"$(date -Iseconds)\",
  \"security_updates\": ${security_updates},
  \"total_upgradable\": ${total_upgradable},
  \"reboot_required\": ${reboot_required},
  \"failed_services\": \"${failed_services}\",
  \"uptime_seconds\": ${uptime_seconds},
  \"uptime_days\": ${uptime_days},
  \"uptime_hours\": ${uptime_hours}
}"

# Write maintenance.json to all instances across all stacks
while IFS= read -r install_dir; do
  [ -n "$install_dir" ] || continue
  for inst_dir in "${install_dir}/instances"/*/; do
    [ -d "$inst_dir" ] || continue
    status_dir="${inst_dir}.openclaw/workspace/host-status"
    mkdir -p "$status_dir"
    echo "$maintenance_json" > "${status_dir}/maintenance.json"
    chmod 644 "${status_dir}/maintenance.json"
  done
done < <(all_install_dirs)
