#!/bin/bash
set -euo pipefail

# setup-infra.sh — OpenClaw infrastructure setup (playbook 04, section 4.2)
#
# Creates Docker networks, directory structure, clones the OpenClaw repo,
# and generates the gateway .env file with a random GATEWAY_TOKEN.
#
# Interface:
#   Env vars in: AI_GATEWAY_WORKER_URL, AI_GATEWAY_AUTH_TOKEN,
#                OPENCLAW_TELEGRAM_BOT_TOKEN, HOSTALERT_TELEGRAM_BOT_TOKEN,
#                HOSTALERT_TELEGRAM_CHAT_ID, OPENCLAW_DASHBOARD_DOMAIN_PATH,
#                OPENCLAW_DOMAIN_PATH, GATEWAY_CPUS, GATEWAY_MEMORY
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

# Part 2: Create Directory Structure
sudo -u openclaw bash << 'DIREOF'
OPENCLAW_HOME="/home/openclaw"

# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in Part 3
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

# Persistent sandbox home directories — agents opt in via openclaw.json binds
mkdir -p "${OPENCLAW_HOME}/sandboxes-home"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
DIREOF

# Do NOT change 1000:1000 to openclaw:openclaw!
# The container runs as uid 1000 (node user inside Docker), which is typically
# 'ubuntu' on the host — NOT the openclaw user (uid 1002). Using the openclaw
# UID breaks container write access to these directories.
sudo chown -R 1000:1000 /home/openclaw/.openclaw
sudo chown -R 1000:1000 /home/openclaw/sandboxes-home

# Host status directory — written by root cron scripts, read by agents via workspace
# Lives under workspace/ so agents can read via relative path (host-status/health.json)
# Root-owned with 755/644 permissions so both root can write and container can read
sudo mkdir -p /home/openclaw/.openclaw/workspace/host-status
sudo chmod 755 /home/openclaw/.openclaw/workspace/host-status

echo "Directory structure created." >&2

# Part 3: Clone OpenClaw Repository
sudo -u openclaw bash << 'CLONEEOF'
cd /home/openclaw
git clone https://github.com/openclaw/openclaw.git openclaw

# Create data directory for bind mounts (not tracked by git)
mkdir -p /home/openclaw/openclaw/data/docker
CLONEEOF

echo "Repository cloned." >&2

# Part 4: Create Environment File
GATEWAY_TOKEN=$(openssl rand -hex 32)

# Dashboard base path — direct from config, no parsing needed
DASHBOARD_BASE_PATH="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"

sudo -u openclaw tee /home/openclaw/openclaw/.env > /dev/null << EOF
# Gateway authentication
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
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
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

sudo chmod 600 /home/openclaw/openclaw/.env
sudo chown openclaw:openclaw /home/openclaw/openclaw/.env

echo "" >&2
echo "Generated Credentials (save these):" >&2
echo "  Gateway Token: ${GATEWAY_TOKEN}" >&2
if [ -n "${DASHBOARD_BASE_PATH}" ]; then
  echo "  Dashboard Base Path: ${DASHBOARD_BASE_PATH}" >&2
fi

echo "OPENCLAW_GENERATED_TOKEN=${GATEWAY_TOKEN}"
