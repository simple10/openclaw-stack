# Plan: Integrate openclaw-dashboard into dashboard.mjs

## Context

The `source/openclaw-dashboard/` project is a community-built OpenClaw monitoring dashboard (from github.com/mudrii/openclaw-dashboard) that provides 10+ panels of observability data: gateway health, LLM cost tracking (today/7d/30d/all-time by model), active sessions, cron status, sub-agent activity, agent configuration, and 30-day trend charts. It runs as a standalone Python server + bash/Python data collector, but we want to integrate it directly into the gateway's existing `deploy/dashboard.mjs` server — no separate container, no Python runtime, just Node.js.

**Why**: The gateway container already runs dashboard.mjs on port 6090 with CF Access + device pairing auth. Embedding the monitoring dashboard gives us auth for free and avoids the operational complexity of a separate container (which we already tried and rolled back with the old ClawMetry approach).

**What changes**: Port the data collection logic from Python to Node.js, serve the SPA frontend and API from dashboard.mjs at `/stats/*`.

## Architecture

```
Browser → CF Tunnel → dashboard.mjs (:6090, inside gateway container)
                          │
                          ├── /              → index page (browser sessions)
                          ├── /media/*       → media file serving
                          ├── /browser/*     → noVNC proxy
                          └── /stats/        → monitoring dashboard SPA
                              ├── /stats/api/refresh  → JSON data (collected by stats-collector.mjs)
                              └── /stats/themes.json  → theme definitions
```

Everything runs in the same Node.js process. Data is collected by reading files from `/home/node/.openclaw/` (already accessible to dashboard.mjs). Auth is inherited from dashboard.mjs's existing CF Access + device pairing layers.

## Decision: JavaScript, not TypeScript

Plain ESM JavaScript (.mjs), matching dashboard.mjs's existing pattern. Reasons:

- dashboard.mjs is 1066 lines of plain JS — consistency matters
- Bind-mount deployment has no build step (`./deploy/dashboard.mjs:/app/deploy/dashboard.mjs:ro`)
- While jiti exists in the container, adding a TS compile step for dashboard startup adds unnecessary complexity
- The data collector is mostly straightforward file I/O + JSON parsing — types add little value here

## Files to Create

### 1. `deploy/stats-dashboard.mjs` (~600 lines)

**Self-contained stats dashboard module.** Exports a single request handler function — this is the only interface with dashboard.mjs. Everything else (data collection, HTML serving, themes, debouncing) is internal to this module.

```javascript
// The only export — dashboard.mjs delegates all /stats/* requests to this
export async function handleStatsRequest(req, res, path, basePath)
```

**Internal structure** (all within this one file):

**A. Request handler** (~50 lines) — routes `/stats/`, `/stats/api/refresh`, `/stats/themes.json`

**B. Data collection** (~500 lines) — port of refresh.sh's inline Python. Reads all data from `/home/node/.openclaw/`:

| Source | What it provides |
|--------|-----------------|
| `openclaw.json` | Agent config, models, skills, hooks, plugins, bindings, compaction, channels |
| `agents/*/sessions/sessions.json` | Session metadata (active sessions, context %, types) |
| `agents/*/sessions/*.jsonl` | Token usage, costs, sub-agent tracking (line-by-line JSONL parsing) |
| `cron/jobs.json` | Cron job status, schedules, last run times |
| `pgrep` + `ps` | Gateway process health (PID, uptime, RSS) |
| `git log` | Recent workspace commits |

**C. HTML serving** (~10 lines) — reads `stats.html`, injects `<script>window.__STATS_BASE="${basePath}/stats";</script>` into `<head>`

**Key porting details**:

- JSONC comment stripping: reuse dashboard.mjs's existing pattern (line 448): `raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')`
- `model_name()` normalization: port the 20+ pattern matching rules directly (lines 363-389 of refresh.sh)
- Token bucket aggregation: port the `models_all/today/7d/30d` + `subagent_*` defaultdict pattern using plain JS objects
- Session JSONL parsing: `readFileSync` + `split('\n')` + `JSON.parse` per line (with try/catch per line)
- Gateway health: `execFile('pgrep', ['-f', 'node.*dist/index.js.*gateway'])` + `execFile('ps', ['-p', pid, '-o', 'etime=,rss='])`
- Git log: `execFile('git', ['-C', openclawPath, 'log', '--oneline', '-5', '--format=%h|%s|%ar'])`
- Timezone: use the system timezone (UTC in production, set by `TZ=UTC` in docker-compose) instead of hardcoded GMT+8
- File globbing: `readdirSync` for `agents/*/sessions/` directories (no native glob needed)
- Debouncing: 30-second cache built into the module (matches original `_debounce_sec = 30`)

**Output**: Returns the same JSON shape as the original `data.json` — the SPA frontend consumes it unchanged.

**Swappability**: To upgrade or replace the stats dashboard, only `stats-dashboard.mjs` (and optionally `stats.html`/`stats-themes.json`) need to change. dashboard.mjs is untouched as long as the `handleStatsRequest(req, res, path, basePath)` export signature is preserved.

### 2. `deploy/stats.html` (~1060 lines)

Copy of `source/openclaw-dashboard/index.html` with two URL modifications:

1. **`loadThemes()` fetch** (line 479):

   ```javascript
   // Before:
   const r = await fetch('/themes.json?t='+Date.now());
   // After:
   const r = await fetch(window.__STATS_BASE + '/themes.json?t='+Date.now());
   ```

2. **`loadData()` fetch** (line 583):

   ```javascript
   // Before:
   const r = await fetch('/api/refresh?t='+Date.now());
   // After:
   const r = await fetch(window.__STATS_BASE + '/api/refresh?t='+Date.now());
   ```

The `window.__STATS_BASE` global is injected by `stats-dashboard.mjs` when serving the HTML. Just two URL prefixes — no global fetch/EventSource monkey-patching.

### 3. `deploy/stats-themes.json` (159 lines)

Direct copy of `source/openclaw-dashboard/themes.json`. Six themes (3 dark, 3 light).

## Files to Modify

### 4. `deploy/dashboard.mjs` — Minimal wiring (~8 lines added)

**Only 4 touch points** — all minimal, all easily removable:

**a. Import** (top of file, with other imports):

```javascript
import { handleStatsRequest } from '/app/deploy/stats-dashboard.mjs'
```

**b. Auto-detect exclusion** (line 839, add `'stats'` to the known-route list):

```javascript
seg[1] !== 'stats' &&
```

**c. Route delegation** (after `/media` handler ~line 898, before `/browser` ~line 901):

```javascript
// Stats dashboard — all /stats/* routes handled by separate module
if (path === '/stats' || path.startsWith('/stats/')) {
  return handleStatsRequest(req, res, path, effectiveBP)
}
```

**d. Index page link** (in `indexPage()` function, alongside existing media link):

```html
<p style="margin-top: 16px;"><a href="${effectiveBP}/stats/">&#128200; Stats Dashboard</a> — costs, sessions, agents, and trends</p>
```

**To remove the stats dashboard entirely**: delete the 4 lines above + remove the 3 bind mounts from docker-compose. No other changes needed.

### 5. `deploy/docker-compose.override.yml` — Add bind mounts

Add to the gateway service `volumes:` section:

```yaml
# Stats dashboard: self-contained monitoring module, SPA frontend, and themes
- ./deploy/stats-dashboard.mjs:/app/deploy/stats-dashboard.mjs:ro
- ./deploy/stats.html:/app/deploy/stats.html:ro
- ./deploy/stats-themes.json:/app/deploy/stats-themes.json:ro
```

No new container. No new environment variables. No entrypoint changes.

## Data Collection: Python → Node.js Porting Guide

The refresh.sh inline Python (~680 lines) maps to these Node.js sections:

| Python Section | Lines | Node.js Approach |
|---------------|-------|-----------------|
| Bot config + alert thresholds | 43-63 | Read optional `config.json` (or skip — use defaults) |
| Gateway health (pgrep/ps) | 66-85 | `execFile('pgrep', ...)` + `execFile('ps', ...)` |
| OpenClaw config parsing | 87-237 | `readFileSync` + JSONC strip + deep property access |
| Session metadata | 241-311 | `readdirSync` agents dir, read each `sessions.json` |
| Cron jobs | 313-360 | `readFileSync` cron/jobs.json, format schedule strings |
| Token usage from JSONL | 362-536 | Line-by-line JSONL parsing, bucket aggregation |
| Daily chart data | 543-572 | Same aggregation logic, last 30 days |
| Git log | 587-596 | `execFile('git', ...)` |
| Alerts | 599-621 | Threshold checks on computed data |
| Cost breakdown | 622-641 | Sort + format |
| Output assembly | 644-704 | Return plain object |

The most complex section is JSONL token parsing (lines 362-536, ~175 lines of Python). In Node.js this becomes roughly the same — `readFileSync` each `.jsonl` file, split by newline, `JSON.parse` each line, aggregate into buckets.

## What Won't Work (and That's Fine)

| Feature | Status | Reason |
|---------|--------|--------|
| `pgrep -f openclaw-gateway` | Won't match | Inside the container, the process is `node dist/index.js gateway`, not `openclaw-gateway`. Use `pgrep -f "dist/index.js.*gateway"` instead. |
| `config.json` (bot name/emoji) | Not deployed | The dashboard config file isn't deployed. Use defaults or make configurable later. |
| Hardcoded GMT+8 timezone | Changed to UTC | Container runs `TZ=UTC`. Dashboard will show UTC times (consistent with gateway logs). |
| `install.sh` / LaunchAgent | Not needed | No standalone service — runs inside dashboard.mjs |

## Deployment Steps

1. Create the three new files locally (`deploy/stats-dashboard.mjs`, `deploy/stats.html`, `deploy/stats-themes.json`)
2. Modify `deploy/dashboard.mjs` (~8 lines: import, route delegation, auto-detect exclusion, index link)
3. Modify `deploy/docker-compose.override.yml` (add 3 bind mounts)
4. Deploy to VPS:
   - Copy new + updated files to `/home/openclaw/openclaw/deploy/`
   - New bind mounts require: `docker compose up -d --force-recreate openclaw-gateway`

## Verification

1. **Container starts**: `docker compose ps` — gateway healthy
2. **Stats page loads**: `curl -s http://localhost:6090/stats/` — returns HTML
3. **API works**: `curl -s http://localhost:6090/stats/api/refresh` — returns JSON with cost/session data
4. **Themes load**: `curl -s http://localhost:6090/stats/themes.json` — returns theme JSON
5. **Through tunnel**: Navigate to `https://<domain>/dashboard/stats/` in browser
6. **Auth works**: CF Access + device pairing gate both apply (inherited from dashboard.mjs)
7. **Verify data accuracy**: Compare cost totals and session counts with manual inspection of JSONL files
8. **Index page link**: Main dashboard index shows "Stats Dashboard" link
9. **Auto-refresh**: Dashboard auto-refreshes every 60s, countdown timer visible
10. **Theme switching**: All 6 themes work (Midnight, Nord, Catppuccin Mocha, GitHub Light, Solarized Light, Catppuccin Latte)

## Implementation Order

1. `deploy/stats-themes.json` — trivial copy
2. `deploy/stats.html` — copy + two URL modifications
3. `deploy/stats-dashboard.mjs` — the main work (port Python data collection to Node.js + request handler)
4. `deploy/dashboard.mjs` — minimal wiring (~8 lines, depends on #3)
5. `deploy/docker-compose.override.yml` — add bind mounts
6. Test locally if possible, then deploy to VPS
