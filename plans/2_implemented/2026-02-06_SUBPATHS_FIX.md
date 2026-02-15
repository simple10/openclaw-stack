# Plan: Configurable Subpaths for OpenClaw & Grafana

## Problem

Static assets (favicons) break when OpenClaw is accessed at `/_openclaw/chat` because:

- The gateway's `controlUi.basePath` isn't set, so it can't strip the subpath prefix before looking up files on disk
- Root-level static files like `/favicon.svg` return `index.html` (SPA fallback) when requested as `/_openclaw/favicon.svg`
- Caddy uses `handle_path` (strips prefix) for OpenClaw but `handle` (preserves prefix) for Grafana — inconsistent

## Solution

1. Add `OPENCLAW_DOMAIN_PATH` and `SUBPATH_GRAFANA` to `openclaw-config.env`
2. Set `gateway.controlUi.basePath` from `OPENCLAW_DOMAIN_PATH` (like Grafana's `GF_SERVER_SERVE_FROM_SUB_PATH`)
3. Switch Caddy from `handle_path` to `handle` for OpenClaw (matching the Grafana pattern)
4. Replace all hardcoded subpaths in playbooks/docs with variable placeholders

Both services then work identically: the app is aware of its subpath, and the proxy preserves the full path.

---

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `openclaw-config.env.example` | Add `OPENCLAW_DOMAIN_PATH` and `SUBPATH_GRAFANA` |
| 2 | `openclaw-config.env` | Add same variables (actual config) |
| 3 | `playbooks/04-vps1-openclaw.md` §4.8 | Add `gateway.controlUi.basePath` to openclaw.json |
| 4 | `playbooks/networking/caddy.md` | Switch OpenClaw from `handle_path` to `handle`; use `<SUBPATH_*>` placeholders |
| 5 | `playbooks/networking/cloudflare-tunnel.md` | Use `<SUBPATH_*>` placeholders in URLs and Access config |
| 6 | `playbooks/05-vps2-observability.md` | Use `<SUBPATH_GRAFANA>` in `GF_SERVER_ROOT_URL` |
| 7 | `playbooks/07-verification.md` | Use `<SUBPATH_*>` placeholders |
| 8 | `README.md` | Use `<SUBPATH_*>` placeholders |
| 9 | `docs/TESTING.md` | Use `<SUBPATH_*>` placeholders |
| 10 | `docs/CLOUDFLARE-TUNNEL.md` | Use `<SUBPATH_*>` placeholders |
| 11 | `CLAUDE.md` | Add deployment note |

**Not modified:** `_bak/` files (backups), `docs/OTEL.md` (low-priority, 2 refs)

---

## Implementation Details

### 1-2. Config files

Add to `openclaw-config.env.example` and `openclaw-config.env`:

```bash
# URL subpaths for obscured access (no trailing slash)
# Set to empty string "" to serve at root (e.g., when using dedicated domains with Cloudflare Tunnel)
OPENCLAW_DOMAIN_PATH=/_openclaw
SUBPATH_GRAFANA=/_observe/grafana
```

### 3. `playbooks/04-vps1-openclaw.md` §4.8 — openclaw.json

Add `controlUi.basePath` to the gateway config:

```json
"gateway": {
  "bind": "lan",
  "mode": "local",
  "controlUi": {
    "basePath": "${OPENCLAW_DOMAIN_PATH:-/_openclaw}"
  }
}
```

This tells the gateway to strip the subpath prefix before looking up static files, fixing favicon/asset serving.

### 4. `playbooks/networking/caddy.md` — VPS-1 Caddyfile

Switch from `handle_path` to `handle` for OpenClaw (matching Grafana's pattern):

```caddy
# Before (broken — strips prefix, gateway doesn't know about subpath):
handle_path /_openclaw/* {
    reverse_proxy localhost:18789 { ... }
}

# After (fixed — preserves prefix, gateway strips it via controlUi.basePath):
handle <OPENCLAW_DOMAIN_PATH>/* {
    reverse_proxy localhost:18789 {
        header_up Host {host}
        header_up X-Real-IP {remote}
    }
}
handle <OPENCLAW_DOMAIN_PATH> {
    redir <OPENCLAW_DOMAIN_PATH>/ permanent
}
```

Also update root redirect and all hardcoded `/_observe/grafana` to `<SUBPATH_GRAFANA>`.

Add a note explaining why `handle` (not `handle_path`) is required — same reason as Grafana: the app is configured to serve from a subpath and expects the full path.

### 5. `playbooks/05-vps2-observability.md`

Line 101: Replace hardcoded path in `GF_SERVER_ROOT_URL`:

```yaml
- GF_SERVER_ROOT_URL=https://${GRAFANA_DOMAIN:-localhost}<SUBPATH_GRAFANA>/
```

### 6-10. Docs and remaining playbooks

Replace all hardcoded `/_openclaw/` and `/_observe/grafana/` with `<OPENCLAW_DOMAIN_PATH>` and `<SUBPATH_GRAFANA>` placeholders. Key locations:

- **cloudflare-tunnel.md**: Lines 152, 291, 304, 326 — test URLs and Access path
- **07-verification.md**: Lines 200, 213, 277 — test commands
- **README.md**: Lines 154-155, 204, 263, 313-314 — access URLs, health checks
- **docs/TESTING.md**: Lines 12-13, 184-185, 200-201, 225, 236, 314-315, 327-328 — test URLs
- **docs/CLOUDFLARE-TUNNEL.md**: Lines 81, 152 — Access path and test URL

### 11. `CLAUDE.md`

Add to Key Deployment Notes:

```
17. **UI subpaths:** Configure `OPENCLAW_DOMAIN_PATH` and `SUBPATH_GRAFANA` in openclaw-config.env; gateway uses `controlUi.basePath`, Grafana uses `GF_SERVER_SERVE_FROM_SUB_PATH`; Caddy must use `handle` (not `handle_path`) to preserve the prefix
```

---

## Verification

After deploying changes on VPS-1:

```bash
# 1. Static assets load correctly under subpath
curl -s https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/favicon.svg | head -3
# Should return SVG, not HTML

# 2. SPA routes still work
curl -s https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat | head -3
# Should return HTML (index.html — correct SPA behavior)

# 3. JS/CSS assets still load
curl -sI https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/assets/index-BJMYln02.js
# Should return 200 with content-type: application/javascript

# 4. Health endpoint works
curl -s https://<OPENCLAW_DOMAIN>/health
# Note: health endpoint may not be under subpath (depends on gateway routing order)

# 5. Root redirect works (Caddy only)
curl -sI https://<OPENCLAW_DOMAIN>/
# Should redirect to <OPENCLAW_DOMAIN_PATH>/

# 6. Grafana still works
curl -s https://<DOMAIN_GRAFANA><SUBPATH_GRAFANA>/api/health
```
