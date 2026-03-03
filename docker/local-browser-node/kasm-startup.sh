#!/bin/bash
# Custom startup script for the Kasm desktop container.
# Runs after the desktop environment is ready.

# Kasm desktop includes Google Chrome at /opt/google/chrome/google-chrome
CHROMIUM_PATH="/opt/google/chrome/google-chrome"

# Write OpenClaw config
mkdir -p "$HOME/.openclaw"
cat > "$HOME/.openclaw/openclaw.json" << OCEOF
{
  "browser": {
    "enabled": true,
    "headless": false,
    "noSandbox": true,
    "executablePath": "$CHROMIUM_PATH"
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

# Launch Chromium on the desktop so user can log into websites via KasmVNC
echo "[browser-node] Launching Chromium on desktop"
/usr/bin/google-chrome --start-maximized &
sleep 1

# Start OpenClaw node host in background (Kasm manages the desktop lifecycle)
echo "[browser-node] Starting node host → 127.0.0.1:18789"
node /app/openclaw.mjs node run \
  --host 127.0.0.1 \
  --port 18789 \
  --display-name "${NODE_DISPLAY_NAME:-local-browser-node}" &

# Keep script alive so Kasm doesn't report "Unknown Service: custom_startup"
wait
