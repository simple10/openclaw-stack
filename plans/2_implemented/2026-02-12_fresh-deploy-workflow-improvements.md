# Plan: Improve Fresh Deploy Flow + OPENCLAW_BROWSER_PUBLIC_URL

## Context

The current fresh deploy flow requires too many env vars upfront (OPENCLAW_DOMAIN, all worker URLs, etc.) even though most aren't needed until late in the process. The user wants to simplify: only `VPS1_IP` and `CF_TUNNEL_TOKEN` are needed to start. Domain configuration (OPENCLAW_DOMAIN, OPENCLAW_BROWSER_PUBLIC_URL) should be deferred to post-deploy, when the user configures Cloudflare Tunnel public routes.

Additionally, `OPENCLAW_BROWSER_PUBLIC_URL` is a new env var that exists in the config example but isn't implemented anywhere. The novnc-proxy needs subpath awareness to support URLs like `openclaw.example.com/browser` (where `/browser` is a Cloudflare Tunnel path prefix that gets forwarded to the origin).

---

## Changes

### 1. Create `playbooks/00-fresh-deploy-setup.md`

New playbook that replaces the config validation logic currently in CLAUDE.md's Setup Question Flow for fresh deploys.

**Structure:**

- **0.1 Config file check** — `openclaw-config.env` exists?
- **0.2 Required for start** — Validate only `VPS1_IP` (not a placeholder) and `CF_TUNNEL_TOKEN` (not empty)
- **0.3 SSH check** — Validate `SSH_KEY_PATH` exists on local system, test SSH connectivity using defaults (`SSH_USER=ubuntu`, `SSH_PORT=22`)
- **0.4 Worker placeholder detection** — Scan `AI_GATEWAY_WORKER_URL` and `LOG_WORKER_URL` for `<angle-bracket>` placeholders. If found, note that workers will be deployed via `01-workers.md` before VPS setup
- **0.5 Deployment overview** — Show the user the full deployment plan:

  ```
  1. [If needed] Deploy Cloudflare Workers (01-workers.md)
  2. Base setup & hardening (02-base-setup.md)
  3. Docker installation (03-docker.md)
  4. OpenClaw deployment (04-vps1-openclaw.md)
  5. Backup configuration (06-backup.md)
  6. Reboot & verification (07-verification.md)
  7. Post-deploy: Configure Cloudflare Tunnel routes, domain setup,
     browser VNC access, device pairing (08-post-deploy.md)
  ```

- Note that OPENCLAW_DOMAIN, OPENCLAW_BROWSER_PUBLIC_URL, and OPENCLAW_DOMAIN_PATH can remain as placeholders — they're only needed during post-deploy (step 7)

### 2. Update `CLAUDE.md` — Setup Question Flow

Simplify Step 0 and Step 1:

- **Step 0:** Check config file exists, then branch:
  - **Fresh deploy** → follow `00-fresh-deploy-setup.md` (minimal validation: VPS1_IP + CF_TUNNEL_TOKEN + SSH)
  - **Existing deploy** → same as current (analysis, test, modify options)
- Remove the detailed validation steps (required fields check, placeholder scanning, SSH test) from CLAUDE.md — they now live in the playbook
- Keep the execution order section as-is

### 3. Update `openclaw-config.env.example`

Reorganize into clear sections with better comments:

```bash
# === REQUIRED TO START DEPLOYMENT ===
VPS1_IP=15.x.x.1
CF_TUNNEL_TOKEN=                   # Create tunnel first (see docs/CLOUDFLARE-TUNNEL.md)

# === SSH (defaults work for fresh Ubuntu VPS) ===
SSH_KEY_PATH=~/.ssh/vps1_openclaw_ed25519
SSH_USER=ubuntu                    # Changed to adminclaw during hardening
SSH_PORT=22                        # Changed to 222 during hardening

# === DOMAIN CONFIGURATION (needed for post-deploy, not initial setup) ===
OPENCLAW_DOMAIN=openclaw.<example>.com
OPENCLAW_DOMAIN_PATH=/openclaw
OPENCLAW_BROWSER_PUBLIC_URL=openclaw.<example>.com/browser
# ^ Can be a subpath (domain.com/browser) or separate subdomain (browser.domain.com)
# The path component (if any) is extracted and passed to the novnc-proxy as its base path.

# === CLOUDFLARE WORKERS (auto-deployed if placeholders remain) ===
AI_GATEWAY_WORKER_URL=https://ai-gateway-proxy.<account>.workers.dev
AI_GATEWAY_AUTH_TOKEN=<worker-auth-token>
LOG_WORKER_URL=https://log-receiver.<account>.workers.dev/logs
LOG_WORKER_TOKEN=<generated-token>

# === OPTIONAL ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
```

### 4. Update `deploy/novnc-proxy.mjs` — Subpath awareness

Add `BASE_PATH` support so the proxy works behind a Cloudflare Tunnel path prefix:

- Read `process.env.NOVNC_BASE_PATH || ''` at startup (e.g., `/browser`)
- Normalize: ensure it starts with `/` and has no trailing slash; empty string = no prefix
- **Request handler:** Strip `BASE_PATH` from incoming `req.url` before routing. If request doesn't start with BASE_PATH, return 404
- **Index page links:** Prefix all `href` values with BASE_PATH (e.g., `href="/browser/main/vnc.html?path=browser/main/websockify"`)
- **Redirect handler:** Include BASE_PATH in `Location` header and `path` query param
  - Before: `Location: /main/vnc.html?path=main/websockify`
  - After: `Location: /browser/main/vnc.html?path=browser/main/websockify`
- **WebSocket upgrade handler:** Strip BASE_PATH from upgrade URL before routing to backend
- **Media links:** Prefix `/media/` paths with BASE_PATH
- Log the base path at startup: `[novnc-proxy] Base path: /browser`
- When BASE_PATH is empty, behavior is identical to current (backward compatible)

### 5. Update `deploy/docker-compose.override.yml`

Add the env var to the gateway service environment section:

```yaml
environment:
  # ... existing vars ...
  - NOVNC_BASE_PATH=${NOVNC_BASE_PATH:-}
```

### 6. Update `playbooks/04-vps1-openclaw.md` — Section 4.5 (.env file)

When creating the `.env` file on VPS, parse `OPENCLAW_BROWSER_PUBLIC_URL` to extract the path:

```bash
# Parse browser URL path component
# "openclaw.example.com/browser" → "/browser"
# "browser-openclaw.example.com" → "" (no subpath)
BROWSER_URL="${OPENCLAW_BROWSER_PUBLIC_URL}"
if [[ "$BROWSER_URL" == */* ]]; then
  NOVNC_BASE_PATH="/${BROWSER_URL#*/}"  # everything after first /
else
  NOVNC_BASE_PATH=""
fi
```

Add `NOVNC_BASE_PATH=<extracted-value>` to the `.env` file on VPS.

If `OPENCLAW_BROWSER_PUBLIC_URL` still has a placeholder (`<example>`), set `NOVNC_BASE_PATH=` (empty) — it'll be updated during post-deploy when the user provides the real URL.

### 7. Update `playbooks/08-post-deploy.md` — Browser VNC verification

Add a new section **8.0b** (after 8.0 gateway domain, before 8.1 token retrieval):

**8.0b Connect Browser VNC via Cloudflare Tunnel**

1. Check if `OPENCLAW_BROWSER_PUBLIC_URL` has a placeholder
   - If yes: pause and instruct user to configure a tunnel route for browser VNC access (pointing to `localhost:6090`), then provide the public URL in chat. Update `openclaw-config.env`, re-parse the path, update `.env` on VPS, restart the gateway.
2. Test browser VNC URL: `curl -sI https://<OPENCLAW_BROWSER_PUBLIC_URL>/`
   - Check for Cloudflare Access headers (should be protected)
   - Check for 200/302 response (tunnel working)
3. Internal check: verify novnc-proxy is running and has the correct base path

Also update section 8.0: same pattern — if `OPENCLAW_DOMAIN` has placeholder, pause and instruct user to configure tunnel route, provide in chat, then update config and continue.

### 8. Update `docs/BROWSER-VNC.md`

- Add section on `OPENCLAW_BROWSER_PUBLIC_URL` configuration
- Document both URL formats (subpath vs separate subdomain)
- Update the "URL Routing" table to show base-path-aware URLs
- Update verification commands

### 9. Update `docs/CLOUDFLARE-TUNNEL.md`

- Reference `OPENCLAW_BROWSER_PUBLIC_URL` in the Browser VNC section
- Clarify how the path field in tunnel config interacts with the proxy

---

## Files Modified

| File | Action | Key Changes |
|------|--------|-------------|
| `playbooks/00-fresh-deploy-setup.md` | **Create** | Fresh deploy validation + overview |
| `CLAUDE.md` | Edit | Simplify Setup Question Flow → reference playbook |
| `openclaw-config.env.example` | Edit | Reorganize sections, update comments |
| `deploy/novnc-proxy.mjs` | Edit | Add BASE_PATH prefix stripping + URL generation |
| `deploy/docker-compose.override.yml` | Edit | Add NOVNC_BASE_PATH env var |
| `playbooks/04-vps1-openclaw.md` | Edit | Parse BROWSER_PUBLIC_URL → NOVNC_BASE_PATH in .env |
| `playbooks/08-post-deploy.md` | Edit | Add 8.0b browser VNC verification, placeholder handling for both domains |
| `docs/BROWSER-VNC.md` | Edit | Document OPENCLAW_BROWSER_PUBLIC_URL + base path |
| `docs/CLOUDFLARE-TUNNEL.md` | Edit | Reference browser URL config |

---

## Verification

1. **novnc-proxy with base path:** Test locally by setting `NOVNC_BASE_PATH=/browser` and verifying:
   - `GET /browser/` → index page with correct links
   - `GET /browser/main/` → redirect with correct Location + path param
   - `GET /browser/media/` → media listing with correct links
   - `GET /` → 404 (doesn't match base path)
   - WebSocket upgrade to `/browser/main/websockify` → strips prefix before backend connect

2. **Fresh deploy flow:** Walk through `00-fresh-deploy-setup.md` with a config that only has VPS1_IP + CF_TUNNEL_TOKEN set, verify it passes validation and shows the deployment overview

3. **Post-deploy domain handling:** Verify that when OPENCLAW_DOMAIN and OPENCLAW_BROWSER_PUBLIC_URL have placeholders, the post-deploy playbook correctly pauses and instructs the user

4. **End-to-end on VPS:** After full deployment, verify:
   - `https://OPENCLAW_DOMAIN/DOMAIN_PATH/health` responds (behind Access)
   - `https://OPENCLAW_BROWSER_PUBLIC_URL/` shows the novnc-proxy index page (behind Access)
   - WebSocket connections through the tunnel work for VNC sessions
