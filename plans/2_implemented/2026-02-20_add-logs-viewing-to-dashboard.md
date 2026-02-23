# Plan: Add Logs Explorer to Dashboard

## Context

The debug-sessions TUI (`scripts/debug-sessions/`) provides session transcript and LLM call browsing via SSH from the local machine. We want the same functionality accessible in the web dashboard (`deploy/dashboard/`) which runs inside the gateway container and has direct filesystem access to the log files. This avoids SSH and makes logs browsable from any device.

## Architecture

Follow the exact existing dashboard patterns:

- **Data module**: `data/logs.mjs` — reads JSONL files directly (like `data/stats.mjs`)
- **Page handler**: `pages/logs.mjs` — serves HTML + API endpoints (like `pages/stats.mjs`)
- **HTML template**: `html/logs.html` — vanilla JS with inline `<script>` (like `html/stats.html`)
- **CSS**: append to `public/dashboard.css`

No Python dependency — port the relevant parsing logic from `debug-sessions.py` to Node.js.

## Files to Create

### 1. `deploy/dashboard/data/logs.mjs`

Port core logic from `scripts/debug-sessions/debug-sessions.py` to Node.js.

**Paths** (same as `data/stats.mjs`):

```
AGENTS_BASE = /home/node/.openclaw/agents
LLM_LOG = /home/node/.openclaw/logs/llm.log
```

**Exported functions**:

| Function | Equivalent Python cmd | Returns |
|----------|----------------------|---------|
| `getSessions(agentFilter)` | `list --json` | `SessionInfo[]` |
| `getLlmCalls(agentFilter, modelFilter)` | `llm-list --json` | `LlmCallInfo[]` |
| `getSummary()` | `summary --json` + `llm-summary --json` | Aggregate stats |
| `getSessionMetrics(sessionId, agent)` | `metrics <id> --json` | Deep session metrics |
| `getSessionTrace(sessionId, agent)` | Structured trace | `TraceEntry[]` |

**Internal helpers** (ported from Python):

- `discoverSessions()` — walk agent dirs, find `.jsonl` files
- `parseSessionFile()` — read JSONL line-by-line
- `analyzeSession()` — single-pass: tokens, cost, turns, tools, errors
- `parseLlmLog()` — pair `llm_input`/`llm_output` by runId
- `estimateCost()` — model pricing lookup (same `MODEL_PRICING` table)
- `findSession()` — exact/prefix match
- `extractText()`, `isErrorResult()`, `truncate()`

**Caching**: 30-second debounce for `getSessions` and `getLlmCalls` (same pattern as `stats.mjs`). Per-session endpoints (`metrics`, `trace`) are uncached (single file, on-demand).

**Key design decision — structured trace**: Instead of generating ANSI and converting to HTML, `getSessionTrace()` returns typed entries:

```js
{ type: 'user', text: '...' }
{ type: 'assistant_text', text: '...' }
{ type: 'assistant_thinking', text: '...' }
{ type: 'tool_call', step: 1, name: 'exec', summary: 'ls -la' }
{ type: 'tool_result', step: 1, toolName: 'exec', isError: false, text: '...' }
{ type: 'turn_meta', parts: ['tokens: 1,234', 'cost: $0.12'] }
```

Frontend renders with CSS classes that respect the active theme.

### 2. `deploy/dashboard/pages/logs.mjs`

**API endpoints**:

| Route | Handler |
|-------|---------|
| `GET /logs/` | Serve HTML page |
| `GET /logs/api/sessions?agent=` | `getSessions()` |
| `GET /logs/api/llm-calls?agent=&model=` | `getLlmCalls()` |
| `GET /logs/api/summary` | `getSummary()` |
| `GET /logs/api/session/:id/metrics?agent=` | `getSessionMetrics()` |
| `GET /logs/api/session/:id/trace?agent=` | `getSessionTrace()` |

### 3. `deploy/dashboard/html/logs.html`

**Layout**:

- Summary stat cards at top (total sessions, cost, tokens, LLM calls, errors)
- Tab switcher: **Sessions** | **LLM Calls**
- Agent filter dropdown (+ model filter for LLM tab)
- Sortable data tables (click column headers)
- Click session row → detail panel with **Metrics** | **Trace** sub-tabs
- 60-second auto-refresh for list data

**JS patterns** (matching existing pages):

- `const $ = id => document.getElementById(id)`
- `const esc = s => ...` for XSS safety
- `fetch(BASE + '/logs/api/...')` with cache-bust `?t=Date.now()`
- `loadData()` fetches sessions + llm-calls + summary in parallel
- `render()` updates DOM with change detection

### 4. CSS additions to `deploy/dashboard/public/dashboard.css`

- `.sortable` — clickable column headers with hover state + arrow indicators
- `.trace-output` — monospace container for trace entries
- `.trace-user` — cyan accent border-left for user messages
- `.trace-assistant-text` — standard text color
- `.trace-thinking` — dim/italic for thinking blocks
- `.trace-tool-call`, `.trace-tool-name`, `.trace-tool-summary` — yellow name, dim args
- `.trace-tool-result`, `.trace-tool-ok`, `.trace-tool-error` — green check / red X
- `.trace-turn-meta` — dim metadata line with bottom border
- `.trace-step` — fixed-width step number bracket
- `.logs-filter` — styled select dropdowns matching dashboard theme
- `.metrics-grid`, `.metrics-kv` — key-value layout for metrics panel

## Files to Modify

### 5. `deploy/dashboard/server.mjs`

- Import `handleLogs` from `./pages/logs.mjs`
- Add route: `if (path === '/logs' || path.startsWith('/logs/'))` (between media and browser API routes)
- Add `'logs'` to auto-detect base path exclusion list (line ~156)

### 6. `deploy/dashboard/layout.mjs`

- Add nav link `<a href="${bp}/logs/">Logs</a>` between Stats and Media (line ~39)

## Data Flow

```
Page load → 3 parallel fetches (sessions, llm-calls, summary) → render tables
Click row → 2 parallel fetches (metrics, trace) → render detail panel
Auto-refresh 60s → re-fetch lists (NOT detail panel)
```

## Implementation Order

1. `data/logs.mjs` — data module (foundation, can be tested independently)
2. `html/logs.html` — HTML + inline JS
3. `public/dashboard.css` — trace and sorting styles
4. `pages/logs.mjs` — page handler wiring
5. `server.mjs` — route + exclusion list
6. `layout.mjs` — nav link

## Verification

1. Deploy dashboard to VPS (bind-mount is already configured)
2. Navigate to `/logs/` — should show sessions list
3. Click column headers — verify sorting works
4. Filter by agent — verify dropdown filters
5. Switch to LLM Calls tab — verify LLM data loads
6. Click a session row — verify metrics panel shows token/cost breakdown
7. Switch to Trace sub-tab — verify structured trace renders with themed colors
8. Test auto-refresh — verify list updates every 60s without losing detail panel
9. Test with different themes — verify trace colors use CSS variables
