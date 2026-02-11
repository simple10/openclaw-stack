#!/bin/bash
# Build OpenClaw with auto-patching for upstream issues.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   2. attempt.ts: enable systemPrompt in before_agent_start hook (for skill-router plugin)
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

# ── 2. Patch attempt.ts to support systemPrompt in before_agent_start hook ──
# The hook type and merge function already handle systemPrompt, but the runner
# only checks prependContext. This enables plugins to modify the full prompt.
ATTEMPT_FILE="src/agents/pi-embedded-runner/run/attempt.ts"
if [ -f "$ATTEMPT_FILE" ] && ! grep -q 'hookResult?.systemPrompt' "$ATTEMPT_FILE"; then
  echo "[build] Patching attempt.ts for systemPrompt support..."
  sed -i 's/if (hookResult?.prependContext) {/if (hookResult?.systemPrompt) {\n              effectivePrompt = hookResult.systemPrompt;\n              log.debug(`hooks: replaced system prompt via systemPrompt (${hookResult.systemPrompt.length} chars)`);\n            } else if (hookResult?.prependContext) {/' "$ATTEMPT_FILE"
else
  echo "[build] attempt.ts already supports systemPrompt (already patched or upstream fix)"
fi

# ── 3. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 4. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile "$ATTEMPT_FILE" 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
