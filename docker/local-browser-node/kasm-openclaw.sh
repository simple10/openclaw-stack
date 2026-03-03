#!/bin/bash
# OpenClaw node host startup for Kasm containers.
# Writes config, starts ws-proxy, and runs the node host.
# Chromium is managed by Kasm's own custom_startup.sh.

# Write OpenClaw config
mkdir -p "$HOME/.openclaw"
cat > "$HOME/.openclaw/openclaw.json" << 'OCEOF'
{
  "browser": {
    "enabled": true,
    "headless": false,
    "noSandbox": true,
    "executablePath": "/usr/bin/chromium"
  },
  "gateway": {
    "mode": "remote"
  }
}
OCEOF

# Start CF Access WebSocket proxy in background
if [ -n "${GATEWAY_DOMAIN:-}" ]; then
  echo "[browser-node] Starting WS proxy → wss://${GATEWAY_DOMAIN}"
  node /app/ws-proxy.mjs &
  sleep 0.5
fi

# Start OpenClaw node host (blocks)
echo "[browser-node] Starting node host → 127.0.0.1:18789"
exec node /app/openclaw.mjs node run \
  --host 127.0.0.1 \
  --port 18789 \
  --display-name "${NODE_DISPLAY_NAME:-local-browser-node}"
