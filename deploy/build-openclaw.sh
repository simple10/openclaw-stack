#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   2. Dockerfile: clear build-time jiti cache (belt-and-suspenders with entrypoint §2c)
#   3. docker.ts: apply sandbox env vars (docker.env) to container creation
#   4. .dockerignore: exclude local runtime dirs (data/, deploy/) from build context
#   5. .git-info: snapshot recent commit history for stats dashboard git log panel
#
# Usage: sudo -u openclaw ${INSTALL_DIR}/scripts/build-openclaw.sh
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"
cd "${INSTALL_DIR}/openclaw"

# ── 1. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
# docker.io includes: docker CLI, dockerd, containerd, runc
# gosu: drop-in replacement for su/sudo that doesn't spawn subshell (proper PID 1 signal handling)
# usermod: add node user to docker group for socket access after privilege drop
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  # Insert before first USER node so it runs as root (0, address stops at first match)
  # Single line to avoid sed multiline continuation issues in Dockerfile
  sed -i '0,/^USER node/{/^USER node/i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu && usermod -aG docker node && rm -rf /var/lib/apt/lists/*
}' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
fi

# ── 2. Patch Dockerfile to clear build-time jiti cache ──
# pnpm build compiles TypeScript via jiti, caching to /tmp/jiti/ as root.
# Belt-and-suspenders: entrypoint-gateway.sh §2c redirects TMPDIR at runtime,
# but clearing build-time cache keeps the image clean.
if ! grep -q 'rm.*tmp/jiti' Dockerfile; then
  echo "[build] Patching Dockerfile: clear jiti cache after build..."
  sed -i '/^RUN pnpm build/a RUN rm -rf /tmp/jiti' Dockerfile
else
  echo "[build] Dockerfile jiti patch already present"
fi

# ── 3. Patch docker.ts to apply env vars from sandbox config ──
# The config resolver (config.ts) computes merged env but docker.ts never
# passes -e flags to docker create. This adds the missing loop.
DOCKER_FILE="src/agents/sandbox/docker.ts"
if [ -f "$DOCKER_FILE" ] && ! grep -q 'params.cfg.env' "$DOCKER_FILE"; then
  echo "[build] Patching docker.ts to apply sandbox env vars..."
  sed -i '/^  return args;$/i\  if (params.cfg.env) {\n    for (const [key, value] of Object.entries(params.cfg.env)) {\n      if (key && value !== undefined) {\n        args.push("-e", `${key}=${value}`);\n      }\n    }\n  }' "$DOCKER_FILE"
else
  echo "[build] docker.ts already applies env vars (already patched or upstream fix)"
fi

# ── 4. Exclude local runtime dirs from build context ─────────────────
# data/ (persistent nested Docker storage) and deploy/ (our bind-mounted files)
# are not in the upstream .dockerignore but exist in our project directory.
# data/docker has root-owned files from Sysbox that cause permission errors.
if ! grep -q '^data/' .dockerignore; then
  echo "[build] Patching .dockerignore to exclude data/ and deploy/..."
  printf '\n# Local runtime dirs (not part of upstream)\ndata/\ndeploy/\nscripts/entrypoint-gateway.sh\n' >> .dockerignore
else
  echo "[build] .dockerignore already excludes data/"
fi

# ── 5. Generate git info for stats dashboard ─────────────────────────
# Snapshot recent commit history so the stats dashboard can show what
# version is running. COPY . . picks this up; cleaned after build.
echo "[build] Generating .git-info..."
git log --format='%h%x09%s%x09%aI' -50 > .git-info

# ── Build image ──────────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 6. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile "$DOCKER_FILE" .dockerignore 2>/dev/null || true
rm -f .git-info

echo "[build] Done. Run: docker compose up -d"
