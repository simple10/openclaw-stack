#!/bin/bash
set -euo pipefail

# deploy-config.sh — OpenClaw configuration deployment (playbook 04, section 4.3)
#
# Always-multi-claw architecture: deploys configuration for all discovered claws.
# For each claw: copies _defaults, overlays claw-specific files, templates, deploys.
#
# Modes:
#   Default:              Deploy everything (shared files + all claw configs)
#   SHARED_ONLY=true:     Deploy shared files only (compose, Vector, entrypoint, plugins, crons, scripts)
#   INSTANCE_NAME=<name>: Deploy config for a single claw only (openclaw.json, models.json)
#
# Interface:
#   Env vars in: OPENCLAW_DOMAIN, OPENCLAW_DOMAIN_PATH, YOUR_TELEGRAM_ID,
#                OPENCLAW_INSTANCE_ID, VPS_HOSTNAME,
#                ENABLE_EVENTS_LOGGING, ENABLE_LLEMTRY_LOGGING,
#                LOG_WORKER_TOKEN, LOG_WORKER_URL, AI_GATEWAY_WORKER_URL,
#                ENABLE_VECTOR_LOG_SHIPPING, VPS1_IP,
#                CRON_MINUTE, CRON_HOUR, CRON_MAINTENANCE_MINUTE, CRON_MAINTENANCE_HOUR,
#                HOSTALERT_TELEGRAM_BOT_TOKEN, HOSTALERT_TELEGRAM_CHAT_ID,
#                INSTANCE_NAME, SHARED_ONLY
#   Stdout: DEPLOY_CONFIG_OK on success (progress -> stderr)
#   Exit: 0 success, 1 failure (e.g. unsubstituted {{VAR}} found)

# ---- Mode detection ----
INSTANCE_NAME="${INSTANCE_NAME:-}"
SHARED_ONLY="${SHARED_ONLY:-false}"

# Determine what to deploy
DEPLOY_SHARED=true
DEPLOY_INSTANCE=true
if [ -n "$INSTANCE_NAME" ]; then
  DEPLOY_SHARED=false
  echo "Mode: single claw (${INSTANCE_NAME})" >&2
elif [ "$SHARED_ONLY" = "true" ]; then
  DEPLOY_INSTANCE=false
  echo "Mode: shared files only" >&2
else
  echo "Mode: full deployment (shared + all claws)" >&2
fi

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"

# ---- Defaults for optional vars ----
YOUR_TELEGRAM_ID="${YOUR_TELEGRAM_ID:-}"
OPENCLAW_DOMAIN_PATH="${OPENCLAW_DOMAIN_PATH:-}"
OPENCLAW_INSTANCE_ID="${OPENCLAW_INSTANCE_ID:-}"
VPS_HOSTNAME="${VPS_HOSTNAME:-}"
ENABLE_EVENTS_LOGGING="${ENABLE_EVENTS_LOGGING:-false}"
ENABLE_LLEMTRY_LOGGING="${ENABLE_LLEMTRY_LOGGING:-false}"
LOG_WORKER_TOKEN="${LOG_WORKER_TOKEN:-}"
LOG_WORKER_URL="${LOG_WORKER_URL:-}"
ENABLE_VECTOR_LOG_SHIPPING="${ENABLE_VECTOR_LOG_SHIPPING:-false}"
HOSTALERT_TELEGRAM_BOT_TOKEN="${HOSTALERT_TELEGRAM_BOT_TOKEN:-}"
HOSTALERT_TELEGRAM_CHAT_ID="${HOSTALERT_TELEGRAM_CHAT_ID:-}"
OPENCLAW_DOMAIN="${OPENCLAW_DOMAIN:-}"

STAGING="$STAGING_DIR"
DEFAULTS_DIR="${OPENCLAWS_DIR}/_defaults"
INSTANCES_DIR="$OPENCLAWS_DIR"

# ── Helper: deploy config for a single claw ──────────────────────────
deploy_claw_config() {
  local name="$1"
  local instance_config="${INSTANCES_DIR}/${name}/config.env"

  # Instance config dir on VPS
  local config_target="${INSTALL_DIR}/instances/${name}/.openclaw"

  echo "Deploying config for claw: ${name}" >&2

  # Layer config: load shared defaults, then claw overrides
  # Save/restore outer env vars that might be modified
  local saved_domain_path="$OPENCLAW_DOMAIN_PATH"
  local saved_instance_id="$OPENCLAW_INSTANCE_ID"
  local saved_domain="$OPENCLAW_DOMAIN"

  if [ -f "$instance_config" ]; then
    # Source claw-specific config on top of shared config
    set -a
    # shellcheck disable=SC1090
    source "$instance_config"
    set +a
  fi

  # Resolve GATEWAY_TOKEN: config.env > existing .gateway-token file > generate new
  # Token is NOT stored in openclaw.json — it's passed via OPENCLAW_GATEWAY_TOKEN env var
  # to avoid drift between config file and env var (which caused auth failures).
  local token="${GATEWAY_TOKEN:-}"
  local token_file="${config_target}/.gateway-token"
  if [ -z "$token" ] && sudo test -f "$token_file"; then
    token=$(sudo cat "$token_file" 2>/dev/null | tr -d '[:space:]' || true)
    [ -n "$token" ] && echo "  Reusing existing GATEWAY_TOKEN for ${name}" >&2
  fi
  if [ -z "$token" ]; then
    token=$(openssl rand -hex 32)
    echo "  Generated GATEWAY_TOKEN for ${name}: ${token}" >&2
  fi
  # Persist token for reuse across redeploys
  echo "$token" | sudo tee "$token_file" > /dev/null
  sudo chown 1000:1000 "$token_file"
  sudo chmod 600 "$token_file"

  # Construct allowed origin for controlUi (required for non-loopback binds)
  local allowed_origin="https://${OPENCLAW_DOMAIN}"

  # Derive endpoint URLs from base LOG_WORKER_URL
  local llemtry_url="${LOG_WORKER_URL}/llemtry"
  local events_url="${LOG_WORKER_URL}/openclaw/events"

  # Determine openclaw.json source — claw-specific overrides _defaults
  local json_source="${INSTANCES_DIR}/${name}/openclaw.json"
  if [ ! -f "$json_source" ]; then
    json_source="${DEFAULTS_DIR}/openclaw.json"
  fi
  [ -f "$json_source" ] || { echo "ERROR: openclaw.json not found for ${name}" >&2; exit 1; }

  # Copy and template openclaw.json
  sudo cp "$json_source" "${config_target}/openclaw.json"

  # Substitute all template variables — use | as sed delimiter (URLs contain /)
  sudo sed -i \
    -e "s|{{OPENCLAW_DOMAIN_PATH}}|${OPENCLAW_DOMAIN_PATH:-}|g" \
    -e "s|{{YOUR_TELEGRAM_ID}}|${YOUR_TELEGRAM_ID}|g" \
    -e "s|{{OPENCLAW_INSTANCE_ID}}|${OPENCLAW_INSTANCE_ID:-${name}}|g" \
    -e "s|{{VPS_HOSTNAME}}|${VPS_HOSTNAME}|g" \
    -e "s|{{ENABLE_EVENTS_LOGGING}}|${ENABLE_EVENTS_LOGGING}|g" \
    -e "s|{{ENABLE_LLEMTRY_LOGGING}}|${ENABLE_LLEMTRY_LOGGING}|g" \
    -e "s|{{EVENTS_URL}}|${events_url}|g" \
    -e "s|{{LLEMTRY_URL}}|${llemtry_url}|g" \
    -e "s|{{LOG_WORKER_TOKEN}}|${LOG_WORKER_TOKEN}|g" \
    -e "s|{{ALLOWED_ORIGIN}}|${allowed_origin}|g" \
    "${config_target}/openclaw.json"

  # Strip JS-style comments — the template uses // for developer documentation
  # but JSON doesn't support comments. Remove full-line and inline comments.
  sudo python3 -c "
import re, sys
path = sys.argv[1]
with open(path, 'r') as f:
    lines = f.readlines()
clean = []
for line in lines:
    stripped = line.strip()
    if stripped.startswith('//'):
        continue
    in_string = False
    escape = False
    cut = None
    for i, ch in enumerate(line):
        if escape:
            escape = False
            continue
        if ch == '\\\\':
            escape = True
            continue
        if ch == '\"':
            in_string = not in_string
            continue
        if not in_string and ch == '/' and i + 1 < len(line) and line[i+1] == '/':
            cut = i
            break
    if cut is not None:
        line = line[:cut].rstrip() + '\n'
    clean.append(line)
result = ''.join(clean)
result = re.sub(r',(\s*[}\]])', r'\1', result)
import json
json.loads(result)
with open(path, 'w') as f:
    f.write(result)
" "${config_target}/openclaw.json"
  echo "  Stripped JS comments from openclaw.json" >&2

  # Verify no unsubstituted {{VAR}} placeholders remain
  if sudo grep -q '{{' "${config_target}/openclaw.json"; then
    echo "ERROR: Unsubstituted template placeholders found in ${name}:" >&2
    sudo grep -n '{{' "${config_target}/openclaw.json" >&2
    exit 1
  fi

  # Ensure container (uid 1000) can read/write, and not world-readable
  sudo chown 1000:1000 "${config_target}/openclaw.json"
  sudo chmod 600 "${config_target}/openclaw.json"
  echo "  Deployed openclaw.json" >&2

  # Deploy per-agent models.json
  # Determine models.json source — claw-specific overrides _defaults
  local models_source="${INSTANCES_DIR}/${name}/models.json"
  if [ ! -f "$models_source" ]; then
    models_source="${DEFAULTS_DIR}/models.json"
  fi

  for agent in main code skills; do
    sudo mkdir -p "${config_target}/agents/${agent}/agent"
    sudo cp "${models_source}" "${config_target}/agents/${agent}/agent/models.json"

    # Substitute template variable
    sudo sed -i "s|{{AI_GATEWAY_WORKER_URL}}|${AI_GATEWAY_WORKER_URL}|g" \
      "${config_target}/agents/${agent}/agent/models.json"

    # Pre-create session store — the gateway lazily creates this dir only when the
    # first session is saved, but `openclaw doctor` reports CRITICAL if it's missing.
    sudo mkdir -p "${config_target}/agents/${agent}/sessions"
    [ -f "${config_target}/agents/${agent}/sessions/sessions.json" ] || \
      echo '{}' | sudo tee "${config_target}/agents/${agent}/sessions/sessions.json" > /dev/null
    sudo chown -R 1000:1000 "${config_target}/agents/${agent}"
    sudo chmod 600 "${config_target}/agents/${agent}/agent/models.json"
    sudo chmod 600 "${config_target}/agents/${agent}/sessions/sessions.json"
  done
  echo "  Deployed per-agent models.json" >&2

  # Restore env vars for next claw
  OPENCLAW_DOMAIN_PATH="$saved_domain_path"
  OPENCLAW_INSTANCE_ID="$saved_instance_id"
  OPENCLAW_DOMAIN="$saved_domain"
  # Reset GATEWAY_TOKEN so next claw generates its own
  GATEWAY_TOKEN=""
}

# ── Shared files (compose, Vector, scripts, crons, plugins) ──────────
if [ "$DEPLOY_SHARED" = "true" ]; then

# 1. Docker Compose override is GENERATED by openclaw-multi.sh, not deployed from staging.
# Skip deploying a static override file — run openclaw-multi.sh generate instead.
echo "Note: docker-compose.override.yml is generated by openclaw-multi.sh (not deployed from staging)" >&2

# 2. Vector log shipper (static, conditional)
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw mkdir -p ${INSTALL_DIR}/vector/data

  sudo -u openclaw cp "${STAGING}/vector/docker-compose.yml" ${INSTALL_DIR}/vector/docker-compose.yml
  sudo -u openclaw cp "${STAGING}/vector/vector.yaml" ${INSTALL_DIR}/vector/vector.yaml

  # Create Vector .env with log shipping credentials
  sudo -u openclaw tee ${INSTALL_DIR}/vector/.env > /dev/null << VECTOREOF
# Vector log shipping — Cloudflare Log Receiver Worker
LOG_WORKER_URL=${LOG_WORKER_URL}
LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
VPS1_IP=${VPS1_IP}
VECTOREOF

  sudo chmod 600 ${INSTALL_DIR}/vector/.env
  echo "Deployed Vector configuration." >&2
else
  echo "Vector log shipping disabled, skipping." >&2
fi

fi  # DEPLOY_SHARED

# ── Per-claw config (openclaw.json, models.json) ─────────────────────
if [ "$DEPLOY_INSTANCE" = "true" ]; then

if [ -n "$INSTANCE_NAME" ]; then
  # Deploy config for a single claw
  deploy_claw_config "$INSTANCE_NAME"
else
  # Deploy config for all discovered claws
  for claw_dir in "${INSTANCES_DIR}"/*/; do
    [ -d "$claw_dir" ] || continue
    claw_name=$(basename "$claw_dir")
    # Skip disabled/special directories
    [[ "$claw_name" == _* ]] && continue
    # Must have config.env
    [ -f "$claw_dir/config.env" ] || continue
    deploy_claw_config "$claw_name"
  done
fi

fi  # DEPLOY_INSTANCE

# ── Shared files continued (scripts, crons, plugins, etc.) ───────────
if [ "$DEPLOY_SHARED" = "true" ]; then

# 5. Build script and patches (static)
# Instead of maintaining a forked Dockerfile, we patch upstream source files
# in-place before building. Each patch auto-skips when already applied.
# Five patches applied by build-openclaw.sh (each auto-skips when upstream fixes the issue).
sudo -u openclaw mkdir -p ${INSTALL_DIR}/scripts
sudo -u openclaw cp "${STAGING}/build-openclaw.sh" ${INSTALL_DIR}/scripts/build-openclaw.sh
sudo chmod +x ${INSTALL_DIR}/scripts/build-openclaw.sh
echo "Deployed build-openclaw.sh." >&2

# 6. Gateway entrypoint script (static)
# Runs as root (user: "0:0"). Handles lock cleanup, permission fixes, dockerd startup,
# sandbox image builds, then drops to node via gosu. See inline comments for details.
sudo -u openclaw mkdir -p ${INSTALL_DIR}/openclaw/scripts
sudo -u openclaw cp "${STAGING}/entrypoint-gateway.sh" ${INSTALL_DIR}/openclaw/scripts/entrypoint-gateway.sh
sudo chmod +x ${INSTALL_DIR}/openclaw/scripts/entrypoint-gateway.sh
echo "Deployed entrypoint-gateway.sh." >&2

# 7. Host alerter & maintenance checker (static)
sudo cp "${STAGING}/host-alert.sh" ${INSTALL_DIR}/scripts/host-alert.sh
sudo chmod +x ${INSTALL_DIR}/scripts/host-alert.sh

sudo cp "${STAGING}/host-maintenance-check.sh" ${INSTALL_DIR}/scripts/host-maintenance-check.sh
sudo chmod +x ${INSTALL_DIR}/scripts/host-maintenance-check.sh

# Create cron entries — alerter every 15 minutes, daily report if Telegram configured
# CRON_MINUTE/CRON_HOUR are computed by Claude from HOSTALERT_DAILY_REPORT_TIME
# and passed in as env vars. Cron runs in the server's local timezone.
{
  echo "INSTALL_DIR=${INSTALL_DIR}"
  echo "# OpenClaw host alerter — checks disk, memory, CPU, container health"
  echo "*/15 * * * * root ${INSTALL_DIR}/scripts/host-alert.sh"

  # Only include the daily report line if Telegram is configured
  if [ -n "${HOSTALERT_TELEGRAM_BOT_TOKEN}" ] && [ -n "${HOSTALERT_TELEGRAM_CHAT_ID}" ]; then
    echo "# Daily health report (time configured via HOSTALERT_DAILY_REPORT_TIME)"
    echo "${CRON_MINUTE} ${CRON_HOUR} * * * root ${INSTALL_DIR}/scripts/host-alert.sh --report"
  fi
} | sudo tee /etc/cron.d/openclaw-alerts > /dev/null

sudo chmod 644 /etc/cron.d/openclaw-alerts

# Maintenance checker cron — runs daily, 30 min before daily report so data is fresh
# Always runs (not gated on Telegram) — JSON is needed by OpenClaw agents
{
  echo "INSTALL_DIR=${INSTALL_DIR}"
  echo "# OpenClaw host maintenance checker — detects pending OS updates, required reboots, failed services"
  echo "# Runs 30 min before daily report so data is fresh for both Telegram and OpenClaw"
  echo "${CRON_MAINTENANCE_MINUTE} ${CRON_MAINTENANCE_HOUR} * * * root ${INSTALL_DIR}/scripts/host-maintenance-check.sh"
} | sudo tee /etc/cron.d/openclaw-maintenance > /dev/null

sudo chmod 644 /etc/cron.d/openclaw-maintenance
echo "Deployed host cron jobs." >&2

# 8. OpenClaw CLI host wrapper (inline)
# Write wrapper directly to /usr/local/bin (not a symlink — adminclaw can't
# traverse ${INSTALL_DIR}/scripts/ due to directory permissions)
# Multi-instance aware: auto-detects running containers, supports --instance flag
sudo tee /usr/local/bin/openclaw > /dev/null << 'WRAPEOF'
#!/bin/bash
# OpenClaw CLI wrapper — multi-claw aware
# Resolves target container via:
#   1. --instance <name> flag (explicit, stripped before passing to openclaw)
#   2. Auto-detect: single running container = use it, multiple = interactive picker

CONTAINER=""

# Check --instance flag
if [ "$1" = "--instance" ] && [ -n "$2" ]; then
  CONTAINER="openclaw-$2"
  shift 2
fi

# Auto-detect from running containers
if [ -z "$CONTAINER" ]; then
  RUNNING=$(sudo docker ps --filter "name=openclaw-" --filter "status=running" \
    --format '{{.Names}}' | grep -v 'openclaw-cli' | sort)
  COUNT=$(echo "$RUNNING" | grep -c . || true)

  if [ "$COUNT" -eq 0 ]; then
    echo "No openclaw containers running." >&2
    exit 1
  elif [ "$COUNT" -eq 1 ]; then
    CONTAINER="$RUNNING"
  else
    echo "Multiple openclaw instances running:" >&2
    i=1
    while IFS= read -r name; do
      echo "  $i) $name" >&2
      i=$((i + 1))
    done <<< "$RUNNING"
    printf "Select instance [1-%d]: " "$COUNT" >&2
    read -r choice
    CONTAINER=$(echo "$RUNNING" | sed -n "${choice}p")
    if [ -z "$CONTAINER" ]; then
      echo "Invalid selection." >&2
      exit 1
    fi
  fi
fi

TTY_FLAG=""
[ -t 0 ] && [ -t 1 ] && TTY_FLAG="-it"
exec sudo docker exec $TTY_FLAG --user node "$CONTAINER" openclaw "$@"
WRAPEOF

sudo chmod +x /usr/local/bin/openclaw
echo "Deployed openclaw CLI wrapper." >&2

# 9. Deploy plugins (static)
# Plugins are loaded via plugins.load.paths in openclaw.json (pointing to /app/deploy/plugins).
# They are NOT copied into ~/.openclaw/extensions/ — this avoids name collisions
# with any plugins bundled by OpenClaw.
# Must be owned by uid 1000 (container's node user), not openclaw (uid 1002).
# OpenClaw's plugin security check blocks candidates with unexpected ownership.
sudo -u openclaw mkdir -p ${INSTALL_DIR}/openclaw/deploy/plugins
sudo cp -r "${STAGING}/plugins/"* ${INSTALL_DIR}/openclaw/deploy/plugins/
sudo chown -R 1000:1000 ${INSTALL_DIR}/openclaw/deploy/plugins/
echo "Deployed plugins." >&2

# 10. Sandbox toolkit, rebuild script, and dashboard (static)
# These files are bind-mounted into the container via ./deploy:/app/deploy:ro.
# They must exist on the host before the container starts, otherwise Docker
# creates empty directories as mount targets and sandbox builds fail.
sudo -u openclaw cp "${STAGING}/sandbox-toolkit.yaml" ${INSTALL_DIR}/openclaw/deploy/sandbox-toolkit.yaml
sudo -u openclaw cp "${STAGING}/parse-toolkit.mjs" ${INSTALL_DIR}/openclaw/deploy/parse-toolkit.mjs
sudo -u openclaw cp "${STAGING}/rebuild-sandboxes.sh" ${INSTALL_DIR}/openclaw/deploy/rebuild-sandboxes.sh
sudo chmod +x ${INSTALL_DIR}/openclaw/deploy/rebuild-sandboxes.sh
sudo -u openclaw mkdir -p ${INSTALL_DIR}/openclaw/deploy/dashboard
sudo -u openclaw cp -r "${STAGING}/dashboard/"* ${INSTALL_DIR}/openclaw/deploy/dashboard/
echo "Deployed sandbox toolkit, rebuild script, and dashboard." >&2

# 11. Auto-start containers after reboot (systemd unit)
# Sysbox services must be fully ready before Docker can start sysbox-runc containers.
# Without this, containers fail to start on boot due to race conditions.
sudo tee /etc/systemd/system/openclaw-autostart.service > /dev/null << STARTEOF
[Unit]
Description=OpenClaw container auto-start
After=docker.service sysbox.service
Requires=docker.service sysbox.service

[Service]
Type=oneshot
RemainAfterExit=true
# Wait for sysbox to be fully ready (FUSE mounts take a moment)
ExecStartPre=/bin/sleep 10
ExecStart=/usr/bin/su - openclaw -c 'cd ${INSTALL_DIR}/openclaw && docker compose up -d'
ExecStop=/usr/bin/su - openclaw -c 'cd ${INSTALL_DIR}/openclaw && docker compose down'
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
STARTEOF

sudo systemctl daemon-reload
sudo systemctl enable openclaw-autostart.service
echo "Deployed openclaw-autostart.service (containers start after reboot)." >&2

# 12. Log rotation config (template — {{INSTALL_DIR}} substituted at deploy time)
sudo cp "${STAGING}/logrotate-openclaw" /etc/logrotate.d/openclaw
sudo sed -i "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" /etc/logrotate.d/openclaw
sudo chmod 644 /etc/logrotate.d/openclaw

# Dry-run test — should show "rotating pattern" for each log file with no errors
sudo logrotate -d /etc/logrotate.d/openclaw >&2 2>&1
echo "Deployed logrotate configuration." >&2

fi  # DEPLOY_SHARED

# Cleanup
sudo rm -rf "${STAGING}"

echo "" >&2
echo "Configuration deployment complete." >&2

echo "DEPLOY_CONFIG_OK"
