#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
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
