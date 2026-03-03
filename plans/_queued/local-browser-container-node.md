# Plan: Local Browser Node for VPS Gateway (Option J)

## Context

The VPS main agent (running as non-main) can't use a browser because:

- Sandbox mode `"non-main"` excludes the main session from getting a sandbox browser
- No Chrome is installed in the host container for the "host browser" path
- The sandbox browser lifecycle is fundamentally tied to sandboxed sessions

**Option J**: Run a local Docker container on Joe's Mac that acts as an OpenClaw **node host** with a browser. The VPS gateway's main agent auto-routes browser tool calls to this node via the existing node browser proxy system.

**Key discoveries that simplify this:**

- Nodes connect **outbound** over WebSocket — no cloudflared or inbound ports needed locally
- Authenticating with `OPENCLAW_GATEWAY_TOKEN` **skips the pairing dance** entirely (auth happens at WebSocket handshake)
- The node host uses the managed browser profile directly (`invoke-browser.ts` → `control-service.ts` → `launchOpenClawChrome`) — no Chrome extension needed
- Gateway `nodes.browser.mode` defaults to `"auto"`, so once the node connects with `browser` capability, the main agent's browser tool auto-routes to it

## Files to Create

All under `docker/local-browser-node/`:

### 1. `docker/local-browser-node/.env.example`

```env
# Gateway connection (wss:// required for non-loopback)
GATEWAY_HOST=openclaw.example.com
GATEWAY_PORT=443
OPENCLAW_GATEWAY_TOKEN=your-gateway-token-here

# Node identity
NODE_DISPLAY_NAME=joes-mac-browser

# OpenClaw version to build (stable = latest release tag, latest = main branch)
OPENCLAW_VERSION=stable
```

### 2. `docker/local-browser-node/Dockerfile`

Self-contained — clones OpenClaw from GitHub, checks out the requested version, builds with browser support. Mirrors the VPS `build-openclaw.sh` pattern.

```dockerfile
FROM node:22-bookworm

# Chromium + deps for headless browser
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    chromium git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Clone OpenClaw and checkout version
ARG OPENCLAW_VERSION=stable
WORKDIR /tmp/openclaw-src
RUN git clone --depth=50 https://github.com/openclaw/openclaw.git . && \
    git fetch --tags --force && \
    if [ "$OPENCLAW_VERSION" = "stable" ]; then \
      TAG=$(git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -1) && \
      git checkout "$TAG"; \
    elif [ "$OPENCLAW_VERSION" = "latest" ]; then \
      true; \
    else \
      git checkout "$OPENCLAW_VERSION"; \
    fi

# Install deps & build
WORKDIR /app
RUN cp /tmp/openclaw-src/package.json /tmp/openclaw-src/pnpm-lock.yaml \
       /tmp/openclaw-src/pnpm-workspace.yaml /tmp/openclaw-src/.npmrc ./
RUN mkdir -p ui && cp /tmp/openclaw-src/ui/package.json ./ui/
RUN cp -r /tmp/openclaw-src/patches ./patches
RUN cp -r /tmp/openclaw-src/scripts ./scripts

RUN chown -R node:node /app
USER node
RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

USER root
RUN cp -r /tmp/openclaw-src/* /tmp/openclaw-src/.* /app/ 2>/dev/null || true
RUN chown -R node:node /app && rm -rf /tmp/openclaw-src

USER node
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw && chmod 755 /app/openclaw.mjs

ENV NODE_ENV=production
USER node
```

### 3. `docker/local-browser-node/entrypoint.sh`

Writes browser config then starts the node host.

```bash
#!/bin/bash
set -euo pipefail

# Write openclaw.json config for browser support
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

echo "[browser-node] Starting node host → ${GATEWAY_HOST}:${GATEWAY_PORT:-443}"
exec node /app/openclaw.mjs node run \
  --host "${GATEWAY_HOST}" \
  --port "${GATEWAY_PORT:-443}" \
  --tls \
  --display-name "${NODE_DISPLAY_NAME:-joes-mac-browser}"
```

### 4. `docker/local-browser-node/docker-compose.yml`

```yaml
services:
  browser-node:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        OPENCLAW_VERSION: ${OPENCLAW_VERSION:-stable}
    container_name: openclaw-browser-node
    entrypoint: ["/bin/bash", "/app/local-browser-node/entrypoint.sh"]
    env_file: .env
    environment:
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GATEWAY_HOST=${GATEWAY_HOST}
      - GATEWAY_PORT=${GATEWAY_PORT:-443}
      - NODE_DISPLAY_NAME=${NODE_DISPLAY_NAME:-joes-mac-browser}
    volumes:
      - ./entrypoint.sh:/app/local-browser-node/entrypoint.sh:ro
      - node-data:/home/node/.openclaw
    restart: unless-stopped
    shm_size: '2gb'

volumes:
  node-data:
```

### 5. VPS Config — No Changes Needed

`gateway.nodes.browser.mode` defaults to `"auto"`, which auto-routes browser tool calls to any connected node with `browser` capability. No VPS config changes required.

## How It Works

1. `cd docker/local-browser-node && cp .env.example .env` → fill in gateway host/token
2. `docker compose up -d` — builds image (clones OpenClaw, installs Chromium), starts container
3. Entrypoint writes `openclaw.json` with `browser.enabled: true, headless: true, noSandbox: true`
4. `openclaw node run --host <gateway> --port 443 --tls` connects via `wss://` to VPS gateway
5. Gateway token auth succeeds → node registered with `caps: ["system", "browser"]`
6. VPS main agent's browser tool auto-discovers the node (`resolveBrowserNodeTarget()`)
7. Browser actions: main agent → `node.invoke` → `browser.proxy` → node's `runBrowserProxyCommand()` → headless Chromium → result back

**Source code flow:**

- `src/node-host/runner.ts:144` — `runNodeHost()` builds GatewayClient with browser caps
- `src/node-host/runner.ts:165-166` — browser proxy enabled when `browser.enabled && nodeHost.browserProxy.enabled !== false`
- `src/node-host/invoke-browser.ts:122` — `runBrowserProxyCommand()` dispatches to browser control service
- `src/agents/tools/browser-tool.ts:111-127` — `resolveBrowserNodeTarget()` finds connected browser nodes
- `src/browser/control-service.ts:23` — `startBrowserControlServiceFromConfig()` launches Chromium on first use

## Key Design Decisions

- **No cloudflared locally** — node initiates outbound WebSocket, all comms over that single connection
- **No Chrome extension** — uses managed browser profile (OpenClaw auto-launches headless Chromium)
- **No pairing step** — `OPENCLAW_GATEWAY_TOKEN` authenticates at WebSocket handshake level
- **Git clone in Dockerfile** — self-contained, doesn't depend on local source checkout
- **`gateway.mode: "remote"`** — tells node to read token from `OPENCLAW_GATEWAY_TOKEN` env var
- **`shm_size: 2gb`** — Chromium needs shared memory for rendering
- **Named volume for state** — `node-data` persists node identity across restarts

## Verification

1. Build & start: `docker compose up --build`
2. Check connection: logs should show `node host gateway connect` success
3. On VPS: `openclaw nodes status` — should list the node with `browser` capability
4. Test: ask main agent to browse a URL — should work via node proxy
5. Logs: `docker compose logs -f` to watch browser proxy requests flow

## Caveats

- **Latency**: browser actions route Mac → CF → VPS → CF → Mac → Chromium → back. Higher latency than local
- **Mac must be running**: browser only available while container is up
- **First build**: ~5 min (git clone + pnpm install + build + Chromium)
- **Rebuilds**: use `docker compose build --no-cache` to pick up new OpenClaw versions
- **Chromium memory**: ~200-400MB per tab on top of container overhead
