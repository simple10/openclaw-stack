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

## URL Configuration

The browser VNC URL is configured via two variables in `openclaw-config.env`:

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENCLAW_BROWSER_DOMAIN` | Browser VNC hostname | `openclaw.example.com` |
| `OPENCLAW_BROWSER_DOMAIN_PATH` | noVNC proxy base path | `/browser` (or empty for subdomain) |

| Setup | Domain | Path | `NOVNC_BASE_PATH` |
|-------|--------|------|-------------------|
| **Subpath on main domain** | `openclaw.example.com` | `/browser` | `/browser` |
| **Separate subdomain** | `browser-openclaw.example.com` | *(empty)* | *(empty)* |

`OPENCLAW_BROWSER_DOMAIN_PATH` is passed directly to the noVNC proxy as `NOVNC_BASE_PATH` — no parsing needed. The proxy strips this prefix from incoming requests and includes it in all generated URLs.

**Auto-detection fallback:** If `NOVNC_BASE_PATH` is empty but Cloudflare Tunnel sends requests with a path prefix (e.g., `/browser/...`), the proxy auto-detects the base path from the first unrecognized path segment. This prevents browser sessions from breaking if the env var is misconfigured. A log message indicates auto-detection occurred.

## URL Routing

All paths below are relative to `NOVNC_BASE_PATH` (empty = root):

| URL (without base path) | Behavior |
|-----|----------|
| `/` | Index page listing active browser sessions with live status |
| `/media/` | Directory listing of agent media files |
| `/<agent-id>/` | Redirects to noVNC client |
| `/<agent-id>/vnc.html?path=...` | noVNC client (proxied from browser container) |
| `/<agent-id>/*` | HTTP proxy to browser container's noVNC static files |
| `/<agent-id>/websockify` (WebSocket) | VNC stream proxy |

The `?path=` query parameter tells the noVNC client where to connect the WebSocket. It includes the base path when set.

**Examples:**
- Subdomain: `https://browser-openclaw.example.com/main/vnc.html?path=main/websockify`
- Subpath: `https://openclaw.example.com/browser/main/vnc.html?path=browser/main/websockify`

## Components

### `deploy/novnc-proxy.mjs`

Node.js reverse proxy (zero dependencies — built-in `http` module only). Reads `NOVNC_BASE_PATH` env var for subpath-aware routing. Handles:

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
- Environment: `NOVNC_BASE_PATH=${NOVNC_BASE_PATH:-}` (set from `OPENCLAW_BROWSER_DOMAIN_PATH`)

### Cloudflare Tunnel Route

Add a route on the existing `openclaw` tunnel. Two approaches:

**Option A: Separate subdomain** (e.g., `browser-openclaw.yourdomain.com`)

| Subdomain | Domain | Path | Service |
|-----------|--------|------|---------|
| `browser-openclaw` | `yourdomain.com` | *(empty)* | `http://localhost:6090` |

Set `OPENCLAW_BROWSER_DOMAIN=browser-openclaw.yourdomain.com` and `OPENCLAW_BROWSER_DOMAIN_PATH=` (empty → `NOVNC_BASE_PATH` is empty).

**Option B: Subpath on main domain** (e.g., `openclaw.yourdomain.com/browser`)

| Subdomain | Domain | Path | Service |
|-----------|--------|------|---------|
| `openclaw` | `yourdomain.com` | `/browser` | `http://localhost:6090` |

Set `OPENCLAW_BROWSER_DOMAIN=openclaw.yourdomain.com` and `OPENCLAW_BROWSER_DOMAIN_PATH=/browser` (→ `NOVNC_BASE_PATH=/browser`).

No new tunnel needed — just add a public hostname to the existing tunnel in the Dashboard.

## Security

### Cloudflare Access JWT Verification

Every request to the noVNC proxy (HTTP and WebSocket) must carry a valid `Cf-Access-Jwt-Assertion` header. The proxy verifies:

- **Signature**: cryptographically verified against Cloudflare's published public keys (fetched from the issuer's `/cdn-cgi/access/certs` endpoint, cached 1 hour)
- **Expiration**: rejected if `exp` claim is in the past
- **Issuer**: must be a `*.cloudflareaccess.com` domain
- **Audience** (optional): if `CF_ACCESS_AUD` is set, the JWT's `aud` claim must match

Requests without a valid JWT get a 403 page. WebSocket upgrades without a valid JWT are silently destroyed.

### Audience Verification (`CF_ACCESS_AUD`)

Each Cloudflare Access application has a unique **Application Audience (AUD) tag**. Setting `CF_ACCESS_AUD` on the noVNC proxy ensures it only accepts JWTs issued for that specific application.

**When to use it:** Multi-instance setups where multiple OpenClaw deployments share a Cloudflare account. Without audience verification, a user authenticated for Instance A could access Instance B's browser sessions if Cloudflare Access path rules are misconfigured. The audience check provides defense-in-depth against upstream misconfiguration.

**How to configure:**

1. Find your AUD tag: **Cloudflare Dashboard** > **Zero Trust** > **Access** > **Applications** > your app > **Overview** > **Application Audience (AUD) Tag**
2. Add `CF_ACCESS_AUD` to the gateway's environment in `docker-compose.override.yml`:

```yaml
environment:
  - CF_ACCESS_AUD=<your-application-aud-tag>
```

3. Restart the gateway (`docker compose up -d`)

For single-instance deployments behind a properly configured Cloudflare Access application, the JWT signature and issuer checks alone provide sufficient protection.

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
3. Add a new public hostname pointing to `http://localhost:6090` (see "Cloudflare Tunnel Route" above for subdomain vs subpath options)
4. Add a Cloudflare Access policy to restrict who can view browser sessions
5. Set `OPENCLAW_BROWSER_DOMAIN` and `OPENCLAW_BROWSER_DOMAIN_PATH` in `openclaw-config.env` to match your chosen URL

### Verification

```bash
# Proxy is listening (use base path if configured)
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/
# Or with base path:
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/browser/

# Check startup log for base path
sudo docker logs openclaw-gateway 2>&1 | grep 'novnc-proxy'

# After a browser task runs, check session routing
sudo docker exec openclaw-gateway curl -s http://127.0.0.1:6090/browser/main/vnc.html

# External access via tunnel
curl -s https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/
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
