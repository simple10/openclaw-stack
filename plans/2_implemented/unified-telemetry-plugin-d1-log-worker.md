# Plan: Unified OpenClaw Telemetry Plugin + Log Worker D1 Storage

## Context

Currently OpenClaw has two separate logging mechanisms that overlap and leave gaps:

- **debug-logger hook** (`deploy/hooks/debug-logger/`) — captures gateway internal hook events (gateway:startup, agent:bootstrap, commands, sessions) to a local JSONL file, but in practice only fires for gateway:startup and agent:bootstrap
- **llm-logger plugin** (`deploy/plugins/llm-logger/`) — captures LLM input/output via typed plugin hooks, writes local JSONL + ships OTEL spans to Log Worker `/llemtry` endpoint for Langfuse

Neither captures the full picture. The richest data (tool calls, messages, compaction, session lifecycle) only exists in local session JSONL transcripts that aren't shipped anywhere. The dashboard currently reads these files directly, which only works when the dashboard runs inside the gateway container.

**Goal**: Replace both with a single `telemetry` plugin that:

1. Hooks into ALL OpenClaw event types via the typed plugin API
2. Ships structured event batches to a new Log Worker `/events` endpoint
3. Stores events in a D1 database for dashboard session exploration
4. Optionally writes local log files (configurable)
5. Continues shipping llemtry spans to Langfuse (existing functionality)
6. Granularity is configurable per event category (full/summary/metadata)

## Part 1: Unified Telemetry Plugin

### New plugin: `deploy/plugins/telemetry/`

Replaces both `llm-logger` plugin and `debug-logger` hook.

**Files:**

- `deploy/plugins/telemetry/openclaw.plugin.json` — plugin manifest + config schema
- `deploy/plugins/telemetry/index.js` — main plugin code

**Event hooks to register** (via `api.on()`):

| Hook | Category | Key fields |
|------|----------|------------|
| `llm_input` | llm | runId, sessionId, provider, model, prompt, systemPrompt, historyMessages |
| `llm_output` | llm | runId, sessionId, provider, model, usage, response, stopReason |
| `session_start` | session | sessionId, resumedFrom |
| `session_end` | session | sessionId, messageCount, durationMs |
| `before_compaction` | session | messageCount, tokenCount |
| `after_compaction` | session | compactedCount, tokenCount |
| `before_agent_start` | agent | prompt (system prompt about to be sent) |
| `agent_end` | agent | success, error, durationMs |
| `before_tool_call` | tool | toolName, params |
| `after_tool_call` | tool | toolName, result, error, durationMs |
| `message_received` | message | from, content, channelId |
| `message_sent` | message | to, content, success, error |
| `gateway_start` | gateway | port |
| `gateway_stop` | gateway | reason |

**Output destinations** (all configurable independently):

1. **Local file** (`~/.openclaw/logs/telemetry.log`) — JSONL, replaces both llm.log and debug.log
2. **Log Worker `/events`** — batched event shipping for D1 storage
3. **Log Worker `/llemtry`** — existing Langfuse span format (LLM events only)

**Configuration schema** (in `openclaw.json → plugins.entries.telemetry.config`):

```jsonc
{
  // Local file logging
  "logFile": "telemetry.log",  // empty string disables

  // Remote event shipping (D1 storage)
  "events": {
    "enabled": true,
    "url": "https://log-receiver.xxx.workers.dev/events",
    "authToken": "...",
    "batchSize": 50,        // flush after N events
    "flushIntervalMs": 10000 // flush every 10s
  },

  // Llemtry/Langfuse (LLM telemetry only, existing)
  "llemtry": {
    "enabled": true,
    "url": "https://log-receiver.xxx.workers.dev/llemtry",
    "authToken": "..."
  },

  // Per-category granularity: "full" | "summary" | "metadata" | "off"
  "categories": {
    "llm": "full",         // full prompts, responses, usage
    "session": "full",     // session lifecycle events
    "tool": "summary",     // tool name + truncated params/results
    "message": "summary",  // truncated message content
    "agent": "full",       // agent lifecycle
    "gateway": "metadata"  // just event type + timestamp
  }
}
```

**Granularity levels:**

- `full` — all available data, no truncation
- `summary` — metadata + truncated content (first 500 chars of text fields)
- `metadata` — event type, timestamps, IDs, durations, counts only (no content)
- `off` — don't capture this category at all

**Batching for `/events`**: Events are buffered in-memory and flushed when batch is full or timer fires. Each flush sends a POST to the Log Worker. Fire-and-forget with error logging (no retry — events are also in the local file as fallback).

**Event wire format** (sent to `/events`):

```json
{
  "instance": { "id": "...", "hostname": "..." },
  "events": [
    {
      "type": "llm_output",
      "category": "llm",
      "timestamp": "2026-02-21T00:49:45.001Z",
      "agentId": "main",
      "sessionId": "uuid",
      "sessionKey": "agent:main:main",
      "data": { /* category-specific fields */ }
    }
  ]
}
```

### Migration from existing plugins/hooks

- Remove `deploy/hooks/debug-logger/` directory
- Remove `deploy/plugins/llm-logger/` directory
- Update `deploy/entrypoint-gateway.sh` to stop copying debug-logger hook
- Update `deploy/openclaw.json` template: remove `llm-logger` plugin config, add `telemetry` plugin config
- Logrotate config: replace llm.log and debug.log entries with telemetry.log

## Part 2: Log Worker `/events` Endpoint + D1 Schema

### New endpoint: `POST /events`

**File:** `workers/log-receiver/src/events.ts`

Receives batched events from the telemetry plugin, validates, and inserts into D1.

### D1 Schema

```sql
-- Core events table — one row per event
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'llm_input', 'llm_output', 'session_start', etc.
  category TEXT NOT NULL,       -- 'llm', 'session', 'tool', 'message', 'agent', 'gateway'
  timestamp TEXT NOT NULL,      -- ISO 8601
  agent_id TEXT,
  session_id TEXT,
  session_key TEXT,
  instance_id TEXT,

  -- Common numeric fields (nullable, event-type-dependent)
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_total REAL,

  -- Type-specific metadata (small structured data)
  meta TEXT,                    -- JSON: model, provider, toolName, error, stopReason, etc.

  -- Full content (only when granularity = full or summary)
  content TEXT,                 -- JSON: prompt, response, params, result, message body

  created_at TEXT DEFAULT (datetime('now'))
);

-- Query patterns: session explorer, cost tracking, agent activity
CREATE INDEX idx_events_session ON events(session_id, timestamp);
CREATE INDEX idx_events_agent_time ON events(agent_id, timestamp);
CREATE INDEX idx_events_category ON events(category, timestamp);
CREATE INDEX idx_events_type ON events(type, timestamp);
```

**Design rationale:**

- Single table with `type`/`category` columns rather than per-type tables — simpler queries, D1 handles the volume fine
- `meta` JSON column for small structured data that varies by event type (model name, tool name, error message, stop reason)
- `content` JSON column for large content (prompts, responses, tool params/results) — only populated at full/summary granularity
- Common numeric fields are top-level columns for efficient aggregation queries (SUM, AVG on tokens/cost)

### Wrangler config changes

Add D1 binding to `workers/log-receiver/wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "openclaw-logs",
    "database_id": "<created-via-wrangler>"
  }
]
```

### Worker `Env` type update

```typescript
interface Env {
  AUTH_TOKEN: string
  LOGGABLE_LEVELS?: string
  LANGFUSE_BASE_URL?: string
  LANGFUSE_PUBLIC_KEY?: string
  LANGFUSE_SECRET_KEY?: string
  DB: D1Database  // new
}
```

## Part 3: Dashboard Integration (future — not in this PR)

Once events are in D1, the dashboard can query them via the Log Worker API instead of reading local JSONL files. This is a separate piece of work — for now the dashboard continues reading local files as-is.

## Files to Create

| File | Description |
|------|-------------|
| `deploy/plugins/telemetry/openclaw.plugin.json` | Plugin manifest with config schema |
| `deploy/plugins/telemetry/index.js` | Unified telemetry plugin |
| `workers/log-receiver/src/events.ts` | `/events` endpoint handler |
| `workers/log-receiver/src/schema.sql` | D1 migration script |

## Files to Modify

| File | Change |
|------|--------|
| `workers/log-receiver/src/index.ts` | Add `/events` route |
| `workers/log-receiver/wrangler.jsonc` | Add D1 binding |
| `deploy/openclaw.json` | Replace llm-logger config with telemetry config |
| `deploy/entrypoint-gateway.sh` | Remove debug-logger hook copy step (if exists) |

## Files to Remove (after migration verified)

| File | Reason |
|------|--------|
| `deploy/plugins/llm-logger/` | Replaced by telemetry plugin |
| `deploy/hooks/debug-logger/` | Replaced by telemetry plugin |

## Implementation Order

1. Create D1 database: `wrangler d1 create openclaw-logs`
2. Create schema migration and apply: `wrangler d1 execute openclaw-logs --file=src/schema.sql`
3. Build `/events` endpoint in Log Worker
4. Deploy Log Worker with D1 binding
5. Build telemetry plugin (file + events + llemtry outputs)
6. Deploy to VPS: add plugin, update openclaw.json config
7. Verify events flowing into D1: `wrangler d1 execute openclaw-logs --command="SELECT * FROM events LIMIT 5"`
8. Verify Langfuse still receiving spans
9. Remove old llm-logger plugin and debug-logger hook

## Verification

1. Send a message to an agent via Telegram or webchat
2. Check local file: `tail -f ~/.openclaw/logs/telemetry.log | jq .`
3. Check D1: `wrangler d1 execute openclaw-logs --command="SELECT type, category, agent_id, session_id FROM events ORDER BY id DESC LIMIT 20"`
4. Check Langfuse dashboard for new traces
5. Verify no orphaned debug.log or llm.log writes
6. Check gateway logs for `[telemetry]` plugin registration messages
