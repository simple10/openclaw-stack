#!/bin/bash
set -euo pipefail

# ── OpenClaw config ────────────────────────────────────────────
mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/openclaw.json << 'OCEOF'
{
  "browser": {
    "enabled": true,
    "headless": true,
    "noSandbox": true,
    "executablePath": "/usr/bin/chromium"
  },
  "gateway": {
    "mode": "remote"
  }
}
OCEOF

# ── CF Access WebSocket proxy ──────────────────────────────────
if [ -n "${GATEWAY_DOMAIN:-}" ]; then
  echo "[browser-node] Starting WS proxy → wss://${GATEWAY_DOMAIN}"
  node /opt/ws-proxy/ws-proxy.mjs &
  sleep 0.5
fi

# ── Start node host ───────────────────────────────────────────
echo "[browser-node] Starting node host → 127.0.0.1:18789"
openclaw node run \
  --host 127.0.0.1 \
  --port 18789 \
  --display-name "${NODE_DISPLAY_NAME:-local-browser-node}"
