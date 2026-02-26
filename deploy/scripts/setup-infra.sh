#!/bin/bash
set -euo pipefail

# setup-infra.sh — OpenClaw infrastructure setup (playbook 04, section 4.2)
#
# Creates Docker networks, per-claw directory structure, clones the OpenClaw repo,
# and generates the gateway .env file.
#
# Always-multi-claw architecture: every deployment uses the same instance-based layout
# under ${INSTALL_DIR}/instances/<name>/, even if running just one claw.
#
# Interface:
#   Env vars in: AI_GATEWAY_WORKER_URL, AI_GATEWAY_AUTH_TOKEN,
#                OPENCLAW_TELEGRAM_BOT_TOKEN, HOSTALERT_TELEGRAM_BOT_TOKEN,
#                HOSTALERT_TELEGRAM_CHAT_ID, OPENCLAW_DASHBOARD_DOMAIN_PATH,
#                OPENCLAW_DOMAIN_PATH, GATEWAY_CPUS, GATEWAY_MEMORY,
#                INSTANCE_NAMES (space-separated list of claw names)
#   Stdout: single line OPENCLAW_GENERATED_TOKEN=<hex> (all other output -> stderr)
#   Exit: 0 success, 1 failure

# Validate required environment variables
# These must be passed by the caller (see playbook 04, section 4.2).
# If running via sudo, use: env VAR=value ... bash setup-infra.sh
# (do NOT use: sudo bash setup-infra.sh — sudo strips env vars)
missing=0
for var in AI_GATEWAY_WORKER_URL AI_GATEWAY_AUTH_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required env var ${var} is not set." >&2
    echo "  Hint: use 'env VAR=val ... bash setup-infra.sh' (not 'sudo bash')." >&2
    missing=1
  fi
done
[ "$missing" -eq 1 ] && exit 1

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"

# INSTANCE_NAMES is required — always-multi-claw means at least "main-claw"
INSTANCE_NAMES="${INSTANCE_NAMES:-main-claw}"

# Part 1: Create Docker Networks
# IMPORTANT: Use 172.30.x.x subnets to avoid conflicts with Docker's default bridge (172.17.0.0/16)

# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.30.0.0/24 \
    openclaw-gateway-net >&2

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.31.0.0/24 \
    openclaw-sandbox-net >&2

# Part 2: Create Directory Structure (instance-based layout)
# Each claw gets full isolation under ${INSTALL_DIR}/instances/<name>/
# Ensure INSTALL_DIR exists and is owned by openclaw.
# Default /home/openclaw is already correct (created by useradd -m), but custom
# INSTALL_DIR values (e.g. /opt/openclaw) may be root-owned from the staging mkdir.
sudo mkdir -p "$INSTALL_DIR"
sudo chown openclaw:openclaw "$INSTALL_DIR"

sudo -u openclaw bash -s "$INSTALL_DIR" << 'DIREOF'
set -euo pipefail
OPENCLAW_HOME="$1"

# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in Part 3
mkdir -p "${OPENCLAW_HOME}/scripts"
mkdir -p "${OPENCLAW_HOME}/instances"
DIREOF

for inst_name in $INSTANCE_NAMES; do
  # Pass inst_name and INSTALL_DIR as arguments (not heredoc interpolation) to prevent shell injection
  sudo -u openclaw bash -s "$inst_name" "$INSTALL_DIR" << 'INSTEOF'
set -euo pipefail
inst_name="$1"
OPENCLAW_HOME="$2"
INST_DIR="${OPENCLAW_HOME}/instances/${inst_name}"

mkdir -p "${INST_DIR}/.openclaw/workspace"
mkdir -p "${INST_DIR}/.openclaw/credentials"
mkdir -p "${INST_DIR}/.openclaw/logs"
mkdir -p "${INST_DIR}/.openclaw/backups"
mkdir -p "${INST_DIR}/docker"

chmod 700 "${INST_DIR}/.openclaw"
chmod 700 "${INST_DIR}/.openclaw/credentials"
INSTEOF

  # Do NOT change 1000:1000 to openclaw:openclaw!
  # The container runs as uid 1000 (node user inside Docker), which is typically
  # 'ubuntu' on the host — NOT the openclaw user (uid 1002). Using the openclaw
  # UID breaks container write access to these directories.
  sudo chown -R 1000:1000 "${INSTALL_DIR}/instances/${inst_name}/.openclaw"

  # Host status directory — written by root cron scripts, read by agents via workspace
  # Lives under workspace/ so agents can read via relative path (host-status/health.json)
  # Root-owned with 755/644 permissions so both root can write and container can read
  sudo mkdir -p "${INSTALL_DIR}/instances/${inst_name}/.openclaw/workspace/host-status"
  sudo chmod 755 "${INSTALL_DIR}/instances/${inst_name}/.openclaw/workspace/host-status"

  echo "  Created directories for claw: ${inst_name}" >&2
done

echo "Directory structure created." >&2

# Part 3: Clone OpenClaw Repository
sudo -u openclaw bash -s "$INSTALL_DIR" << 'CLONEEOF'
set -euo pipefail
cd "$1"
git clone https://github.com/openclaw/openclaw.git openclaw
CLONEEOF

echo "Repository cloned." >&2

# Part 4: Create Environment File
GATEWAY_TOKEN=$(openssl rand -hex 32)

# Dashboard base path — direct from config, no parsing needed
DASHBOARD_BASE_PATH="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"

sudo -u openclaw tee ${INSTALL_DIR}/openclaw/.env > /dev/null << EOF
# Gateway authentication (shared default — per-claw tokens in openclaw.json)
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# AI Gateway — all provider API keys and base URLs are mapped in compose override
AI_GATEWAY_WORKER_URL=${AI_GATEWAY_WORKER_URL}
AI_GATEWAY_AUTH_TOKEN=${AI_GATEWAY_AUTH_TOKEN}

# Telegram channel — OpenClaw bot for chatting via Telegram
OPENCLAW_TELEGRAM_BOT_TOKEN=${OPENCLAW_TELEGRAM_BOT_TOKEN:-}

# Host alerter (Telegram notifications — see docs/TELEGRAM.md)
HOSTALERT_TELEGRAM_BOT_TOKEN=${HOSTALERT_TELEGRAM_BOT_TOKEN:-}
HOSTALERT_TELEGRAM_CHAT_ID=${HOSTALERT_TELEGRAM_CHAT_ID:-}

# Dashboard base path — from OPENCLAW_DASHBOARD_DOMAIN_PATH
# Empty = dashboard serves at root (e.g., dashboard on a separate subdomain)
DASHBOARD_BASE_PATH=${DASHBOARD_BASE_PATH}

# Gateway Control UI subpath — must match gateway.controlUi.basePath in openclaw.json.
# Used by Docker healthcheck and playbook verification commands.
# Empty = Control UI served at root (no subpath).
OPENCLAW_DOMAIN_PATH=${OPENCLAW_DOMAIN_PATH:-}

# Gateway resource limits (from openclaw-config.env, defaults in docker-compose.override.yml)
GATEWAY_CPUS=${GATEWAY_CPUS:-}
GATEWAY_MEMORY=${GATEWAY_MEMORY:-}

# Docker compose variables (required by repo's docker-compose.yml)
OPENCLAW_CONFIG_DIR=${INSTALL_DIR}/.openclaw
OPENCLAW_WORKSPACE_DIR=${INSTALL_DIR}/.openclaw/workspace
# Port numbers only — DO NOT use IP:port format (e.g. 127.0.0.1:18789)
# OpenClaw CLI reads this env var and misparses IP:port as port number
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
# Gateway bind mode: "lan" is required for Docker deployments.
# loopback doesn't work because Docker port-forwards traffic through the bridge
# network (172.30.0.1), not loopback. The openclaw doctor warning about lan binding
# is expected — actual network security is enforced by daemon.json localhost binding.
OPENCLAW_GATEWAY_BIND=lan
EOF

sudo chmod 600 ${INSTALL_DIR}/openclaw/.env
sudo chown openclaw:openclaw ${INSTALL_DIR}/openclaw/.env

echo "" >&2
echo "Generated Credentials (save these):" >&2
echo "  Gateway Token: ${GATEWAY_TOKEN}" >&2
if [ -n "${DASHBOARD_BASE_PATH}" ]; then
  echo "  Dashboard Base Path: ${DASHBOARD_BASE_PATH}" >&2
fi

echo "OPENCLAW_GENERATED_TOKEN=${GATEWAY_TOKEN}"
