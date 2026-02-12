# Plan: noVNC reverse proxy for browser sandbox viewing

## Context

Browser sandbox containers run inside the gateway's nested Docker (Sysbox DinD). Each browser container serves noVNC on port 6080, Docker-mapped to a random host port inside the gateway container. The dynamic port mappings are tracked in `~/.openclaw/sandbox/browsers.json`:

```json
{"entries": [
  {"containerName": "openclaw-sbx-browser-agent-main-...", "sessionKey": "agent:main", "cdpPort": 32768, "noVncPort": 32769},
  {"containerName": "openclaw-sbx-browser-agent-skills-...", "sessionKey": "agent:skills", "cdpPort": 32770, "noVncPort": 32771}
]}
```

Users need to view/control browser sessions (e.g., for website authentication) via the Cloudflare tunnel. The proxy must run inside the gateway container — the only place where browser containers are network-accessible.

New entries appear dynamically as agents spawn browser containers for the first time. The proxy handles this by reading `browsers.json` on each request (the file is tiny).

## Architecture

```
User browser → CF edge → tunnel → cloudflared (VPS host)
  → localhost:6090 → gateway:6090 (novnc-proxy.mjs)
    → reads browsers.json → 127.0.0.1:<noVncPort> (browser container)
```

## Changes

### 1. New file: `deploy/novnc-proxy.mjs`

Node.js reverse proxy (~120 lines, zero dependencies — built-in `http` module only).

URL routing:

- `GET /` → HTML index page listing active browser sessions
- `GET /<agent-id>/` → redirects to noVNC client (`/<agent-id>/vnc.html`)
- `GET /<agent-id>/*` → proxy to that agent's browser noVNC (strips prefix)
- WebSocket `/<agent-id>/websockify` → WebSocket proxy for VNC stream

Example: `/main/vnc.html` → lookup `agent:main` in browsers.json → `http://127.0.0.1:32769/vnc.html`

**Index page (`/`):** Simple HTML page that reads `browsers.json` and renders:

- Page title: "OpenClaw Browser Sessions"
- For each entry in `browsers.json`: a card/row showing the agent name (e.g., "main", "skills") with a clickable link to `/<agent-id>/vnc.html`
- If no browser sessions exist: a message like "No active browser sessions. Browser containers are created on-demand when agents use the browser tool."
- Auto-refreshes every 10 seconds (browser sessions may appear/disappear)

Key implementation details:

- Reads `/home/node/.openclaw/sandbox/browsers.json` on each request (no caching/watching needed)
- Parses `sessionKey` format `agent:<id>` — URL uses just `<id>` part
- HTTP proxy: pipes request/response streams
- WebSocket proxy: handles `upgrade` event, creates TCP socket to backend, pipes both directions
- Returns 404 with helpful message when agent has no browser session
- Listens on port 6090

### 2. Modify: `deploy/entrypoint-gateway.sh`

Add proxy startup after sandbox builds (Phase 2), before gosu exec (Phase 3). Insert between the `fi` closing the Docker daemon block and the Phase 3 comment:

```bash
# ── 2b. Start noVNC reverse proxy ────────────────────────────────────
# Exposes browser sandbox noVNC UIs on a fixed port. Reads browsers.json
# dynamically to discover sandbox browser containers and their mapped ports.
NOVNC_PROXY="/app/deploy/novnc-proxy.mjs"
if [ -f "$NOVNC_PROXY" ]; then
  node "$NOVNC_PROXY" &
  echo "[entrypoint] noVNC proxy started on port 6090"
fi
```

### 3. Modify: `deploy/docker-compose.override.yml`

Add to `openclaw-gateway` service:

**ports** (new section — gateway currently has no port mappings, cloudflared connects via Docker DNS):

```yaml
    ports:
      - "127.0.0.1:6090:6090"
```

**volumes** (add to existing list):

```yaml
      - ./deploy/novnc-proxy.mjs:/app/deploy/novnc-proxy.mjs:ro
```

### 4. Cloudflare tunnel route (manual — CF Dashboard)

In Cloudflare Dashboard → Zero Trust → Networks → Tunnels → `openclaw` → Public Hostname, add:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| browser-openclaw | ventureunknown.com | <http://localhost:6090> |

Optional: Add a Cloudflare Access policy to restrict who can view the browser sessions.

## Files summary

| File | Change |
|------|--------|
| `deploy/novnc-proxy.mjs` | **New** — reverse proxy script |
| `deploy/entrypoint-gateway.sh` | Start proxy in Phase 2 (~5 lines) |
| `deploy/docker-compose.override.yml` | Add port 6090 + bind mount |

## Deployment

1. SCP new/updated files to VPS
2. On VPS: `docker compose down && docker compose up -d`
3. Add public hostname in CF Dashboard (`browser-openclaw.ventureunknown.com` → `http://localhost:6090`)
4. Send a browser task via webchat to spawn a browser container
5. Open `https://browser-openclaw.ventureunknown.com/` — should show session index
6. Click a session link — noVNC should load and show the browser desktop

## Verification

```bash
# 1. Proxy is listening
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/

# 2. After a browser task runs, check session routing
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/main/

# 3. External access via tunnel
curl -s https://browser-openclaw.ventureunknown.com/
```
