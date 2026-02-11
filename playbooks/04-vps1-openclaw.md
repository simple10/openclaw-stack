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
# SOURCE: deploy/docker-compose.override.yml → /home/openclaw/openclaw/docker-compose.override.yml
sudo -u openclaw tee /home/openclaw/openclaw/docker-compose.override.yml << 'EOF'
# <<< deploy/docker-compose.override.yml >>>
EOF
```

---

## 4.7 Create Vector Config

Ships Docker container logs to the Cloudflare Log Receiver Worker.

Vector Alpine image defaults to `vector.yaml`, so we use YAML format to avoid needing a `command` override in compose.

```bash
#!/bin/bash
# SOURCE: deploy/vector.yaml → /home/openclaw/openclaw/vector.yaml
sudo -u openclaw tee /home/openclaw/openclaw/vector.yaml << 'EOF'
# <<< deploy/vector.yaml >>>
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
#
# Tiered sandbox architecture (config-driven via deploy/sandbox-toolkit.yaml):
#   defaults → base sandbox (openclaw-sandbox:bookworm-slim), no network — lightweight for main agent
#   "skills" agent → common sandbox (openclaw-sandbox-common:bookworm-slim), bridge network — runs skill binaries
#   "code" agent → common sandbox (openclaw-sandbox-common:bookworm-slim), bridge network, Claude Code CLI
#   All tools (gifgrep, claude-code, ffmpeg, etc.) are installed in sandbox-common via sandbox-toolkit.yaml.
#   Main agent delegates to skills agent for skills needing network (gifgrep, weather, etc.)
#   Main agent delegates to code agent via sessions_spawn for coding tasks.
#   /opt/skill-bins is auto-shimmed from sandbox-toolkit.yaml (see entrypoint §1g).

# Read the gateway token generated in section 4.5
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)

# SOURCE: deploy/openclaw.json (template) → /home/openclaw/.openclaw/openclaw.json
# VARS: GATEWAY_TOKEN (from .env on VPS), OPENCLAW_DOMAIN_PATH (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/openclaw.json << 'JSONEOF'
# <<< deploy/openclaw.json (template) >>>
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

# SOURCE: deploy/models.json (template) → /home/openclaw/.openclaw/agents/main/agent/models.json
# VARS: AI_GATEWAY_WORKER_URL (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/agents/main/agent/models.json << 'JSONEOF'
# <<< deploy/models.json (template) >>>
JSONEOF

sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/main
sudo chmod 600 /home/openclaw/.openclaw/agents/main/agent/models.json
```

Create the same model configuration for the code agent:

```bash
#!/bin/bash
sudo mkdir -p /home/openclaw/.openclaw/agents/code/agent

# SOURCE: deploy/models.json (template) → /home/openclaw/.openclaw/agents/code/agent/models.json
# VARS: AI_GATEWAY_WORKER_URL (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/agents/code/agent/models.json << 'JSONEOF'
# <<< deploy/models.json (template) >>>
JSONEOF

sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/code
sudo chmod 600 /home/openclaw/.openclaw/agents/code/agent/models.json
```

Create the same model configuration for the skills agent:

```bash
#!/bin/bash
sudo mkdir -p /home/openclaw/.openclaw/agents/skills/agent

# SOURCE: deploy/models.json (template) → /home/openclaw/.openclaw/agents/skills/agent/models.json
# VARS: AI_GATEWAY_WORKER_URL (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/agents/skills/agent/models.json << 'JSONEOF'
# <<< deploy/models.json (template) >>>
JSONEOF

sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/skills
sudo chmod 600 /home/openclaw/.openclaw/agents/skills/agent/models.json
```

---

## 4.8a Install Build Script and Patches

Instead of maintaining a forked Dockerfile, we patch upstream source files in-place before building. Each patch auto-skips when already applied.

Two patches are applied:

1. **Dockerfile**: installs `docker.io` and `gosu` for nested Docker (sandbox isolation via Sysbox)
2. **attempt.ts**: enables `systemPrompt` in the `before_agent_start` hook result (needed by skill-router plugin)

```bash
#!/bin/bash
# Create directory
sudo -u openclaw mkdir -p /home/openclaw/scripts

# SOURCE: deploy/build-openclaw.sh → /home/openclaw/scripts/build-openclaw.sh
sudo -u openclaw tee /home/openclaw/scripts/build-openclaw.sh << 'SCRIPTEOF'
# <<< deploy/build-openclaw.sh >>>
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

# SOURCE: deploy/entrypoint-gateway.sh → /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
sudo -u openclaw tee /home/openclaw/openclaw/scripts/entrypoint-gateway.sh << 'SCRIPTEOF'
# <<< deploy/entrypoint-gateway.sh >>>
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
# SOURCE: deploy/host-alert.sh → /home/openclaw/scripts/host-alert.sh
sudo tee /home/openclaw/scripts/host-alert.sh << 'SCRIPTEOF'
# <<< deploy/host-alert.sh >>>
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

## 4.8f Deploy Skill Router Plugin

Network-requiring skills (gifgrep, etc.) fail in the main agent's sandbox (`network: "none"`). The skills agent has bridge network access but doesn't receive slash commands — the main agent does.

**Solution:** The skill-router plugin intercepts the `before_agent_start` hook and rewrites skill descriptions in the system prompt based on routing rules in `openclaw.json`. The main agent sees delegation instructions; the skills agent sees original descriptions and executes directly.

How it works:

1. Plugin lives in `deploy/plugins/skill-router/` (bind-mounted read-only into the container)
2. Entrypoint section 1h copies plugins to `~/.openclaw/extensions/` where the gateway discovers them
3. On agent start, the plugin matches skill names against configured rules and rewrites `<description>` tags
4. Routing rules are configured in `openclaw.json` under `plugins.entries.skill-router.config.rules`

SCP the plugin to the VPS:

```bash
#!/bin/bash
# Create deploy/plugins directory on VPS
sudo -u openclaw mkdir -p /home/openclaw/openclaw/deploy/plugins

# Copy plugins from local repo
# Run from local machine:
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r deploy/plugins/* ${SSH_USER}@${VPS1_IP}:/tmp/deploy-plugins/

# Move into place with correct ownership
sudo cp -r /tmp/deploy-plugins/* /home/openclaw/openclaw/deploy/plugins/
sudo chown -R openclaw:openclaw /home/openclaw/openclaw/deploy/plugins/
rm -rf /tmp/deploy-plugins
```

To add a new delegated skill, append the skill name to the `skills` array in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "skill-router": {
        "config": {
          "rules": [{ "agent": "main", "delegateTo": "skills", "skills": ["gifgrep", "new-skill"] }]
        }
      }
    }
  }
}
```

No new files needed — just update the config and restart the gateway.

---

## 4.8g Configure Log Rotation

The hook-generated JSONL logs (`debug.log`, `commands.log`) and the backup cron log (`backup.log`) in `~/.openclaw/logs/` grow unbounded. Docker container logs are already rotated via the `json-file` driver in `docker-compose.override.yml`, but these application-level files need logrotate.

```bash
#!/bin/bash
# SOURCE: deploy/logrotate-openclaw → /etc/logrotate.d/openclaw
sudo tee /etc/logrotate.d/openclaw << 'EOF'
# <<< deploy/logrotate-openclaw >>>
EOF

sudo chmod 644 /etc/logrotate.d/openclaw

# Dry-run test — should show "rotating pattern" for each log file with no errors
sudo logrotate -d /etc/logrotate.d/openclaw
```

---

## 4.8h Deploy Managed Hooks

Custom managed hooks live in `deploy/hooks/<name>/` (HOOK.md + handler.js). The entrypoint copies them to `~/.openclaw/hooks/` on boot, and `openclaw.json` enables them via `hooks.internal.entries`.

SCP hooks to the VPS:

```bash
#!/bin/bash
# Create deploy/hooks directory on VPS
sudo -u openclaw mkdir -p /home/openclaw/openclaw/deploy/hooks

# Copy hooks from local repo
# Run from local machine:
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r deploy/hooks/* ${SSH_USER}@${VPS1_IP}:/tmp/deploy-hooks/

# Move into place with correct ownership
sudo cp -r /tmp/deploy-hooks/* /home/openclaw/openclaw/deploy/hooks/
sudo chown -R openclaw:openclaw /home/openclaw/openclaw/deploy/hooks/
rm -rf /tmp/deploy-hooks
```

To add a new hook: create `deploy/hooks/<name>/` with HOOK.md + handler.js, add an entry to `openclaw.json` under `hooks.internal.entries`, SCP to VPS, restart.

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

# 1. Check all 3 images exist (claude sandbox removed — tools are in common via sandbox-toolkit.yaml)
for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-common:bookworm-slim \
           openclaw-sandbox-browser:bookworm-slim; do
  if sudo docker exec openclaw-gateway docker image inspect "$img" > /dev/null 2>&1; then
    echo "  $img: EXISTS"
  else
    echo "  $img: MISSING"
    FAILED=1
  fi
done

# 2. Security check: verify USER is 1000 (not root) on common image
for img in openclaw-sandbox-common:bookworm-slim; do
  USER=$(sudo docker exec openclaw-gateway docker image inspect "$img" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null)
  if [ "$USER" = "1000" ]; then
    echo "  $img USER: 1000 (OK)"
  else
    echo "  $img USER: $USER (EXPECTED 1000)"
    FAILED=1
  fi
done

# 3. Test key binaries in common sandbox (all tools from sandbox-toolkit.yaml)
for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert claude gifgrep; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  common/$bin: OK"
  else
    echo "  common/$bin: MISSING"
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

**Expected:** All 3 images exist (base, common, browser), USER is 1000 on common, all binaries present including custom tools from `sandbox-toolkit.yaml` (claude, gifgrep). If verification fails, check entrypoint logs for ERROR messages.

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
