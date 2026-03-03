#!/bin/bash
set -euo pipefail

# ── Port scheme ──────────────────────────────────────────────
# OpenClaw hardcodes relay + gateway to 127.0.0.1. Docker port mapping
# needs 0.0.0.0, so socat bridges the gap on separate ports.
#   Gateway:  127.0.0.1:28790  →  socat 0.0.0.0:28790  →  Docker :28790
#   Relay:    127.0.0.1:28793  →  socat 0.0.0.0:28793  →  Docker :28793
# Set the Chrome extension's relay port to 28793 to match.
# (Extension HMAC token includes the port, so both sides must agree.)

# ── OpenClaw config (extension relay mode) ───────────────────
mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/openclaw.json << OCEOF
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "defaultProfile": "chrome",
    "profiles": {
      "chrome": {
        "driver": "extension",
        "cdpPort": 28793,
        "color": "#00AA00"
      }
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  }
}
OCEOF

# ── Install Chrome extension to bind-mounted data dir ────────
echo "[extension-node] Installing Chrome extension"
openclaw browser extension install 2>/dev/null || \
  echo "[extension-node] Extension install skipped (may already exist)"

# ── CF Access WebSocket proxy ────────────────────────────────
if [ -n "${GATEWAY_DOMAIN:-}" ]; then
  echo "[extension-node] Starting WS proxy on :18789 → wss://${GATEWAY_DOMAIN}"
  node /opt/ws-proxy/ws-proxy.mjs &
  sleep 0.5
fi

# ── Start local gateway (loopback) ───────────────────────────
echo "[extension-node] Starting local gateway (relay on :28793)"
openclaw gateway run --port 28790 --bind loopback --verbose &
GATEWAY_PID=$!

# Wait for gateway to bind before starting socat (socat on 0.0.0.0 must come
# AFTER 127.0.0.1 bind, otherwise the wildcard bind blocks the specific one).
echo "[extension-node] Waiting for gateway to start..."
for i in $(seq 1 30); do
  # 7076=28790 (gateway), 7079=28793 (relay)
  if grep -q ':7079 ' /proc/net/tcp 2>/dev/null; then
    echo "[extension-node] Gateway + relay are listening (took ${i}s)"
    break
  fi
  sleep 1
done

# ── socat: bridge eth0 → 127.0.0.1 for Docker port mapping ──
# Bind to the container's eth0 IP (not 0.0.0.0, which conflicts with loopback binds).
CONTAINER_IP=$(hostname -I | awk '{print $1}')
echo "[extension-node] Starting socat forwarders (${CONTAINER_IP} → 127.0.0.1)"
socat TCP-LISTEN:28790,fork,bind="${CONTAINER_IP}",reuseaddr TCP:127.0.0.1:28790 &
socat TCP-LISTEN:28793,fork,bind="${CONTAINER_IP}",reuseaddr TCP:127.0.0.1:28793 &

# ── Connect to remote VPS gateway as a node ──────────────────
if [ -n "${GATEWAY_DOMAIN:-}" ]; then
  echo "[extension-node] Connecting node host to remote gateway via ws-proxy"
  openclaw node run \
    --host 127.0.0.1 \
    --port 18789 \
    --display-name "${NODE_DISPLAY_NAME:-local-extension-node}" &
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  EXTENSION RELAY READY                                      ║"
echo "║                                                              ║"
echo "║  Relay port:     28793                                       ║"
echo "║  Gateway token:  ${OPENCLAW_GATEWAY_TOKEN}"
echo "║                                                              ║"
echo "║  1. Load extension from: ./data/openclaw/browser/chrome-extension/"
echo "║  2. Click extension icon → set port to 28793                 ║"
echo "║  3. Paste the gateway token above                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Wait for gateway (main process)
wait $GATEWAY_PID
