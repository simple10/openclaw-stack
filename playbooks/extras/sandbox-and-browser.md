# Sandbox & Browser Extras

Add rich sandbox (Node.js, git, dev tools, ffmpeg, imagemagick, Claude Code CLI), browser support (Chromium + noVNC), and sandbox/browser config to the OpenClaw gateway.

## Overview

This playbook configures:

- **Common sandbox image** — Pre-built `openclaw-sandbox-common:bookworm-slim` with Node.js, git, and dev tools (replaces minimal default for agent tasks)
- **Browser sandbox image** — `openclaw-sandbox-browser:bookworm-slim` with Chromium and noVNC for web browsing tasks, viewable through the Control UI
- **Claude sandbox image** — `openclaw-sandbox-claude:bookworm-slim` layered on common with ffmpeg, imagemagick, and Claude Code CLI (where agents actually run)
- **Config permissions fix** — Ensures `chmod 600` on `openclaw.json` every startup via entrypoint

## Prerequisites

- Base deployment complete (`02-07` playbooks)
- OpenClaw gateway running on VPS-1
- At least **2GB free disk space** on VPS-1 (sandbox images ~2GB inside nested Docker)

## Disk Space Check

```bash
#!/bin/bash
# Check available disk space on VPS-1 before proceeding
df -h /home/openclaw
# Expect at least 2GB free
# Common sandbox: ~500MB (inside nested Docker)
# Browser sandbox: ~800MB (inside nested Docker)
# Claude sandbox: ~700MB (common + ffmpeg + imagemagick + Claude Code CLI)
```

---

## E.1 Deploy Updated Build Script and Rebuild Gateway Image

The build script applies one patch:

- **Patch #1**: Installs `docker.io` + `gosu` for nested Docker daemon (sandbox isolation via Sysbox). Adds node user to docker group for socket access after privilege drop.

```bash
#!/bin/bash
# Deploy updated build script from local repo
# The script is maintained in build/build-openclaw.sh in this repo
# SCP it to VPS-1:
scp -P ${SSH_PORT} build/build-openclaw.sh ${SSH_USER}@${VPS1_IP}:/tmp/build-openclaw.sh

# On VPS-1: install and set permissions
sudo cp /tmp/build-openclaw.sh /home/openclaw/scripts/build-openclaw.sh
sudo chown openclaw:openclaw /home/openclaw/scripts/build-openclaw.sh
sudo chmod +x /home/openclaw/scripts/build-openclaw.sh

# Build the gateway image
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
```

The build will:

1. Apply patch #1 (auto-skips if already fixed upstream)
2. Install Docker + gosu for nested Docker (sandbox isolation)
3. Restore patched files to keep git tree clean

Expect the build to take 3-5 minutes. The `docker.io` package adds ~150MB to the image.

---

## E.2 Deploy Updated Entrypoint Script

The entrypoint script is defined in `04-vps1-openclaw.md` § 4.8c. It handles lock cleanup, permission fixes, dockerd startup, sandbox image builds (including the common sandbox fallback for the upstream `USER root` bug), and privilege drop via gosu.

If the entrypoint on VPS-1 is outdated, redeploy it from § 4.8c:

```bash
# Re-run the entrypoint creation from 04-vps1-openclaw.md § 4.8c
sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
```

---

## E.2a Update Docker Compose Override (Upgrade Only)

> **Skip this section for fresh deployments from current playbook 04.** The compose override in `04-vps1-openclaw.md` § 4.6 already includes `user: "0:0"`, `read_only: false`, `/var/log` tmpfs, and `.claude-sandbox` bind mount. This section is only needed when upgrading a pre-sandbox deployment.

```bash
#!/bin/bash
# Upgrade only — patches an existing compose override for sandbox support
COMPOSE_FILE="/home/openclaw/openclaw/docker-compose.override.yml"
sudo -u openclaw sed -i 's/user: "1000:1000"/user: "0:0"/' "$COMPOSE_FILE"
sudo -u openclaw sed -i 's/read_only: true/read_only: false/' "$COMPOSE_FILE"
sudo -u openclaw sed -i 's|/tmp:size=500M,mode=1777|/tmp:size=1G,mode=1777|' "$COMPOSE_FILE"
sudo -u openclaw sed -i '/\/run:size=100M,mode=755/a\      - /var/log:size=100M,mode=755' "$COMPOSE_FILE"
grep -q '/home/openclaw/.claude-sandbox' "$COMPOSE_FILE" || \
  sudo -u openclaw sed -i '/entrypoint-gateway.sh:ro/a\      - /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox' "$COMPOSE_FILE"
```

---

## E.3 Update openclaw.json with Sandbox and Browser Config

Re-run `04-vps1-openclaw.md` § 4.8 to regenerate `openclaw.json` — it already includes `agents` and `tools` blocks for sandbox/browser support. See [REQUIREMENTS.md § 3.7](../REQUIREMENTS.md#37-openclawjson-configuration) for design rationale.

> **Important:** This replaces the existing `openclaw.json`. The § 4.8 script preserves `trustedProxies` required for Cloudflare Tunnel.

```bash
#!/bin/bash
# Re-run section 4.8 from 04-vps1-openclaw.md, then fix permissions:
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
sudo chmod 600 /home/openclaw/.openclaw/openclaw.json
```

---

## E.4 Update Docker Compose Start Period (Upgrade Only)

> **Skip for fresh deployments.** `04-vps1-openclaw.md` § 4.6 already sets `start_period: 300s`.

```bash
#!/bin/bash
COMPOSE_FILE="/home/openclaw/openclaw/docker-compose.override.yml"
sudo -u openclaw sed -i 's/start_period: 120s.*/start_period: 300s  # Extended: first boot builds 3 sandbox images inside nested Docker/' "$COMPOSE_FILE"
```

---

## E.5 Restart Gateway and Monitor First Boot

```bash
#!/bin/bash
# Restart the gateway to pick up all changes
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway'

# Monitor the first boot — expect 3-5 minutes for all sandbox images to build
echo "Monitoring gateway startup (Ctrl+C to stop)..."
echo "First boot builds 4 images: openclaw-sandbox, openclaw-sandbox-common, openclaw-sandbox-browser, openclaw-sandbox-claude"
sudo docker logs -f openclaw-gateway 2>&1 | grep -E '\[entrypoint\]|\[sandbox\]|error|ERROR'
```

Wait for all four `"built successfully"` messages before proceeding to verification.

---

## Verification

```bash
#!/bin/bash
# 1. Check all 4 sandbox images exist inside the nested Docker
echo "=== Sandbox Images ==="
sudo docker exec openclaw-gateway docker images | grep -E 'openclaw-sandbox|REPOSITORY'

# 2. Check entrypoint bootstrap logs
echo ""
echo "=== Bootstrap Logs ==="
sudo docker logs openclaw-gateway 2>&1 | grep -i '\[entrypoint\]'

# 3. Verify claude sandbox has media tools + Claude Code CLI
echo ""
echo "=== Claude Sandbox Tools ==="
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim ffmpeg -version 2>&1 | head -1 && echo "  ffmpeg in claude-sandbox: OK" || echo "  ffmpeg in claude-sandbox: MISSING"
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim convert --version 2>&1 | head -1 && echo "  imagemagick in claude-sandbox: OK" || echo "  imagemagick in claude-sandbox: MISSING"
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim claude --version && echo "  claude in claude-sandbox: OK" || echo "  claude in claude-sandbox: MISSING"

# 4. Verify claude is NOT in gateway (stripped for minimal attack surface)
echo ""
echo "=== Gateway Minimality ==="
sudo docker exec openclaw-gateway which claude > /dev/null 2>&1 && echo "  UNEXPECTED: claude found in gateway" || echo "  claude NOT in gateway: OK (expected)"
sudo docker exec openclaw-gateway which ffmpeg > /dev/null 2>&1 && echo "  UNEXPECTED: ffmpeg found in gateway" || echo "  ffmpeg NOT in gateway: OK (expected)"
echo "common sandbox (should NOT have claude):"
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim which claude > /dev/null 2>&1 && echo "  UNEXPECTED: claude found in common" || echo "  claude NOT in common: OK"

# 5. Check openclaw.json permissions
echo ""
echo "=== Config Permissions ==="
sudo docker exec openclaw-gateway stat -c '%a' /home/node/.openclaw/openclaw.json
# Should return: 600

# 6. Check openclaw.json has agents config
echo ""
echo "=== Agents Config ==="
sudo docker exec openclaw-gateway cat /home/node/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
print('agents:', 'OK' if 'agents' in cfg else 'MISSING')
print('tools:', 'OK' if 'tools' in cfg else 'MISSING')
mode = cfg.get('agents', {}).get('defaults', {}).get('sandbox', {}).get('mode')
print('sandbox.mode:', mode)
print('browser enabled:', cfg.get('agents', {}).get('defaults', {}).get('sandbox', {}).get('browser', {}).get('enabled', False))
"

# 7. Verify gateway process runs as node (not root)
echo ""
echo "=== Process User ==="
sudo docker exec openclaw-gateway ps aux | grep "node dist/index.js"
# Should show: node (uid 1000), NOT root

# 8. Verify dockerd runs as root
echo ""
echo "=== Docker Daemon ==="
sudo docker exec openclaw-gateway ps aux | grep dockerd
# Should show: root

# 9. Docker socket accessible by gateway
echo ""
echo "=== Docker Socket ==="
sudo docker exec openclaw-gateway su -s /bin/sh node -c "docker info > /dev/null && echo 'socket OK'"
```

### Expected Output

```
=== Sandbox Images ===
REPOSITORY                    TAG              SIZE
openclaw-sandbox              bookworm-slim    ~150MB
openclaw-sandbox-common       bookworm-slim    ~500MB
openclaw-sandbox-claude       bookworm-slim    ~600MB
openclaw-sandbox-browser      bookworm-slim    ~800MB

=== Claude Sandbox Tools ===
  ffmpeg in claude-sandbox: OK
  imagemagick in claude-sandbox: OK
  claude in claude-sandbox: OK

=== Gateway Minimality ===
  claude NOT in gateway: OK (expected)
  ffmpeg NOT in gateway: OK (expected)
  claude NOT in common: OK

=== Config Permissions ===
600

=== Agents Config ===
agents: OK
tools: OK
browser enabled: True
```

---

## Troubleshooting

### Sandbox Images Not Building

```bash
# Check if nested Docker daemon is running
sudo docker exec openclaw-gateway docker info

# Check if setup scripts exist
sudo docker exec openclaw-gateway ls -la /app/scripts/sandbox-*.sh

# Manually trigger a build
sudo docker exec openclaw-gateway /app/scripts/sandbox-common-setup.sh
sudo docker exec openclaw-gateway /app/scripts/sandbox-browser-setup.sh
```

### Common Sandbox Build Fails with "Permission denied"

**Known upstream bug**: `sandbox-common-setup.sh` doesn't add `USER root` before `apt-get` in its Dockerfile heredoc. The base image `openclaw-sandbox:bookworm-slim` sets `USER sandbox`, so `apt-get update` fails with `Permission denied` on `/var/lib/apt/lists/partial`.

The entrypoint handles this automatically with a fallback that rebuilds with `USER root`. Check the logs for:
```
[entrypoint] WARNING: upstream script failed, rebuilding with USER root fix...
[entrypoint] Common sandbox image built (manual fallback)
```

If the fallback also fails, rebuild manually:
```bash
sudo docker exec openclaw-gateway bash -c "printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\nENV DEBIAN_FRONTEND=noninteractive\nRUN apt-get update && apt-get install -y --no-install-recommends curl wget jq coreutils grep nodejs npm python3 git ca-certificates unzip build-essential file && rm -rf /var/lib/apt/lists/*\nRUN npm install -g pnpm\nUSER 1000\n' | docker build -t openclaw-sandbox-common:bookworm-slim -"
```

**Note:** The fallback omits golang-go, rustc, cargo, bun, and homebrew (which the upstream script includes) to keep the build fast and reliable. These are rarely needed by agents. If needed, rebuild using the upstream script after fixing the `USER root` issue in a future OpenClaw release.

### Gateway Image Too Large

```bash
# Check image size
sudo -u openclaw docker images openclaw:local

# If disk is tight, remove old images
sudo -u openclaw docker image prune -f
```

### Claude Code CLI Not Found

```bash
# Check if Claude Code CLI is installed in the claude sandbox image
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim which claude
sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim claude --version

# Check if the claude sandbox image exists
sudo docker exec openclaw-gateway docker images | grep claude
```

### Browser Not Working

```bash
# Check browser sandbox image exists
sudo docker exec openclaw-gateway docker images | grep browser

# Check gateway logs for browser-related errors
sudo docker logs openclaw-gateway 2>&1 | grep -i browser

# Verify noVNC port is accessible (proxied through gateway on port 18789)
# The Control UI should show a browser viewer tab when a browser task is active
```

### Config Permissions Keep Drifting

The entrypoint fixes permissions on every startup. If you notice `600` drifting to `644` between restarts, the gateway is rewriting the file. The entrypoint fix handles this automatically — just restart the container.

```bash
# Manual fix if needed
sudo docker exec openclaw-gateway chmod 600 /home/node/.openclaw/openclaw.json
```
