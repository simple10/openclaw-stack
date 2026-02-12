# Browser VNC Plans & Analysis

After analyzing the sidecar plan (see below), there are tradeoff of the sidecar
approach used by other projects.

## Analysis of Approaches

Sidecar (the plan) vs. Gateway Proxy (my approach)

  Concurrency: Fixed ports with multiple agents

  Yes, this is a real issue. The sidecar plan has ONE Chromium instance with ONE CDP port (9222). Looking at what we found in
  the code:

- maxConcurrent: 4 on the Main lane means up to 4 conversations can run agent turns simultaneously
- Session-level serialization only prevents concurrency within a single conversation
- Two different WhatsApp users (or WhatsApp + web UI) could both trigger browser tasks at the same time
- They'd share the same Chrome instance, same tabs, same lastTargetId — same race conditions we identified earlier

  For your current single-user setup, this is probably fine — conversations serialize naturally. But it's a landmine if usage
  grows.

  Chrome profiles with a sidecar

  The sidecar breaks OpenClaw's profile system. Here's why:

- OpenClaw profiles work by spinning up separate Chrome instances with isolated user data dirs, each on its own CDP port
- The sidecar has ONE Chromium on port 9222 → ONE CDP endpoint → cdpUrl: "<http://browser:9223>" is hardcoded to that instance
- openclaw browser create-profile creates a profile config entry, but it needs a different cdpPort or cdpUrl — there's
  nowhere to point a second profile
- To support N profiles, you'd need N sidecar containers with N different ports and N Cloudflare tunnel routes

  KasmVNC single-viewer problem

  KasmVNC shows ONE desktop. If you and an agent are both looking at it, you see the same screen. This is actually fine for the
   use case (user watches agent work, or user logs in while agent waits). But two users accessing
  novnc-openclaw.ventureunknown.com simultaneously would fight over the mouse/keyboard.

  Security relaxation

  The plan sets allowHostControl: true for all sandboxed agents. This means any agent (including skills agent running
  third-party tools) can control the persistent browser with your stored credentials. The current sandbox approach isolates
  browser state per agent.

  Side-by-side comparison
  ┌───────────────────┬────────────────────────────────────────────────┬────────────────────────────────────────────────────┐
  │      Concern      │                    Sidecar                     │                   Gateway Proxy                    │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Simplicity        │ Simple — compose service + tunnel route        │ Complex — WebSocket proxy, dynamic port reading    │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Concurrent agents │ Shared Chrome, races possible                  │ Per-agent containers, isolated                     │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Multiple profiles │ Need N sidecars, N ports, N tunnel routes      │ Already works — each profile has its own container │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ noVNC access      │ Fixed port, easy tunnel config                 │ Dynamic ports, proxy must read browsers.json       │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Browser state     │ Persistent (cookies survive)                   │ Ephemeral (clean per session)                      │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ User viewing      │ One KasmVNC URL, works great                   │ Different URL per agent/profile                    │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Idle resources    │ Always running (~512MB)                        │ On-demand only                                     │
  ├───────────────────┼────────────────────────────────────────────────┼────────────────────────────────────────────────────┤
  │ Security          │ All agents share one browser with stored creds │ Per-agent isolation maintained                     │
  └───────────────────┴────────────────────────────────────────────────┴────────────────────────────────────────────────────┘
  My recommendation

  For your setup (single user, primary use case is "let me log in so the agent has an authenticated session"), the sidecar is
  the pragmatic choice. The concurrency and profile concerns are theoretical until you need them.

  One thing I'd change in the plan: keep sandbox.browser.enabled: true for the code and skills agents so they retain their
  isolated browsers, and only route the main agent to the sidecar. That preserves isolation for delegated work while giving you
   the VNC access you need.

---

# Alternate Approach: Gateway Proxy

## 1

Current state of noVNC in OpenClaw:

  The gateway knows the mapped noVNC port for each browser container and passes it to the agent's system prompt as Sandbox
  browser observer (noVNC): <http://127.0.0.1>:<mapped-port>/vnc.html?autoconnect=1&resize=remote. But this URL is loopback-only
  — it's meant for local desktop use, not remote access. There's no proxy, no route in the gateway, and no control UI
  integration for noVNC. The agent sees the URL but users can't reach it through the tunnel.

  The architecture problem:

  User → Cloudflare Tunnel → cloudflared → gateway:18789
                                                ↓
                                      browser container (inside DinD)
                                        noVNC :6080 → mapped to 127.0.0.1:<random>

  The noVNC port is dynamically mapped and lives inside the gateway's inner Docker (Sysbox). Multiple profiles would each have
  their own container with their own mapped ports.

  Options for exposing noVNC:

  1. Gateway-level WebSocket proxy — The gateway already knows each profile's mappedNoVnc port. It could add a route like
  /__openclaw__/browser/vnc/:profile that reverse-proxies the WebSocket to the correct noVNC port. This would work through the
  existing Cloudflare tunnel with zero extra infrastructure. But it requires an upstream code change (or a plugin/hook).
  2. Sidecar nginx reverse proxy — An nginx container in the same Docker network that maps paths to noVNC ports. Problem: the
  ports are dynamic (random), so nginx config can't be static. You'd need something like a template that gets regenerated when
  containers start, or use nginx's resolver with container DNS names. But the browser containers are inside Sysbox's inner
  Docker, not visible to the outer compose network — so this approach doesn't work without extra plumbing.
  3. Cloudflare tunnel per-profile — Add a public hostname per profile in the tunnel config (e.g.,
  vnc-default.openclaw.ventureunknown.com → localhost:<port>). But ports are dynamic, so this breaks on every restart.

  The practical answer: Option 1 is the right path. The gateway is the only component that knows the profile → port mapping at
  runtime. Either OpenClaw adds this as a feature upstream (which seems likely given they already track noVncUrl), or you'd
  need to build a lightweight WebSocket proxy outside the gateway that queries the profile ports via the gateway's HTTP API.

  Would you like me to check if the gateway's browser HTTP API already exposes the noVNC port so an external proxy could query
  it?

  > yes, check

## 2

  Here's the full picture:

  What's available:

  1. browsers.json at /home/node/.openclaw/sandbox/browsers.json — contains noVncPort for every browser container, keyed by
  sessionKey (e.g., agent:main → port 32769)
  2. openclaw sandbox list --browser --json — same data via CLI
  3. noVNC is reachable from inside the gateway container at <http://127.0.0.1>:<mapped-port>/vnc.html
  4. Ports are dynamic — assigned by Docker's random port mapper, change on every container recreation

  What's NOT available:

- No HTTP/WebSocket API on the gateway's main port (18789) that exposes the noVNC port or proxies to it
- No built-in reverse proxy for noVNC
- The browser bridge server is a separate Express instance on a different random loopback port, only handling CDP operations

  For your proxy approach, a lightweight WebSocket reverse proxy (inside the gateway container or as a sidecar process) could:

  1. Read browsers.json or call openclaw sandbox list --browser --json to get the current port mapping
  2. Route by path: /vnc/main/ → 127.0.0.1:32769, /vnc/skills/ → 127.0.0.1:32771
  3. Bind to a fixed port (e.g., 6900) that the Cloudflare tunnel routes to
  4. Watch for port changes (containers recreated) by polling the registry or watching the file

  The tricky part is that noVNC uses WebSocket upgrades (/websockify), so the proxy needs to handle both HTTP (for the noVNC
  HTML/JS client) and WebSocket (for the actual VNC stream). Something like http-proxy or nginx with proxy_pass and
  proxy_http_version 1.1; proxy_set_header Upgrade would handle both.

  Want me to plan out an implementation?

  This could be a small Node.js script or an nginx sidecar inside the gateway container. The ports are dynamic but stable for
  the container's lifetime — they only change when the browser container is recreated.

---

plan: ~/.claude/plans/soft-stirring-snail.md
overview: Browser Sidecar Container
---

THIS IS THE SIDECAR PLAN (SEE ANALYSIS ABOVE FOR REASONS NOT TO USE IT)

# Browser Sidecar Container

Access noVNC browser sandbox UI via Cloudflare tunnel

## Context

OpenClaw's built-in browser sandbox runs Chromium inside nested Docker (Sysbox DinD) with __dynamic port mapping__ — each session gets a random host port for noVNC. This makes external access impossible without a relay or port patch.

The [coollabsio/openclaw](https://github.com/coollabsio/openclaw) project solves this with a __sidecar browser container__ pattern: a persistent `linuxserver/chromium` container with fixed ports, connected via OpenClaw's native `browser.cdpUrl` remote CDP feature. This eliminates the dynamic port problem entirely — no relay scripts, no source patches, no socat.

__Goal:__ Replace the sandbox-spawned browser with a sidecar browser container, making the KasmVNC web UI accessible at `https://novnc-openclaw.ventureunknown.com` via the existing Cloudflare tunnel.

## Architecture

```
User browser → CF edge → tunnel → cloudflared (VPS host)
  → localhost:3000 → browser container:3000 (KasmVNC web UI)

Agent (gateway) → Docker DNS → browser:9223 (nginx CDP proxy)
  → 127.0.0.1:9222 (Chrome DevTools Protocol)
```

The browser container runs three services via s6-overlay:

- __Chromium__ on port 9222 (CDP)
- __nginx__ on port 9223 (rewrites `Host` header to `localhost` so Chrome accepts cross-container CDP connections)
- __KasmVNC__ on port 3000 (web-based VNC UI — this is what we expose)

## How target resolution works (from source)

`browser-tool.ts:190-218` (`resolveBrowserBaseUrl`):

1. If `sandboxBridgeUrl` is set → target defaults to `"sandbox"`, uses sandbox browser
2. If `sandboxBridgeUrl` is empty → target defaults to `"host"`, uses `browser.cdpUrl`
3. Host mode requires `allowHostControl: true` (sandbox policy) AND `browser.enabled: true`

By disabling the sandbox browser (`enabled: false`) and enabling host control, the agent automatically falls through to the sidecar via `browser.cdpUrl`.

## Changes

### 1. Create browser sidecar Dockerfile

__New file:__ `deploy/Dockerfile.browser`

Based on `lscr.io/linuxserver/chromium:latest`. Adds nginx CDP reverse proxy as an s6-overlay service (same approach as coollabsio/openclaw):

```dockerfile
FROM lscr.io/linuxserver/chromium:latest

# nginx CDP reverse proxy: rewrites Host header to localhost so Chrome
# accepts CDP connections from Docker DNS hostnames (e.g. "browser:9222")
RUN mkdir -p /etc/s6-overlay/s6-rc.d/nginx-cdp && \
    echo "longrun" > /etc/s6-overlay/s6-rc.d/nginx-cdp/type && \
    printf '#!/command/execlineb -P\nnginx -c /etc/nginx/cdp-proxy.conf -g "daemon off;"\n' > /etc/s6-overlay/s6-rc.d/nginx-cdp/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/nginx-cdp/run && \
    touch /etc/s6-overlay/s6-rc.d/user/contents.d/nginx-cdp

RUN printf 'events {}\nhttp {\n  server {\n    listen 9223;\n    location / {\n      proxy_pass http://127.0.0.1:9222;\n      proxy_set_header Host localhost;\n      proxy_http_version 1.1;\n      proxy_set_header Upgrade $http_upgrade;\n      proxy_set_header Connection "upgrade";\n      proxy_read_timeout 86400s;\n    }\n  }\n}\n' > /etc/nginx/cdp-proxy.conf
```

### 2. Add browser service to docker-compose

__File:__ `deploy/docker-compose.override.yml`

```yaml
  browser:
    build:
      context: .
      dockerfile: deploy/Dockerfile.browser
    image: openclaw-browser:local
    container_name: openclaw-browser
    restart: always
    ports:
      # KasmVNC web UI — localhost only, accessed via cloudflared
      - "127.0.0.1:3000:3000"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=UTC
      - CHROME_CLI=--remote-debugging-port=9222
    volumes:
      # Persist Chrome profiles/cookies across restarts (bind mount per CLAUDE.md rules)
      - ./data/browser:/config
    shm_size: 2g
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 3G
          pids: 256
        reservations:
          memory: 512M
    networks:
      - openclaw-gateway-net
```

### 3. Configure OpenClaw for remote CDP

__File:__ `deploy/openclaw.json`

Add top-level `browser` config and update sandbox browser settings:

```jsonc
{
  "browser": {
    "enabled": true,
    "cdpUrl": "http://browser:9223",
    "evaluateEnabled": true,
    "defaultProfile": "openclaw"
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "browser": {
          "enabled": false,          // Don't spawn sandbox browser containers
          "allowHostControl": true   // Let sandboxed agents use host browser (sidecar)
        }
      }
    }
  }
}
```

The existing sandbox browser fields (`image`, `cdpPort`, `noVncPort`, etc.) become inert when `enabled: false` — they can stay or be removed.

### 4. Add `BROWSER_CDP_URL` to gateway environment (belt-and-suspenders)

__File:__ `deploy/docker-compose.override.yml`

Add to gateway's `environment:` list:

```yaml
- BROWSER_CDP_URL=http://browser:9223
```

This may not be needed (openclaw.json should suffice), but ensures the gateway knows the sidecar URL even if the config loading order matters.

### 5. Add Cloudflare tunnel route (manual — CF Dashboard)

In Cloudflare Dashboard → Zero Trust → Networks → Tunnels → `openclaw` tunnel → Public Hostname:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| novnc-openclaw | ventureunknown.com | <http://localhost:3000> |

Optional: Add a Cloudflare Access policy to restrict who can view the browser.

### 6. Update notes

__File:__ `notes/TODO.md` — mark the noVNC TODO as done

## Files summary

| File | Change |
|------|--------|
| `deploy/Dockerfile.browser` | __New__ — browser sidecar image (linuxserver/chromium + nginx CDP proxy) |
| `deploy/docker-compose.override.yml` | Add `browser` service + gateway env var |
| `deploy/openclaw.json` | Add `browser.cdpUrl`, disable sandbox browser, enable host control |
| `notes/TODO.md` | Mark noVNC TODO done |

__No changes to:__ `deploy/build-openclaw.sh`, `deploy/entrypoint-gateway.sh`, `deploy/rebuild-sandboxes.sh`

## Deployment

1. Build browser sidecar image: `docker compose build browser` (on VPS)
2. SCP updated files to VPS (`Dockerfile.browser`, `docker-compose.override.yml`, `openclaw.json`)
3. Create `./data/browser/` directory on VPS
4. Add public hostname in CF Dashboard (`novnc-openclaw.ventureunknown.com` → `http://localhost:3000`)
5. On VPS: `docker compose down && docker compose up -d`
6. Verify: open `https://novnc-openclaw.ventureunknown.com` (KasmVNC login page should load)
7. Send a browser task via webchat → verify Chrome activity visible in KasmVNC

## Verification

1. `docker compose ps` — browser container running, healthy
2. `curl -s http://localhost:3000` from VPS — KasmVNC HTML returned
3. Open `https://novnc-openclaw.ventureunknown.com` — KasmVNC desktop visible
4. Send browser task in webchat (e.g., "browse to <https://news.ycombinator.com>")
5. KasmVNC should show Chrome navigating to HN in real-time
6. Verify gateway logs show CDP connection to `browser:9223` (not spawning sandbox browser)

## Tradeoffs vs. sandbox browser

| Aspect | Sandbox browser (current) | Sidecar browser (proposed) |
|--------|--------------------------|---------------------------|
| Isolation | Per-session container | Persistent shared container |
| Port mapping | Dynamic (random) | Fixed (3000, 9222, 9223) |
| VNC access | Not externally accessible | KasmVNC on port 3000 |
| Browser state | Ephemeral (lost on session end) | Persistent (cookies, logins survive) |
| Resource usage | On-demand (only during browser tasks) | Always running (~512MB idle) |
| Complexity | Nested Docker (Sysbox DinD) | Standard Docker sidecar |
