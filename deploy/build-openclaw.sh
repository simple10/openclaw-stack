#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   2. docker.ts: apply sandbox env vars (docker.env) to container creation
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

# ── 2. Patch docker.ts to apply env vars from sandbox config ──
# The config resolver (config.ts) computes merged env but docker.ts never
# passes -e flags to docker create. This adds the missing loop.
DOCKER_FILE="src/agents/sandbox/docker.ts"
if [ -f "$DOCKER_FILE" ] && ! grep -q 'params.cfg.env' "$DOCKER_FILE"; then
  echo "[build] Patching docker.ts to apply sandbox env vars..."
  sed -i '/^  return args;$/i\  if (params.cfg.env) {\n    for (const [key, value] of Object.entries(params.cfg.env)) {\n      if (key && value !== undefined) {\n        args.push("-e", `${key}=${value}`);\n      }\n    }\n  }' "$DOCKER_FILE"
else
  echo "[build] docker.ts already applies env vars (already patched or upstream fix)"
fi

# ── Build image ──────────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 3. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile "$DOCKER_FILE" 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
