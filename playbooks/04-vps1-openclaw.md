# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:

- Sysbox runtime for secure container-in-container
- Docker networks for OpenClaw
- Directory structure and permissions
- OpenClaw repository and configuration
- Docker Compose with security hardening
- Vector for log shipping to Cloudflare
- Host alerter for Telegram notifications

## Prerequisites

- [02-base-setup.md](02-base-setup.md) completed on VPS-1
- [03-docker.md](03-docker.md) completed on VPS-1
- SSH access as `adminclaw` on port 222

## Variables

From `../openclaw-config.env`:

- `VPS1_IP` - Required, public IP of VPS-1
- `AI_GATEWAY_WORKER_URL` - Required, AI Gateway Worker URL
- `AI_GATEWAY_AUTH_TOKEN` - Required, AI Gateway auth token
- `LOG_WORKER_URL` - Required, Log Receiver Worker URL
- `LOG_WORKER_TOKEN` - Required, Log Receiver auth token
- `TELEGRAM_BOT_TOKEN` - Optional
- `TELEGRAM_CHAT_ID` - Optional (required for host alerter)
- `DISCORD_BOT_TOKEN` - Optional
- `OPENCLAW_DOMAIN_PATH` - URL subpath for the gateway UI (default: `/_openclaw`)

---

## 4.1 Install Sysbox Runtime

Sysbox enables running Docker-in-Docker securely for OpenClaw sandboxes.

```bash
#!/bin/bash
# Download Sysbox (check https://github.com/nestybox/sysbox/releases for latest version)
wget https://downloads.nestybox.com/sysbox/releases/v0.6.4/sysbox-ce_0.6.4-0.linux_amd64.deb

# Verify download integrity (hash from https://github.com/nestybox/sysbox/releases/tag/v0.6.4)
echo "d034ddd364ee1f226b8b1ce7456ea8a12abc2eb661bdf42d3e603ed2dc741827  sysbox-ce_0.6.4-0.linux_amd64.deb" | sha256sum -c -

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i sysbox-ce_0.6.4-0.linux_amd64.deb

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
sudo docker info | grep -i "sysbox"

# Cleanup
rm sysbox-ce_0.6.4-0.linux_amd64.deb
```

---

## 4.2 Create Docker Networks

```bash
#!/bin/bash
# IMPORTANT: Use 172.30.x.x subnets to avoid conflicts with Docker's default bridge (172.20.0.0/16)

# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.30.0.0/24 \
    openclaw-gateway-net

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.31.0.0/24 \
    openclaw-sandbox-net
```

---

## 4.3 Create Directory Structure

```bash
#!/bin/bash
# Create directories as openclaw user
sudo -u openclaw bash << 'EOF'
OPENCLAW_HOME="/home/openclaw"

# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in section 4.4
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
EOF

# IMPORTANT: Container runs as uid 1000 (node user), which is typically 'ubuntu' on the host
# Change ownership of .openclaw to uid 1000 for container write access
sudo chown -R 1000:1000 /home/openclaw/.openclaw
```

---

## 4.4 Clone OpenClaw Repository

```bash
#!/bin/bash
sudo -u openclaw bash << 'EOF'
cd /home/openclaw
git clone https://github.com/openclaw/openclaw.git openclaw

# Create data directories for bind mounts (not tracked by git)
mkdir -p /home/openclaw/openclaw/data/docker
mkdir -p /home/openclaw/openclaw/data/vector
EOF
```

---

## 4.5 Create Environment File

```bash
#!/bin/bash
# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 32)

sudo -u openclaw tee /home/openclaw/openclaw/.env << EOF
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# AI Gateway — all provider API keys and base URLs are mapped in compose override
AI_GATEWAY_WORKER_URL=${AI_GATEWAY_WORKER_URL}
AI_GATEWAY_AUTH_TOKEN=${AI_GATEWAY_AUTH_TOKEN}

# Channels (add as needed)
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}

# Log shipping to Cloudflare Worker
LOG_WORKER_URL=${LOG_WORKER_URL}
LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
VPS1_IP=${VPS1_IP}

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

echo ""
echo "========================================="
echo "Generated Credentials (save these):"
echo "  Gateway Token: ${GATEWAY_TOKEN}"
echo "========================================="
```

---

## 4.6 Create Docker Compose Override

The OpenClaw repo includes a docker-compose.yml. Create an override file to add security hardening and monitoring services. Building happens separately via the build script (section 4.8a), not via `docker compose build`.

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/docker-compose.override.yml << 'EOF'
services:
  openclaw-gateway:
    # Image built by scripts/build-openclaw.sh (not by docker compose build)
    image: openclaw:local
    container_name: openclaw-gateway
    runtime: sysbox-runc

    # read_only: false required for Docker-in-Docker — Sysbox auto-provisions
    # /var/lib/docker and /var/lib/containerd as writable mounts, but they inherit
    # the read_only flag. Sysbox user namespace isolation provides equivalent security.
    read_only: false
    tmpfs:
      - /tmp:size=1G,mode=1777
      - /var/tmp:size=200M,mode=1777
      - /run:size=100M,mode=755
      - /var/log:size=100M,mode=755

    # Run as root inside container so entrypoint can start dockerd
    # Sysbox maps root (uid 0) to unprivileged user on host via user namespace
    # Entrypoint drops to node user via gosu before starting gateway
    user: "0:0"

    deploy:
      resources:
        limits:
          cpus: "4"
          memory: 8G
          # Process limit — prevents fork bombs from exhausting host PIDs.
          # 512 (not 256) because gateway runs nested Docker with sandbox containers inside.
          pids: 512
        reservations:
          cpus: "1"
          memory: 2G
    volumes:
      # Entrypoint script: lock cleanup, start dockerd, sandbox bootstrap, gosu drop to node (from 4.8c)
      - ./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
      # Claude Code sandbox credentials (isolated from gateway creds, shared with sandboxes via openclaw.json binds)
      - /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox
      # Persist nested Docker images across restarts (Sysbox auto-provisions ephemeral storage by default)
      - ./data/docker:/var/lib/docker
    # Entrypoint handles pre-start tasks before exec-ing the command
    entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
    # Full gateway command (entrypoint passes it through via exec "$@")
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",      # Required for cloudflared to reach gateway in Docker — loopback won't receive bridge-forwarded traffic
        "--port",
        "18789",
      ]
    security_opt:
      - no-new-privileges:true
    environment:
      - NODE_ENV=production
      # AI Gateway: route all LLM providers through the Worker.
      # All API keys -> AUTH_TOKEN, Anthropic/OpenAI base URLs -> Worker URL.
      # Providers the Worker doesn't handle yet will fail at the Worker (404),
      # preventing requests from leaking to default provider endpoints.
      - ANTHROPIC_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - ANTHROPIC_BASE_URL=${AI_GATEWAY_WORKER_URL}
      - OPENAI_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - OPENAI_BASE_URL=${AI_GATEWAY_WORKER_URL}
      # These providers are not yet supported by the ai-gateway proxy worker
      # - GOOGLE_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      # - XAI_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      # - GROQ_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      # - CEREBRAS_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      # - MISTRAL_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      # - OPENROUTER_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TZ=UTC
    networks:
      - openclaw-gateway-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s  # Extended: first boot builds 3 sandbox images inside nested Docker
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  openclaw-cli:
    # Same image as gateway, built by scripts/build-openclaw.sh
    image: openclaw:local
    runtime: sysbox-runc
    networks:
      - openclaw-gateway-net

  vector:
    image: timberio/vector:0.43.1-alpine
    container_name: vector
    restart: always
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./vector.yaml:/etc/vector/vector.yaml:ro
      - ./data/vector:/var/lib/vector
    environment:
      - LOG_WORKER_URL=${LOG_WORKER_URL}
      - LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
      - VPS1_IP=${VPS1_IP}
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 128M
    networks:
      - openclaw-gateway-net

networks:
  openclaw-gateway-net:
    external: true
EOF
```

---

## 4.7 Create Vector Config

Ships Docker container logs to the Cloudflare Log Receiver Worker.

Vector Alpine image defaults to `vector.yaml`, so we use YAML format to avoid needing a `command` override in compose.

```bash
#!/bin/bash
sudo -u openclaw tee /home/openclaw/openclaw/vector.yaml << 'EOF'
# Vector configuration — ships Docker container logs to Cloudflare Log Receiver Worker
# https://vector.dev/docs/

sources:
  docker_logs:
    type: docker_logs

transforms:
  enrich:
    type: remap
    inputs:
      - docker_logs
    source: '.vps_ip = "${VPS1_IP}"'

sinks:
  cloudflare_worker:
    type: http
    inputs:
      - enrich
    uri: "${LOG_WORKER_URL}"
    encoding:
      codec: json
    auth:
      strategy: bearer
      token: "${LOG_WORKER_TOKEN}"
    batch:
      max_bytes: 262144    # 256KB per batch
      timeout_secs: 60     # Ship at least every 60s
    request:
      retry_max_duration_secs: 300   # Keep retrying for 5 min on failures
EOF

# Create data directory for Vector state
sudo -u openclaw mkdir -p /home/openclaw/openclaw/data/vector
```

---

## 4.8 Create OpenClaw Configuration

```bash
#!/bin/bash
# IMPORTANT: OpenClaw rejects unknown config keys — only use documented keys.
# bind: "lan" required (Docker bridge traffic, not loopback). openclaw doctor warning is expected.
# trustedProxies: exact IPs only, CIDR ranges NOT supported.
# Device pairing: tunnel users need CLI approval — see 08-post-deploy.md.
# gateway.auth.token + gateway.remote.token: must match OPENCLAW_GATEWAY_TOKEN from .env (section 4.5).
#   - auth.token: the gateway uses this for WebSocket auth (CLI flag --token overrides if set)
#   - remote.token: the CLI reads this to authenticate when connecting to the gateway
#   - Without remote.token, `openclaw doctor`, `openclaw devices list`, and `openclaw security audit --deep`
#     all fail with "gateway token mismatch".
# See REQUIREMENTS.md § 3.7 for full rationale.

# Read the gateway token generated in section 4.5
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)

sudo tee /home/openclaw/.openclaw/openclaw.json << JSONEOF
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN}"
    },
    "remote": {
      "token": "${GATEWAY_TOKEN}"
    },
    "trustedProxies": ["172.30.0.1"],
    "controlUi": {
      "basePath": "<OPENCLAW_DOMAIN_PATH>"
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-claude:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew:uid=1000,gid=1000"],
          "network": "bridge",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": { "LANG": "C.UTF-8" },
          "pidsLimit": 256,
          "memory": "1g",
          "memorySwap": "2g",
          "cpus": 1,
          "binds": [
            "/home/node/.claude-sandbox:/home/linuxbrew/.claude"
          ]
        },
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        },
        "prune": {
          "idleHours": 168,
          "maxAgeDays": 60
        }
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "browser", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
}
JSONEOF

# Ensure container (uid 1000) can read/write, and not world-readable
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
sudo chmod 600 /home/openclaw/.openclaw/openclaw.json
```

Create the agent model configuration to route API calls through the AI Gateway proxy:

```bash
#!/bin/bash
# IMPORTANT: The embedded agent reads models.json from the agent directory,
# NOT from openclaw.json. The built-in "anthropic" provider ignores the
# ANTHROPIC_BASE_URL env var — this file is the only way to override the base URL.
#
# The format must be "override-only" (baseUrl without a models array).
# If you include a "models" array, the registry creates new model entries
# instead of overriding the built-in anthropic models, and the built-in
# entries (with hardcoded api.anthropic.com) take precedence.

sudo mkdir -p /home/openclaw/.openclaw/agents/main/agent
sudo tee /home/openclaw/.openclaw/agents/main/agent/models.json << 'JSONEOF'
{
  "providers": {
    "anthropic": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>"
    },
    "openai": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>/v1"
    }
  }
}
JSONEOF

sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/main
sudo chmod 600 /home/openclaw/.openclaw/agents/main/agent/models.json
```

---

## 4.8a Install Build Script and Patches

Instead of maintaining a forked Dockerfile, we patch the upstream Dockerfile in-place before building. Each patch auto-skips when already applied.

One patch is applied:

- Docker + gosu: installs `docker.io` and `gosu` for nested Docker (sandbox isolation via Sysbox)

```bash
#!/bin/bash
# Create directory
sudo -u openclaw mkdir -p /home/openclaw/scripts

# Install build script
sudo -u openclaw tee /home/openclaw/scripts/build-openclaw.sh << 'SCRIPTEOF'
#!/bin/bash
# Build OpenClaw with auto-patching.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#
# Usage: sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
set -euo pipefail

cd /home/openclaw/openclaw

# ── 1. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
# docker.io includes: docker CLI, dockerd, containerd, runc
# gosu: drop-in replacement for su/sudo that doesn't spawn subshell (proper PID 1 signal handling)
# usermod: add node user to docker group for socket access after privilege drop
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  # Insert before USER node so it runs as root
  # Single line to avoid sed multiline continuation issues in Dockerfile
  sed -i '/^USER /i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu && usermod -aG docker node && rm -rf /var/lib/apt/lists/*' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
fi

# ── 2. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 3. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
SCRIPTEOF

sudo chmod +x /home/openclaw/scripts/build-openclaw.sh
```

---

## 4.8c Create Gateway Entrypoint Script

Runs as root (`user: "0:0"`). Handles lock cleanup, permission fixes, dockerd startup, sandbox image builds, then drops to node via `exec gosu node "$@"`. See inline comments for details.

```bash
#!/bin/bash
# Create scripts directory
sudo -u openclaw mkdir -p /home/openclaw/openclaw/scripts

# Create entrypoint script
sudo -u openclaw tee /home/openclaw/openclaw/scripts/entrypoint-gateway.sh << 'SCRIPTEOF'
#!/bin/bash
set -euo pipefail

# ── 1a. Clean stale lock files ──────────────────────────────────────
lock_dir="/home/node/.openclaw"
if compgen -G "${lock_dir}/gateway.*.lock" > /dev/null 2>&1; then
  echo "[entrypoint] Removing stale lock files:"
  ls -la "${lock_dir}"/gateway.*.lock
  rm -f "${lock_dir}"/gateway.*.lock
  echo "[entrypoint] Lock files cleaned"
else
  echo "[entrypoint] No stale lock files found"
fi

# ── 1b. Fix openclaw.json permissions (security audit CRITICAL) ─────
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$config_file" ]; then
  current_perms=$(stat -c '%a' "$config_file" 2>/dev/null || stat -f '%Lp' "$config_file" 2>/dev/null)
  if [ "$current_perms" != "600" ]; then
    chmod 600 "$config_file"
    echo "[entrypoint] Fixed openclaw.json permissions: ${current_perms} -> 600"
  fi
fi

# ── 1c. Fix .claude-sandbox dir ownership (Sysbox uid remapping) ────
# Sandbox credentials dir: host bind mount arrives with host uid which Sysbox remaps.
# Chown to node (1000) so sandbox containers (via binds) can access it.
claude_dir="/home/node/.claude-sandbox"
if [ -d "$claude_dir" ]; then
  dir_owner=$(stat -c '%u' "$claude_dir" 2>/dev/null)
  if [ "$dir_owner" != "1000" ]; then
    chown -R 1000:1000 "$claude_dir"
    echo "[entrypoint] Fixed .claude-sandbox ownership: ${dir_owner} -> 1000"
  fi
fi

# ── 1d. Fix .openclaw dir ownership (Sysbox uid remapping) ──────────
# Gateway config/state dir: bind mount arrives with host uid which Sysbox remaps.
# Some files (identity/, memory/) may be created by root before gosu drops privs.
# Chown to node (1000) so gateway process can read/write after privilege drop.
openclaw_dir="/home/node/.openclaw"
if [ -d "$openclaw_dir" ]; then
  root_files=$(find "$openclaw_dir" -not -user 1000 2>/dev/null | head -1)
  if [ -n "$root_files" ]; then
    chown -R 1000:1000 "$openclaw_dir"
    echo "[entrypoint] Fixed .openclaw ownership to node (1000)"
  fi
fi

# ── 1e. Create openclaw CLI symlink ──────────────────────────────────
# /app/openclaw.mjs has #!/usr/bin/env node shebang and is executable.
# Symlink to /usr/local/bin so 'openclaw' works anywhere in the container.
if [ ! -L /usr/local/bin/openclaw ]; then
  ln -sf /app/openclaw.mjs /usr/local/bin/openclaw
  echo "[entrypoint] Created /usr/local/bin/openclaw symlink"
fi

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# /var/lib/docker is a persistent bind mount from host (./data/docker),
# so sandbox images survive container restarts (no ~5min rebuild).
# TODO: verify sandbox image checksums on startup and rebuild if tampered,
# to mitigate poisoned-image persistence risk.
if command -v dockerd > /dev/null 2>&1; then
  if ! docker info > /dev/null 2>&1; then
    echo "[entrypoint] Starting nested Docker daemon..."
    dockerd --host=unix:///var/run/docker.sock \
            --storage-driver=overlay2 \
            --log-level=warn \
            --group="$(getent group docker | cut -d: -f3)" \
            > /var/log/dockerd.log 2>&1 &

    # Wait for Docker daemon to be ready
    echo "[entrypoint] Waiting for nested Docker daemon..."
    timeout=30
    elapsed=0
    while ! docker info > /dev/null 2>&1; do
      if [ "$elapsed" -ge "$timeout" ]; then
        echo "[entrypoint] WARNING: Docker daemon not ready after ${timeout}s"
        echo "[entrypoint] dockerd log:"
        tail -20 /var/log/dockerd.log 2>/dev/null || true
        break
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
  fi

  if docker info > /dev/null 2>&1; then
    echo "[entrypoint] Nested Docker daemon ready (took ${elapsed:-0}s)"

    # Sandbox builds are non-fatal — gateway starts even if builds fail.
    # Failures are logged but don't prevent the gateway from running.
    # Missing images will surface during deployment verification or when agents run.
    (
      set +e

      # Build default sandbox image if missing
      if ! docker image inspect openclaw-sandbox:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Base sandbox image not found, building..."
        if [ -f /app/Dockerfile.sandbox ]; then
          cd /app && scripts/sandbox-setup.sh
          if docker image inspect openclaw-sandbox:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: /app/Dockerfile.sandbox not found"
        fi
      else
        echo "[entrypoint] Sandbox image already exists"
      fi

      # Build common sandbox image if missing (includes Node.js, git, common tools)
      # Upstream sandbox-common-setup.sh has a bug: the generated Dockerfile inherits
      # USER sandbox from the base image and runs apt-get without switching to root.
      # Fix: build a rooted intermediate image and pass it via BASE_IMAGE env var.
      if ! docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Common sandbox image not found, building..."
        if [ -f /app/scripts/sandbox-common-setup.sh ]; then
          # Step 1: Build rooted intermediate from base image
          printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\n' \
            | docker build -t openclaw-sandbox-base-root:bookworm-slim -
          if ! docker image inspect openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] ERROR: Failed to build rooted intermediate image"
          else
            # Step 2: Run upstream script with BASE_IMAGE override + extra packages
            BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
            PACKAGES="curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file ffmpeg imagemagick" \
            /app/scripts/sandbox-common-setup.sh || true

            # Step 3: Verify and fix USER to 1000 for security
            if docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
              printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER 1000\n' \
                | docker build -t openclaw-sandbox-common:bookworm-slim -
              echo "[entrypoint] Common sandbox image built successfully"
            else
              echo "[entrypoint] ERROR: Common sandbox image build failed — upstream script did not produce image"
            fi

            # Step 4: Cleanup intermediate image
            docker rmi openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1 || true
          fi
        else
          echo "[entrypoint] WARNING: sandbox-common-setup.sh not found"
        fi
      else
        echo "[entrypoint] Common sandbox image already exists"
      fi

      # Build browser sandbox image if missing (includes Chromium, noVNC)
      if ! docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Browser sandbox image not found, building..."
        if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
          /app/scripts/sandbox-browser-setup.sh
          if docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Browser sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Browser sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found"
        fi
      else
        echo "[entrypoint] Browser sandbox image already exists"
      fi

      # Build claude sandbox image if missing (layered on common with Claude Code CLI)
      # ffmpeg + imagemagick are already in common via PACKAGES override above
      if ! docker image inspect openclaw-sandbox-claude:bookworm-slim > /dev/null 2>&1; then
        if docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
          echo "[entrypoint] Claude sandbox image not found, building..."
          printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' \
            | docker build -t openclaw-sandbox-claude:bookworm-slim -
          if docker image inspect openclaw-sandbox-claude:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Claude sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Claude sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: Skipping claude sandbox — common image not available"
        fi
      else
        echo "[entrypoint] Claude sandbox image already exists"
      fi
    )
  fi
else
  echo "[entrypoint] Docker not installed, skipping sandbox bootstrap"
fi

# ── 3. Drop privileges and exec gateway ─────────────────────────────
# gosu drops from root to node user without spawning a subshell,
# preserving PID structure for proper signal handling via tini
echo "[entrypoint] Executing as node: $*"
exec gosu node "$@"
SCRIPTEOF

# Make executable
sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
```

---

## 4.8d Create Host Alerter

Install a host monitoring script that sends alerts via Telegram when disk, memory, or CPU thresholds are exceeded.

> **Note:** Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set in `openclaw-config.env`.

```bash
#!/bin/bash
# Create host alert script
sudo tee /home/openclaw/scripts/host-alert.sh << 'SCRIPTEOF'
#!/bin/bash
# Host alerter — checks disk, memory, CPU and sends Telegram alerts
set -euo pipefail

# Source config for Telegram credentials
source /home/openclaw/openclaw/.env 2>/dev/null || true

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
  exit 0  # Silently skip if Telegram not configured
fi

HOSTNAME=$(hostname)
ALERTS=""

# Check disk usage (warn at 85%)
DISK_USAGE=$(df / --output=pcent | tail -1 | tr -d ' %')
if [ "$DISK_USAGE" -ge 85 ]; then
  ALERTS="${ALERTS}⚠️ Disk usage: ${DISK_USAGE}%\n"
fi

# Check memory usage (warn at 90%)
MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')
MEM_USED=$(free -m | awk '/^Mem:/{print $3}')
MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
if [ "$MEM_PCT" -ge 90 ]; then
  ALERTS="${ALERTS}⚠️ Memory usage: ${MEM_PCT}% (${MEM_USED}/${MEM_TOTAL} MB)\n"
fi

# Check 5-min load average vs CPU count
CPU_COUNT=$(nproc)
LOAD_AVG=$(awk '{print $2}' /proc/loadavg)
LOAD_INT=$(echo "$LOAD_AVG" | awk -F. '{print $1}')
if [ "$LOAD_INT" -ge "$CPU_COUNT" ]; then
  ALERTS="${ALERTS}⚠️ Load average: ${LOAD_AVG} (CPUs: ${CPU_COUNT})\n"
fi

# Check if gateway container is running
if ! docker ps --format '{{.Names}}' | grep -q '^openclaw-gateway$'; then
  ALERTS="${ALERTS}🔴 openclaw-gateway container is NOT running\n"
fi

# Check backup freshness (warn if no backup in last 36 hours)
BACKUP_DIR="/home/openclaw/.openclaw/backups"
if [ -d "$BACKUP_DIR" ]; then
  LATEST_BACKUP=$(find "$BACKUP_DIR" -name "openclaw_backup_*.tar.gz" -mmin -2160 | head -1)
  if [ -z "$LATEST_BACKUP" ]; then
    ALERTS="${ALERTS}⚠️ No backup in last 36 hours!\n"
  fi
fi

# Send alert if any issues found
if [ -n "$ALERTS" ]; then
  MESSAGE="🖥️ *${HOSTNAME} Alert*\n\n${ALERTS}"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d text="$(echo -e "$MESSAGE")" \
    -d parse_mode="Markdown" > /dev/null 2>&1
fi
SCRIPTEOF

sudo chmod +x /home/openclaw/scripts/host-alert.sh

# Create cron entry — runs every 15 minutes as root
sudo tee /etc/cron.d/openclaw-alerts << 'EOF'
# OpenClaw host alerter — checks disk, memory, CPU, container health
*/15 * * * * root /home/openclaw/scripts/host-alert.sh
EOF

sudo chmod 644 /etc/cron.d/openclaw-alerts
```

---

## 4.8e Create OpenClaw CLI Host Wrapper

Create a convenience wrapper so `adminclaw` can run `openclaw <command>` directly from the VPS host without typing the full `docker exec` prefix.

```bash
#!/bin/bash
# Write wrapper directly to /usr/local/bin (not a symlink — adminclaw can't
# traverse /home/openclaw/scripts/ due to directory permissions)
sudo tee /usr/local/bin/openclaw << 'WRAPEOF'
#!/bin/bash
# OpenClaw CLI wrapper — runs commands inside the gateway container as node user
exec sudo docker exec --user node openclaw-gateway openclaw "$@"
WRAPEOF

sudo chmod +x /usr/local/bin/openclaw
```

After this, `adminclaw` can run commands like:

```bash
openclaw --version
openclaw doctor --deep
openclaw security audit --deep
openclaw devices list
```

---

## 4.9 Build and Start OpenClaw

```bash
#!/bin/bash
# Build image with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Start services
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# Check status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 20 openclaw-gateway
```

---

## Verification

```bash
# Check containers are running
sudo -u openclaw docker compose ps

# Check gateway logs
sudo docker logs --tail 50 openclaw-gateway

# Test internal endpoint
curl -s http://localhost:18789/ | head -5

# Test health endpoint
curl -s http://localhost:18789/health

# Check Vector is running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps vector'

# Check Vector logs
sudo docker logs --tail 10 vector
```

### Sandbox Image Verification

Run after gateway startup to verify all sandbox images were built correctly. With the persistent `/var/lib/docker` bind mount, images survive restarts — the entrypoint only rebuilds missing images. On first boot, wait for logs to show build completion before checking.

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds (look for privilege drop message)
echo "Waiting for entrypoint to finish..."
timeout 600 bash -c 'until sudo docker logs openclaw-gateway 2>&1 | grep -q "Executing as node"; do sleep 5; done'

echo "=== Checking sandbox images ==="
FAILED=0

# 1. Check all 4 images exist
for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-common:bookworm-slim \
           openclaw-sandbox-browser:bookworm-slim openclaw-sandbox-claude:bookworm-slim; do
  if sudo docker exec openclaw-gateway docker image inspect "$img" > /dev/null 2>&1; then
    echo "  $img: EXISTS"
  else
    echo "  $img: MISSING"
    FAILED=1
  fi
done

# 2. Security check: verify USER is 1000 (not root) on common and claude images
for img in openclaw-sandbox-common:bookworm-slim openclaw-sandbox-claude:bookworm-slim; do
  USER=$(sudo docker exec openclaw-gateway docker image inspect "$img" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null)
  if [ "$USER" = "1000" ]; then
    echo "  $img USER: 1000 (OK)"
  else
    echo "  $img USER: $USER (EXPECTED 1000)"
    FAILED=1
  fi
done

# 3. Test key binaries in common sandbox
# ffmpeg + imagemagick are in common (via PACKAGES override), not claude
for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  common/$bin: OK"
  else
    echo "  common/$bin: MISSING"
    FAILED=1
  fi
done

# 4. Test claude sandbox (should inherit common tools + add Claude Code CLI)
for bin in claude ffmpeg node; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  claude/$bin: OK"
  else
    echo "  claude/$bin: MISSING"
    FAILED=1
  fi
done

# 5. Check no intermediate images left
if sudo docker exec openclaw-gateway docker images | grep -q base-root; then
  echo "  WARNING: intermediate base-root image not cleaned up"
fi

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "SANDBOX VERIFICATION FAILED — check entrypoint logs:"
  echo "  sudo docker logs openclaw-gateway 2>&1 | grep '\\[entrypoint\\]'"
fi
```

**Expected:** All images exist, USER is 1000, all binaries present. If verification fails, check entrypoint logs for ERROR messages.

---

## Troubleshooting

### Sysbox Not Found

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Reinstall if needed
sudo dpkg -i sysbox-ce_*.deb
```

### Container Won't Start

```bash
# Check logs for config errors
sudo docker logs openclaw-gateway

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Permission Denied on .openclaw

```bash
# Fix ownership - container runs as uid 1000
sudo chown -R 1000:1000 /home/openclaw/.openclaw
```

### Vector Not Shipping Logs

```bash
# Check Vector logs for config errors
sudo docker logs vector 2>&1 | head -20

# Verify vector.yaml is mounted correctly
sudo docker exec vector ls -la /etc/vector/

# Test the Worker endpoint is reachable from within the container
sudo docker exec vector wget -q -O- <LOG_WORKER_URL_WITHOUT_PATH>/health

# Restart Vector after fixing
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart vector'
```

### Network Issues

```bash
# Verify network exists
docker network ls | grep openclaw

# Recreate if needed
docker network rm openclaw-gateway-net
docker network create --driver bridge --subnet 172.30.0.0/24 openclaw-gateway-net
```

---

## Updating OpenClaw

The `openclaw update` CLI command does **not** work inside Docker — the `.git` directory is excluded by `.dockerignore`, so the update tool reports `not-git-install`. Instead, update by rebuilding from the host git repo using the build script.

The build script auto-patches the Dockerfile and restores the git working tree after building, so `git pull` always works cleanly.

```bash
#!/bin/bash
# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git tag -f pre-update'
docker tag openclaw:local "openclaw:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git pull origin main'
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 5. Verify new version
openclaw --version
curl -s http://localhost:18789/health

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-' | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "openclaw:rollback-$(date +%Y%m%d)" openclaw:local

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 4. Verify
openclaw --version
curl -s http://localhost:18789/health
```

> If the rollback date tag doesn't match today, list available rollback images with:
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-'`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
- See [REQUIREMENTS.md § 3.4](../REQUIREMENTS.md#34-gateway-container-docker-composeoverrideyml) for full rationale
