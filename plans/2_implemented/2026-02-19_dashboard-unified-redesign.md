>  i like this dashboard. let's make the the primary dashboard at /dashboard and effectively replace the current one.
> In the image, i mocked up a layout for adding boxes for Agent Browsers and Browser Media.  Also added header links
> to go back to /chat /config /logs (OpenClaw's Control UI - make sure these links use the correct base URL from our
> configs). We'll also need to support browsing the full media folder (like we currently do) but wrapped in the new
> UI.
>
> So a few clean up things....
>
> 1. Let's reorg the code into deploy/dashboard for all dashboard related code
> 2. dashboard.mjs should probably be renamed to index.mjs or server.mjs and only handle the auth and routing - just
> the node server entrypoint that then loads in other js and html files
> 3. Reorg the code and rename the files to make it easy to maintain and modular - one main file for handling the
> look and feel (the chrome) of the whole dashboard system, then separate files for stats, media, etc.
>
> Requirements:
>
>- One look and feel for our whole 'dashboar' system - not separate CSS per module (stats, media, etc.)
>- Shared header and footer for all sub route pages
>- One clear entrypoint (server.mjs) that handles port binding, auth, routing, etc.
>- Modular code organization that makes it easy to add new route / pages as well as dashboard modules (boxes)
>
> We'll end up have these routes:
> /dashboard - main dashboard with select modules (boxes) displayed on the dashboard (shown in the image)
> /dashboard/media - file server with the same look and feel (inherited by same chrome code, not separate css)
> /dashboard/stats - the indepth stats page (currently the same as what's implemented but inheriting the chrome from
> the main dashboard)
>
> After this first pass, we'll likely remove some of the dashboard boxes to make it cleaner. But for now, the
> /dashboard and /dashboard/stats would be essentially the same except no browser or media stuff.
>
> Ask me if you have any questions. We're essentially implementing a lightweight framework here. Let me know if it
> makes any sense to use something like alpine.js or other existing framework to simplify things. Or if we should
> just keep it all vanilla.
>
> We'll be adding a lot more features to this dashboard system over the next few days. So good code higiene and file
> naming is important

# Plan: Dashboard System Refactor — Modular Architecture

## Context

The stats dashboard integration is complete and working well. Now we want to make it the PRIMARY dashboard, reorganize the monolithic `deploy/dashboard.mjs` (1076 lines) into a modular `deploy/dashboard/` directory, add shared chrome (header with nav links, CSS, theme engine) across all pages, and add new panels (Agent Browsers, Browser Downloads).

**Current state**: 4 flat files in `deploy/` — `dashboard.mjs` (monolith), `stats-dashboard.mjs`, `stats.html`, `stats-themes.json`.

**Target state**: `deploy/dashboard/` directory with clear separation of concerns, shared look and feel, and easy extensibility for new pages and panels.

## Framework Decision: Vanilla JS

No Alpine.js or other framework. Reasons:

- No build step needed (bind-mount deployment, no bundler)
- Stats page has complex rendering (SVG charts, dirty-checking DOM updates) that doesn't benefit from Alpine's declarative model
- CDN dependency = failure mode for an internal dashboard
- ES modules (`<script type="module">`) provide enough modularity for shared client-side code (theme engine, charts)
- Can always add Alpine.js later for specific interactive components without rewriting

## File Structure

```
deploy/dashboard/
├── server.mjs           (~350 lines)  Entry point: HTTP server, routing, noVNC proxy, static file serving
├── auth.mjs             (~250 lines)  CF Access JWT verification + device pairing (session cookies, paired.json watching)
├── layout.mjs           (~150 lines)  renderPage() — shared chrome: header, nav links, CSS/theme injection, footer
├── themes.json          (158 lines)   6 color themes (moved from stats-themes.json)
│
├── data/
│   └── stats.mjs        (~650 lines)  Stats data collection pipeline (moved from stats-dashboard.mjs)
│
├── pages/
│   ├── home.mjs         (~200 lines)  Home page handler + browser status helpers + media preview helpers
│   ├── stats.mjs        (~60 lines)   Stats page handler — thin wrapper, delegates to data/stats.mjs
│   └── media.mjs        (~150 lines)  Media browser: directory listing (in layout chrome) + file streaming
│
├── public/                            Client-side assets served at /public/*
│   ├── dashboard.css    (~250 lines)  ALL CSS for all pages (extracted from stats.html, plus new panel styles)
│   ├── theme-engine.js  (~80 lines)   Theme loading, applying, and picker UI (shared by all pages)
│   └── charts.js        (~100 lines)  SVG chart renderers: cost trend, cost by model, sub-agent activity
│
└── html/                              Page body templates (injected into layout chrome by page handlers)
    ├── home.html        (~500 lines)  Home page body + inline JS (all panels + browsers + media preview)
    └── stats.html       (~700 lines)  Stats page body + inline JS (all stats panels, detailed view)
```

**14 files, ~3250 lines total** (vs 4 files, ~3100 lines — similar total but includes new features).

## Architecture Patterns

### Server-side template composition

```
Request → server.mjs (auth check) → router → page handler
                                                   ↓
                                              layout.mjs renderPage({ title, body, basePath })
                                                   ↓
                                              Full HTML: chrome wrapper + page body
```

Each page handler:

1. Gathers data (from `data/stats.mjs`, browser helpers, etc.)
2. Reads its HTML body template from `html/`
3. Injects runtime config (`window.__DASHBOARD_BASE`, initial data)
4. Calls `layout.renderPage()` to wrap body in shared chrome
5. Sends the complete HTML response

### Shared layout chrome (`layout.mjs`)

`renderPage({ title, bodyHtml, headExtra, basePath, controlUiBase })` returns:

```html
<!DOCTYPE html><html>
<head>
  <link rel="stylesheet" href="${basePath}/public/dashboard.css">
  <script>window.__DASHBOARD_BASE="${basePath}";</script>
  <script type="module" src="${basePath}/public/theme-engine.js"></script>
  ${headExtra}
</head>
<body>
  <div class="container">
    <header>
      ⚡ OpenClaw Dashboard
      <nav>Chat | Config | Logs</nav>        ← links to Control UI
      <span id="countdown">—</span>
      <button id="refreshBtn">↻ Refresh</button>
      <div id="themePicker">...</div>
    </header>
    ${bodyHtml}                                ← page-specific content
  </div>
</body></html>
```

- Header nav links point to Control UI: `${controlUiBase}/chat`, `${controlUiBase}/config`, `${controlUiBase}/logs`
- No "Online" dot in the header (redundant — Gateway health box shows it)
- Theme picker in header (shared across all pages)
- Countdown timer + Refresh button in header

### Client-side JS sharing

Three shared modules served from `public/`:

- **`theme-engine.js`** — must be shared (theme state in localStorage persists across pages)
- **`charts.js`** — both home and stats render the same 3 SVG charts
- **`dashboard.css`** — all CSS custom properties + all component classes

Other rendering code (health row, cost cards, tables, agent tree, etc.) stays inline in each page's HTML template for now. This avoids premature abstraction — when the pages diverge (user plans to trim home page panels), inline code is easier to modify independently.

### Static file serving

`server.mjs` handles `GET /public/*` by reading from the `public/` directory with:

- Path traversal protection (resolved path must stay within `public/`)
- Allowlisted extensions only (`.css`, `.js`, `.json`)
- `Cache-Control: no-cache` (files can change on disk via bind mount)

### Data APIs

| Endpoint | Handler | Data |
|----------|---------|------|
| `GET /stats/api/refresh` | `pages/stats.mjs` | Full stats JSON (30s cache) |
| `GET /stats/themes.json` | `pages/stats.mjs` | Theme definitions (1hr cache) |
| `GET /api/browsers` | `pages/home.mjs` | Browser container status list (5s cache) |
| `GET /api/media/recent` | `pages/home.mjs` | Last 5 media files (no cache) |

Home page fetches `/stats/api/refresh` + `/api/browsers` + `/api/media/recent` in parallel.
Stats page fetches only `/stats/api/refresh`.

### Auth system (unchanged logic, extracted to auth.mjs)

Exports:

- `init()` — load paired.json, start watchers
- `check(req, res)` → `boolean` — runs both auth layers for HTTP, writes 403 on failure
- `checkWs(req, socket)` → `boolean` — auth for WebSocket upgrades
- `handleAuthPost(req, res)` — POST `/_auth` handler
- `authGatePage(basePath)` → `string` — device pairing HTML page
- `getEffectiveBP()` / `setEffectiveBP(bp)` — base path state (auto-detected on first request)

### Base path state

`effectiveBP` (auto-detected or from `DASHBOARD_BASE_PATH` env var) lives in `auth.mjs` as shared module state. All other modules import `getEffectiveBP()` from auth when they need to generate URLs.

## Environment Variable Changes

**Add to `docker-compose.override.yml` environment section:**

```yaml
- OPENCLAW_DOMAIN_PATH=${OPENCLAW_DOMAIN_PATH:-}
```

This is already in the `.env` file on the VPS but not passed to the container. The dashboard needs it to construct Control UI nav links (Chat, Config, Logs).

**No other new env vars needed.** `DASHBOARD_BASE_PATH` continues to work as before.

## Bind Mount Changes

**Before (4 individual file mounts):**

```yaml
- ./deploy/dashboard.mjs:/app/deploy/dashboard.mjs:ro
- ./deploy/stats-dashboard.mjs:/app/deploy/stats-dashboard.mjs:ro
- ./deploy/stats.html:/app/deploy/stats.html:ro
- ./deploy/stats-themes.json:/app/deploy/stats-themes.json:ro
```

**After (1 directory mount):**

```yaml
- ./deploy/dashboard:/app/deploy/dashboard:ro
```

Adding new pages/modules requires NO compose changes — just add files to the directory.

## Entrypoint Change

**In `deploy/entrypoint-gateway.sh`:**

```bash
# Before:
DASHBOARD_SERVER="/app/deploy/dashboard.mjs"
# After:
DASHBOARD_SERVER="/app/deploy/dashboard/server.mjs"
```

## What Moves Where

| Current file | → New location | What changes |
|-------------|----------------|--------------|
| `dashboard.mjs` auth code (lines 52–409) | `auth.mjs` | Extracted as-is |
| `dashboard.mjs` routing (lines 802–984) | `server.mjs` | Simplified dispatcher |
| `dashboard.mjs` noVNC proxy (lines 509–553, 963–1056) | `server.mjs` | Moved with WebSocket handler |
| `dashboard.mjs` browser helpers (lines 434–507) | `pages/home.mjs` | Only used by home page |
| `dashboard.mjs` media serving (lines 680–800) | `pages/media.mjs` | Wrapped in layout chrome |
| `dashboard.mjs` index page (lines 588–667) | `pages/home.mjs` | Replaced by new home page |
| `dashboard.mjs` CSS template (lines 555–586) | `public/dashboard.css` | Merged into shared CSS |
| `stats-dashboard.mjs` data collection (~650 lines) | `data/stats.mjs` | Route handler removed, data pipeline kept |
| `stats-dashboard.mjs` route handler (~45 lines) | `pages/stats.mjs` | Thin wrapper |
| `stats.html` CSS (~180 lines) | `public/dashboard.css` | Extracted + expanded |
| `stats.html` theme engine JS (~70 lines) | `public/theme-engine.js` | Extracted |
| `stats.html` chart renderers (~100 lines) | `public/charts.js` | Extracted |
| `stats.html` remaining HTML + JS | `html/stats.html` | Chrome removed (provided by layout) |
| `stats-themes.json` | `themes.json` | Moved into dashboard directory |

## Home Page Panels (from mockup)

The home page (`/dashboard/`) shows, top to bottom:

1. **Health row** — Gateway, Version, Active Sessions, Uptime, Memory, Compaction
2. **Two-column box row:**
   - **Agent Browsers** — lists browser containers with Running/Stopped status. Data from `docker inspect`. "Ask OpenClaw to start an agent browser if not running" footer text.
   - **Browser Downloads** — last 5 media files with type, size, download icon. "View All Media" link to `/dashboard/media`.
3. **Cost cards** — Today's Cost, All-Time Cost, Projected Monthly, Cost Breakdown donut
