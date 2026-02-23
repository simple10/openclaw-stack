# Plan: Integrate ClawMetry into dashboard.mjs via Reverse Proxy

## Context

ClawMetry (`source/openclaw-dashboard/dashboard.py`) is a standalone Python/Flask observability dashboard for OpenClaw providing session transcripts, LLM cost tracking, real-time log streaming, memory/workspace browsing, cron status, and system health. We want to serve it through our existing `dashboard.mjs` system so it's accessible at `/dashboard/dashboard` (where `/dashboard` is the `DASHBOARD_BASE_PATH`, so the internal route after base path stripping is `/dashboard`).

**Core challenge**: ClawMetry has NO base path support. All frontend `fetch()` and `EventSource` calls use hardcoded absolute paths (`/api/logs`, `/api/health-stream`, etc.). Solved via monkey-patch injection (Step 5).

## Architecture

```
Browser → CF Tunnel → dashboard.mjs (:6090, inside gateway container)
                          │
                          ├── /              → index page (browser sessions)
                          ├── /media/*       → media file serving
                          ├── /browser/*     → noVNC proxy
                          └── /dashboard/*   → reverse proxy ──→ ClawMetry container
                                                                  (openclaw-clawmetry:8900)
                                                                  on openclaw-gateway-net
```

**ClawMetry runs as a separate Docker container** on `openclaw-gateway-net`. dashboard.mjs (inside the Sysbox gateway container) reaches it by container name. Both containers are on the same Docker network, so DNS resolution works.

**Data access**: ClawMetry reads OpenClaw data via read-only bind mounts from the host's `/home/openclaw/.openclaw/` directory. No gateway API needed — all primary data sources are filesystem-based.

**Auth flow**: CF Access JWT + device pairing checked by dashboard.mjs **before** routing — ClawMetry never sees unauthenticated requests. dashboard.mjs adds an internal auth token to proxied requests.

## Implementation Steps

### Step 1: Create ClawMetry Docker setup

Create `deploy/clawmetry/` with:

**`deploy/clawmetry/Dockerfile`**:

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY dashboard.py .
RUN pip install --no-cache-dir flask

EXPOSE 8900
USER 1000:1000

CMD ["python3", "dashboard.py", \
     "--port", "8900", \
     "--host", "0.0.0.0", \
     "--no-debug", \
     "--sse-max-seconds", "300"]
```

- Runs as uid 1000 to match file ownership (openclaw user on host, node user in gateway)
- Flask baked into image — no pip install at runtime
- `--host 0.0.0.0` so it's reachable from the Docker network (security provided by network isolation + auth token, not bind address)

**`deploy/clawmetry/dashboard.py`**: Copy from `source/openclaw-dashboard/dashboard.py`

### Step 2: Add ClawMetry service to docker-compose

Add to `deploy/docker-compose.override.yml`:

```yaml
  clawmetry:
    build:
      context: ./deploy/clawmetry
      dockerfile: Dockerfile
    container_name: openclaw-clawmetry
    restart: unless-stopped
    environment:
      - GATEWAY_TOKEN=${CLAWMETRY_TOKEN}
    volumes:
      # All read-only — ClawMetry only reads data
      - /home/openclaw/.openclaw:/data/.openclaw:ro
    command: >
      python3 dashboard.py
      --port 8900
      --host 0.0.0.0
      --data-dir /data/.openclaw
      --workspace /data/.openclaw/workspace
      --sessions-dir /data/.openclaw/agents/main/sessions
      --log-dir /data/.openclaw/logs
      --no-debug
      --sse-max-seconds 300
    networks:
      - openclaw-gateway-net
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: '0.25'
```

Key decisions:

- **Single bind mount**: `/home/openclaw/.openclaw` → `/data/.openclaw` (covers workspace, agents, logs, cron, config)
- **`CLAWMETRY_TOKEN`**: Set in VPS `.env` file — shared between ClawMetry (as `GATEWAY_TOKEN`) and dashboard.mjs (reads from env)
- **Resource limits**: 256MB RAM, 0.25 CPU — lightweight for a Flask app with in-memory data
- **No port mapping to host**: Only accessible on `openclaw-gateway-net`, not from outside

### Step 3: Generate and configure CLAWMETRY_TOKEN

Add `CLAWMETRY_TOKEN` to the VPS `.env` file (alongside existing gateway tokens):

```bash
# In deployment steps or entrypoint
CLAWMETRY_TOKEN=$(openssl rand -hex 32)
```

This token is:

- Passed to ClawMetry container as `GATEWAY_TOKEN` env var (ClawMetry's auth mechanism)
- Read by the gateway container so dashboard.mjs can add it to proxied requests
- Not exposed to the browser — stays server-side

Add to gateway service in docker-compose.override.yml environment:

```yaml
- CLAWMETRY_TOKEN=${CLAWMETRY_TOKEN}
```

### Step 4: Add proxy route to dashboard.mjs

Add a new route handler in `deploy/dashboard.mjs` for `/dashboard/*` (after base path stripping). Goes in the main request handler after the `/media` route and before the `/browser` route.

**Key file**: `deploy/dashboard.mjs` (route matching section, ~lines 885-898)

**Proxy implementation** (reuse patterns from existing noVNC HTTP proxy):

```javascript
// ── ClawMetry reverse proxy ──────────────────────────────────────────
const CLAWMETRY_HOST = 'openclaw-clawmetry'
const CLAWMETRY_PORT = 8900
const CLAWMETRY_TOKEN = process.env.CLAWMETRY_TOKEN || ''

function proxyToClawmetry(req, res, targetPath) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const qs = url.search || ''

  const proxyOpts = {
    hostname: CLAWMETRY_HOST,
    port: CLAWMETRY_PORT,
    path: targetPath + qs,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${CLAWMETRY_HOST}:${CLAWMETRY_PORT}`,
      authorization: `Bearer ${CLAWMETRY_TOKEN}`,
    },
  }

  const proxyReq = http.request(proxyOpts, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || ''

    if (contentType.includes('text/html') && targetPath === '/') {
      // Buffer HTML, inject base path monkey-patch
      let body = ''
      proxyRes.on('data', c => body += c)
      proxyRes.on('end', () => {
        body = body.replace('<head>', '<head>' + clawmetryPatchScript())
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      })
    } else {
      // Stream everything else (API JSON, SSE, etc.)
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    }
  })

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('ClawMetry unavailable')
  })

  req.pipe(proxyReq)
}
```

**Route matching** (in the main request handler):

```javascript
if (path === '/dashboard' || path.startsWith('/dashboard/')) {
  const clawmetryPath = path.replace(/^\/dashboard/, '') || '/'
  return proxyToClawmetry(req, res, clawmetryPath)
}
```

### Step 5: Base path monkey-patch injection

When proxying the root HTML page, inject a script that patches `fetch()`, `EventSource`, and `XMLHttpRequest` to prepend the full external path prefix:

```javascript
function clawmetryPatchScript() {
  const prefix = `${effectiveBP}/dashboard`
  return `
<script>
(function() {
  var B = ${JSON.stringify(prefix)};
  var _f = window.fetch;
  window.fetch = function(u) {
    if (typeof u === 'string' && (u.startsWith('/api/') || u.startsWith('/v1/')))
      arguments[0] = B + u;
    return _f.apply(this, arguments);
  };
  var _E = window.EventSource;
  window.EventSource = function(u, o) {
    if (typeof u === 'string' && (u.startsWith('/api/') || u.startsWith('/v1/')))
      u = B + u;
    return new _E(u, o);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u) {
    if (typeof u === 'string' && (u.startsWith('/api/') || u.startsWith('/v1/')))
      arguments[1] = B + u;
    return _open.apply(this, arguments);
  };
})();
</script>`
}
```

This intercepts all API calls from ClawMetry's embedded SPA and routes them through dashboard.mjs's proxy. Covers `/api/*` (all 39+ endpoints) and `/v1/*` (OTEL endpoints).

### Step 6: Link from dashboard.mjs index page

Add a navigation link to ClawMetry on the main dashboard index page:

```html
<a href="${effectiveBP}/dashboard/">Observability</a>
```

### Step 7: Log directory consideration

ClawMetry's `--log-dir` expects real-time gateway logs (JSONL). Our setup logs to stdout (captured by Docker/Vector), not to files in `~/.openclaw/logs/`. The `llm.log` and `debug.log` are there, but the main gateway activity logs are not.

Options (decide during implementation):

- Point `--log-dir` to `~/.openclaw/logs/` (gets llm.log + debug.log)
- Accept that the real-time log streaming tab may be empty (session transcripts and LLM costs work fine)
- Later: add a Vector sink that writes a copy of gateway logs to `~/.openclaw/logs/gateway.log`

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `deploy/clawmetry/Dockerfile` | **Create** | Python 3.11 + Flask image |
| `deploy/clawmetry/dashboard.py` | **Create** (copy from source) | ClawMetry source |
| `deploy/dashboard.mjs` | **Modify** | Add `/dashboard/*` proxy route + monkey-patch injection |
| `deploy/docker-compose.override.yml` | **Modify** | Add clawmetry service, add CLAWMETRY_TOKEN to gateway env |

**No changes to**: entrypoint, build script, or openclaw.json.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Docker DNS resolution from Sysbox container | Proxy can't reach ClawMetry | Fallback: expose port on host `127.0.0.1:8900:8900`, proxy to `host.docker.internal:8900` |
| Monkey-patch misses some URL patterns | Broken API calls in browser | We control the source copy; `/api/*` and `/v1/*` cover all 39+ endpoints |
| SSE buffering | Live logs don't stream | Node.js `http.request` + `pipe()` doesn't buffer by default; ClawMetry sets `X-Accel-Buffering: no` |
| ClawMetry container crash | Dashboard tab broken | `restart: unless-stopped` auto-recovers; 502 error page from dashboard.mjs |
| Log streaming tab empty | Reduced functionality | Session transcripts + LLM costs (the most valuable features) work regardless |

## Verification

1. Build ClawMetry image on VPS: `docker compose build clawmetry`
2. Deploy: `docker compose up -d`
3. Check ClawMetry container is running: `docker compose ps clawmetry`
4. Test connectivity from inside gateway: `docker exec openclaw-gateway curl -s http://openclaw-clawmetry:8900/`
5. Navigate to `https://<domain>/dashboard/dashboard/`
6. Verify:
   - Main dashboard page loads with all tabs
   - Session transcripts load and show token/cost data
   - Memory/workspace browser shows SOUL.md, MEMORY.md
   - Cron jobs listing works
   - SSE log streaming works (if log data available)
   - No console errors in browser DevTools
7. Auth check: access without CF Access should be blocked
