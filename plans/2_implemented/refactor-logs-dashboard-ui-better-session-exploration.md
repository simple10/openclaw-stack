# Plan: Refactor Logs UI — Session Detail as Separate Page

## Context

The logs explorer currently shows session detail (metrics + trace) in an expandable panel at the bottom of the sessions list page. This is awkward — the user clicks a row, then has to scroll down to see the detail. We want to make session detail a proper separate page view. Also removing the LLM Calls tab from the main list and instead making it a toggle within the session trace view (scoped to that session).

## Changes

### 1. `deploy/dashboard/html/logs.html` — Major rewrite

**Main list view** (shown by default):

- Keep summary cards row
- Keep agent filter dropdown
- Keep sortable sessions table
- **Remove**: Sessions/LLM Calls tab switcher
- **Remove**: LLM Calls table and panel
- **Remove**: Model filter dropdown
- **Remove**: Bottom detail panel (metrics/trace)
- Clicking a session row navigates to detail view (client-side, not a new HTTP page)

**Session detail view** (shown when a session is selected):

- Back button at top: `← Back to Sessions`
- Session header: agent/sessionId, status badge, key stats inline
- Metrics section (always visible, not tabbed)
- Below metrics: trace section with **Session Trace | LLM Calls** toggle
  - Session Trace: the existing structured trace output
  - LLM Calls: filtered LLM calls for this specific session (uses existing `/api/llm-calls` with session filter, or a new endpoint)
- Remove the `.trace-output` max-height cap so trace fills the page

**Implementation approach**: Single HTML file with two `<div>` views toggled via JS. No server-side routing changes needed — it's all client-side state. The URL stays at `/logs/` (no need for `/logs/session/:id` server routes since this is a SPA-style toggle).

### 2. `deploy/dashboard/data/logs.mjs` — Add session filter to getLlmCalls

The existing `getLlmCalls(agentFilter, modelFilter)` needs a third parameter: `sessionFilter`. When provided, filter LLM calls to only those matching the session ID.

```
getLlmCalls(agentFilter, modelFilter, sessionFilter)
```

### 3. `deploy/dashboard/pages/logs.mjs` — Wire session filter

Pass `session` query param through to `getLlmCalls()`:

```
GET /logs/api/llm-calls?agent=&model=&session=<id>
```

### 4. `deploy/dashboard/public/dashboard.css` — Minor tweaks

- Remove `.trace-output { max-height: 600px }` (let trace fill the page)
- Add `.back-link` style for the back button

## Files to Modify

| File | Change |
|------|--------|
| `deploy/dashboard/html/logs.html` | Major rewrite — two-view SPA layout |
| `deploy/dashboard/data/logs.mjs` | Add `sessionFilter` param to `getLlmCalls()` |
| `deploy/dashboard/pages/logs.mjs` | Pass `session` query param to `getLlmCalls()` |
| `deploy/dashboard/public/dashboard.css` | Remove trace max-height, add back-link style |

## Verification

1. Deploy to VPS
2. `/logs/` shows sessions list only (no LLM tab)
3. Click a session → detail view with back button, metrics at top, trace below
4. Toggle between Session Trace and LLM Calls within the detail view
5. Back button returns to session list (preserving agent filter)
6. Auto-refresh still works on the list view
