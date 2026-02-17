# Add `/browser/` Subpath for Browser Sessions in Dashboard

## Context

The dashboard server (`deploy/dashboard.mjs`) currently serves browser VNC sessions at `/<agent-id>/...` directly off the root. This makes it hard to add new top-level routes without risking collision with agent IDs. Restructure so browser sessions live under `/browser/<agent-id>/...`, keeping `/` for the index and `/media/` for downloads. This makes the URL namespace extensible.

**Current routing** (after base path stripping):

- `/` — index page
- `/media/...` — media files
- `/<agent-id>/` — redirect to vnc.html
- `/<agent-id>/*` — noVNC proxy
- `/<agent-id>/websockify` — WebSocket proxy

**New routing:**

- `/` — index page
- `/media/...` — media files
- `/browser/<agent-id>/` — redirect to vnc.html
- `/browser/<agent-id>/*` — noVNC proxy
- `/browser/<agent-id>/websockify` — WebSocket proxy

## Files to Modify

### 1. `deploy/dashboard.mjs` — routing changes

All changes are in the path matching and URL generation. Core proxy logic is untouched.

**A. HTTP route matching (line ~723):**

```javascript
// Current:
const match = path.match(/^\/([^/]+)(\/.*)?$/);
// New:
const match = path.match(/^\/browser\/([^/]+)(\/.*)?$/);
```

**B. WebSocket route matching (line ~814):**

```javascript
// Current:
const match = wsPath.match(/^\/([^/]+)(\/.*)?$/);
// New:
const match = wsPath.match(/^\/browser\/([^/]+)(\/.*)?$/);
```

**C. Index page links (line ~492):**

```javascript
// Current:
`<a href="${effectiveBP}/${id}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${id}/websockify">`
// New — add /browser/ segment to both href and ws path:
`<a href="${effectiveBP}/browser/${id}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}browser/${id}/websockify">`
```

**D. Redirect on bare `/<agent-id>/` (line ~737):**

```javascript
// Current:
Location: `${effectiveBP}/${agentId}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${agentId}/websockify`
// New:
Location: `${effectiveBP}/browser/${agentId}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}browser/${agentId}/websockify`
```

**E. Auto-detect exclusion list (line ~665):**
Add `'browser'` to the list of known segments that aren't treated as an auto-detected base path:

```javascript
// Current:
if (seg && seg[1] !== 'media' && seg[1] !== '_auth' && !findEntry(seg[1])) {
// New:
if (seg && seg[1] !== 'media' && seg[1] !== '_auth' && seg[1] !== 'browser' && !findEntry(seg[1])) {
```

**F. Add `/browser` bare route handler** — redirect `/browser` → `/browser/` → index (or just to index):
Before the regex match block, add a handler for bare `/browser` or `/browser/` that redirects to the index page. Users navigating to `/browser` should see the session list.

### 2. `docs/DASHBOARD.md` — update URL routing table and examples

Update the "URL Routing" table:

```
| `/` | Index page listing active browser sessions with live status |
| `/media/` | Directory listing of agent media files |
| `/browser/<agent-id>/` | Redirects to noVNC client |
| `/browser/<agent-id>/vnc.html?path=...` | noVNC client (proxied from browser container) |
| `/browser/<agent-id>/*` | HTTP proxy to browser container's noVNC static files |
| `/browser/<agent-id>/websockify` (WebSocket) | VNC stream proxy |
```

Update examples:

```
- Subdomain: `.../browser/main/vnc.html?path=browser/main/websockify`
- Subpath: `.../dashboard/browser/main/vnc.html?path=dashboard/browser/main/websockify`
```

Update troubleshooting: `?path=browser/<agent-id>/websockify`

### 3. `docs/TESTING.md` — update Phase 2.5 dashboard test URL

The test navigates to the dashboard index, which is unchanged (`/`). No change needed unless it references agent-specific paths. Review and update if needed.

### 4. `docs/SECURITY.md` — update flow diagram WebSocket path

Line ~509: `WS Upgrade /dashboard/<agent>/websockify` → `WS Upgrade /dashboard/browser/<agent>/websockify`

## NOT changing

- Base path logic (unchanged)
- Media routing (unchanged)
- Auth/pairing logic (unchanged)
- WebSocket proxy internals (unchanged — only path matching changes)
- Cloudflare Tunnel routes (unchanged — tunnel routes to `localhost:6090`, internal routing handles the rest)
- `OPENCLAW_DASHBOARD_DOMAIN` / `OPENCLAW_DASHBOARD_DOMAIN_PATH` config vars (unchanged)

## Verification

1. Check that `deploy/dashboard.mjs` has no remaining `\/([^/]+)` patterns that should be `\/browser\/([^/]+)`
2. Grep for old URL patterns in docs: `grep -r '/<agent-id>/' docs/` — should only show `/browser/<agent-id>/`
3. On VPS after deploy: navigate to `https://<domain>/dashboard/` — should show index with links containing `/browser/`
4. Click a browser session link — should load noVNC at `/dashboard/browser/<agent-id>/vnc.html`
