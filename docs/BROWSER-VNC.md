# Browser VNC Access

View and control agent browser sessions remotely via noVNC (browser-based VNC client) through the Cloudflare Tunnel.

## Architecture

```
User browser → Cloudflare Edge → Tunnel → cloudflared (VPS host)
  → localhost:6090 → gateway:6090 (novnc-proxy.mjs)
    → reads browsers.json → 127.0.0.1:<noVncPort> (browser container)
```

Browser sandbox containers run inside the gateway's nested Docker (Sysbox DinD). Each browser container serves noVNC on port 6080, Docker-mapped to a random host port inside the gateway container. The noVNC reverse proxy (`deploy/novnc-proxy.mjs`) runs inside the gateway and routes requests to the correct browser container based on dynamic port mappings.

### How Port Discovery Works

The gateway tracks browser containers in `~/.openclaw/sandbox/browsers.json`:

```json
{
  "entries": [
    {
      "containerName": "openclaw-sbx-browser-agent-main-...",
      "sessionKey": "agent:main",
      "cdpPort": 32768,
      "noVncPort": 32769
    },
    {
      "containerName": "openclaw-sbx-browser-agent-skills-...",
      "sessionKey": "agent:skills",
      "cdpPort": 32770,
      "noVncPort": 32771
    }
  ]
}
```

The proxy reads this file on every request (no caching needed — the file is tiny). New entries appear when agents spawn browser containers for the first time.

## URL Routing

| URL | Behavior |
|-----|----------|
| `/` | Index page listing active browser sessions with live status |
| `/<agent-id>/` | Redirects to `/<agent-id>/vnc.html?path=<agent-id>/websockify` |
| `/<agent-id>/vnc.html?path=<agent-id>/websockify` | noVNC client (proxied from browser container) |
| `/<agent-id>/*` | HTTP proxy to browser container's noVNC static files |
| `/<agent-id>/websockify` (WebSocket) | VNC stream proxy |

The `?path=<agent-id>/websockify` query parameter is critical — it tells the noVNC client to connect the WebSocket through the proxy's prefixed path rather than the root `/websockify`.

**Example:** `https://browser-openclaw.ventureunknown.com/main/vnc.html?path=main/websockify`

## Components

### `deploy/novnc-proxy.mjs`

Node.js reverse proxy (~160 lines, zero dependencies — built-in `http` module only). Handles:

- **HTTP proxying**: pipes request/response streams to the backend noVNC server
- **WebSocket proxying**: handles `upgrade` events, creates TCP socket to backend, pipes both directions
- **Health checking**: TCP probes each container's noVNC port before proxying; shows friendly HTML error page if the container is down (avoids Cloudflare intercepting 502 errors)
- **Index page**: lists all registered sessions with live up/down status indicators, auto-refreshes every 10 seconds

### `deploy/entrypoint-gateway.sh` (Phase 2b)

Starts the proxy as a background process before gosu drops privileges:

```bash
NOVNC_PROXY="/app/deploy/novnc-proxy.mjs"
if [ -f "$NOVNC_PROXY" ]; then
  node "$NOVNC_PROXY" &
fi
```

### `deploy/docker-compose.override.yml`

- Port mapping: `127.0.0.1:6090:6090` (localhost-only for tunnel access)
- Volume: `./deploy/novnc-proxy.mjs:/app/deploy/novnc-proxy.mjs:ro`

### Cloudflare Tunnel Route

Public hostname on the existing `openclaw` tunnel:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| `browser-openclaw` (or your choice) | `yourdomain.com` | `http://localhost:6090` |

No new tunnel needed — just add a public hostname to the existing tunnel in the Dashboard.

## Container Lifecycle

Browser containers are **started on-demand** when an agent uses the browser tool and persist across agent turns within a session. They are **stopped** when:

- The gateway container restarts (`docker compose down/up`)
- The session ends

After a restart, `browsers.json` may still list stopped containers. The index page shows their status as "Stopped" with a red indicator, and clicking them shows a friendly "Browser Not Running" page instead of an error.

Each agent gets its own isolated browser container with separate:
- Chrome user data directory
- CDP port
- noVNC port
- Browser profiles

This avoids the concurrency problems of a shared browser sidecar approach.

## Setup

### Prerequisites

- Gateway deployed with Sysbox (Docker-in-Docker)
- Cloudflare Tunnel connected
- `deploy/novnc-proxy.mjs` bind-mounted into the gateway container

### Adding the Tunnel Route

1. Go to **Cloudflare Dashboard** → **Zero Trust** → **Networks** → **Tunnels**
2. Click your tunnel → **Configure** → **Public Hostname** tab
3. Add a new public hostname:
   - Subdomain: `browser-openclaw` (or your preference)
   - Domain: your domain
   - Service: `http://localhost:6090`
4. (Optional) Add a Cloudflare Access policy to restrict who can view browser sessions

### Verification

```bash
# Proxy is listening
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/

# After a browser task runs, check session routing
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/main/vnc.html

# External access via tunnel
curl -s https://browser-openclaw.yourdomain.com/
```

## Troubleshooting

### "Browser Not Running" page

The browser container isn't active. Send a browser task to the agent to start it, then refresh.

### noVNC loads but "Failed to connect to server"

The noVNC WebSocket path is wrong. Ensure the URL includes `?path=<agent-id>/websockify`. The index page links include this automatically.

### Bad Gateway (Cloudflare error page)

The proxy is returning a 5xx status. Check gateway logs:

```bash
sudo docker logs openclaw-gateway 2>&1 | grep novnc
```

### Proxy not starting

Check that `novnc-proxy.mjs` is bind-mounted and the entrypoint reached Phase 2b:

```bash
sudo docker exec openclaw-gateway ls -la /app/deploy/novnc-proxy.mjs
sudo docker logs openclaw-gateway 2>&1 | grep "noVNC proxy"
```
