# Rename noVNC Proxy to Dashboard

## Context

The `novnc-proxy.mjs` server currently handles more than just noVNC browser session proxying — it also serves media files (screenshots, downloads) and will gain additional features (log viewer, etc.). The name "novnc-proxy" and the `/browser` URL path no longer reflect its expanding role. This rename establishes "dashboard" as the umbrella term, with browsers and media as sub-sections.

## Scope

Rename only — no new features. The proxy code, env vars, URLs, docs, and config all get updated to use "dashboard" terminology.

## Changes

### 1. File Renames

| From | To |
|------|-----|
| `deploy/novnc-proxy.mjs` | `deploy/dashboard.mjs` |
| `docs/BROWSER-VNC.md` | `docs/DASHBOARD.md` |

### 2. Env Var Renames

| Old | New | Where set |
|-----|-----|-----------|
| `NOVNC_BASE_PATH` | `DASHBOARD_BASE_PATH` | `docker-compose.override.yml`, `.env` on VPS, `dashboard.mjs` |
| `OPENCLAW_BROWSER_DOMAIN_PATH` | `OPENCLAW_DASHBOARD_DOMAIN_PATH` | `openclaw-config.env.example`, playbooks |

Keep `OPENCLAW_BROWSER_DOMAIN` unchanged (it's the hostname, not path-specific).

### 3. URL Restructuring (inside `dashboard.mjs`)

| Old route | New route |
|-----------|-----------|
| `/` (index) | `/` (index — unchanged, lists browsers + media links) |
| `/media/...` | `/media/...` (unchanged — already relative to base path) |
| `/<agent-id>/...` (browser proxy) | `/<agent-id>/...` (unchanged — agent browser routing stays the same) |

The **base path** changes: what was `/browser` in the Cloudflare Tunnel config becomes `/dashboard`. The internal routing within the proxy stays the same (index, media, agent browser sessions are all relative to the base path).

User-facing URLs change:

- `https://domain.com/browser/` → `https://domain.com/dashboard/`
- `https://domain.com/browser/main/vnc.html` → `https://domain.com/dashboard/main/vnc.html`
- `https://domain.com/browser/media/` → `https://domain.com/dashboard/media/`

### 4. Code Changes in `deploy/dashboard.mjs` (renamed from `novnc-proxy.mjs`)

- Line 33: `process.env.NOVNC_BASE_PATH` → `process.env.DASHBOARD_BASE_PATH`
- All `[novnc-proxy]` log prefixes → `[dashboard]`
- Top-of-file comment block: Update description to reflect dashboard role (browsers, media, future logs)
- Auto-detect log message: update env var name reference
- Page titles: "OpenClaw Browser Sessions" → "OpenClaw Dashboard" (index page)
- Update media link text on index page to mention it's part of dashboard

### 5. `deploy/docker-compose.override.yml`

- Line 42: Comment `# noVNC reverse proxy` → `# Dashboard server — browser sessions, media, logs`
- Line 61: Volume `./deploy/novnc-proxy.mjs:/app/deploy/novnc-proxy.mjs:ro` → `./deploy/dashboard.mjs:/app/deploy/dashboard.mjs:ro`
- Lines 95-97: Comment + env var `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH`

### 6. `deploy/entrypoint-gateway.sh`

- Lines 209-218 (Section 2b):
  - Comment: "Start noVNC reverse proxy" → "Start dashboard server"
  - Variable: `NOVNC_PROXY` → `DASHBOARD_SERVER`
  - Path: `/app/deploy/novnc-proxy.mjs` → `/app/deploy/dashboard.mjs`
  - Log message: `noVNC proxy started` → `Dashboard server started`

### 7. `deploy/openclaw.json`

- Line 147 comment: Update "browser" reference to mention dashboard
  - No structural config changes needed (browser sandbox settings are separate from the dashboard server)

### 8. `openclaw-config.env.example`

- Line 19: `OPENCLAW_BROWSER_DOMAIN_PATH=/browser` → `OPENCLAW_DASHBOARD_DOMAIN_PATH=/dashboard`
- Line 19 comment: Update to reference dashboard
- Line 20: Update "Cloudflare Tunnel" comment

### 9. `docs/DASHBOARD.md` (renamed from `docs/BROWSER-VNC.md`)

- Title: "Browser VNC Access" → "Dashboard"
- Opening description: Mention browsers, media files, logs (future)
- URL Configuration table: `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`
- All `/browser` example paths → `/dashboard`
- `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH`
- References to `novnc-proxy.mjs` → `dashboard.mjs`
- Section titles updated to reflect broader dashboard scope
- Cross-references from other docs remain valid (update link targets)

### 10. `docs/CLOUDFLARE-TUNNEL.md`

- Tunnel route examples: `/browser` → `/dashboard`
- `OPENCLAW_BROWSER_DOMAIN_PATH=/browser` → `OPENCLAW_DASHBOARD_DOMAIN_PATH=/dashboard`
- `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH`
- Architecture diagram: update `/browser/*` route label
- Comment about noVNC → dashboard

### 11. `docs/CLAUDE_INSTALL.md`

- Update any `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`
- Update `/browser` path references → `/dashboard`

### 12. `CLAUDE.md`

- Line 52: `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH` in the config comment

### 13. Playbooks

**`playbooks/00-fresh-deploy-setup.md`:**

- Line 7, 45, 62: `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`
- Line 209: `/browser` curl example → `/dashboard`

**`playbooks/04-vps1-openclaw.md`:**

- Line 39: Variable description updated
- Lines 207-208, 229-231: `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH`, `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`
- Lines 259-260: `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH` in verification echo

**`playbooks/07-verification.md`:**

- Line 237: `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`

**`playbooks/08-post-deploy.md`:**

- Line 354: "Browser VNC" → "Dashboard" in deployment summary table
- `OPENCLAW_BROWSER_DOMAIN_PATH` → `OPENCLAW_DASHBOARD_DOMAIN_PATH`

**`playbooks/maintenance.md`:**

- Line 149: `novnc-proxy.mjs` → `dashboard.mjs` in bind-mounted files list

### 14. Notes

**`notes/TODO.md`:**

- Mark "Rename novnc-proxy" task as complete
- Update `/browser` reference in the pairing test TODO

**`notes/active-issues/sandbox-bind-mount-overview.md`:**

- Line 22: `novnc-proxy.mjs` → `dashboard.mjs` in bind mount table (if still accurate)

### 15. VPS Deployment (post-approval)

After the code changes, deploy to VPS:

1. SCP renamed `dashboard.mjs` to VPS
2. Update VPS `.env` file: `NOVNC_BASE_PATH` → `DASHBOARD_BASE_PATH=/dashboard`
3. Update VPS `docker-compose.override.yml` volume mount path
4. Restart gateway container (`docker compose up -d`)
5. Update Cloudflare Tunnel route: `/browser` → `/dashboard`
6. Verify dashboard accessible at new URL

## Files Modified (17 total)

| File | Change Type |
|------|------------|
| `deploy/novnc-proxy.mjs` → `deploy/dashboard.mjs` | Rename + code edits |
| `deploy/docker-compose.override.yml` | Env var + volume path |
| `deploy/entrypoint-gateway.sh` | Variable + path + comments |
| `deploy/openclaw.json` | Comment only |
| `docs/BROWSER-VNC.md` → `docs/DASHBOARD.md` | Rename + content update |
| `docs/CLOUDFLARE-TUNNEL.md` | Path + env var references |
| `docs/CLAUDE_INSTALL.md` | Env var references |
| `CLAUDE.md` | Env var reference |
| `openclaw-config.env.example` | Env var rename |
| `playbooks/00-fresh-deploy-setup.md` | Env var + path references |
| `playbooks/04-vps1-openclaw.md` | Env var + path references |
| `playbooks/07-verification.md` | Env var reference |
| `playbooks/08-post-deploy.md` | Label + env var |
| `playbooks/maintenance.md` | Filename reference |
| `notes/TODO.md` | Mark task complete |
| `notes/active-issues/sandbox-bind-mount-overview.md` | Filename reference |

## Verification

1. `grep -ri 'novnc.proxy\|NOVNC_BASE_PATH\|BROWSER_DOMAIN_PATH\|/browser' deploy/ docs/ playbooks/ CLAUDE.md openclaw-config.env.example` — should return zero hits (except `OPENCLAW_BROWSER_DOMAIN` which stays)
2. SSH to VPS → restart gateway → `curl http://127.0.0.1:6090/dashboard/` returns index page
3. Cloudflare Tunnel route updated → `https://domain.com/dashboard/` loads through tunnel
4. Browser sessions still accessible at `/dashboard/main/vnc.html`
5. Media files accessible at `/dashboard/media/`
