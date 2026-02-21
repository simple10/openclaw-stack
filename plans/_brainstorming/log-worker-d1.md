Plan: D1 Data Model for Session & LLM Telemetry

Context

The log-receiver worker already receives llemtry spans (LLM telemetry) from the gateway's llm-logger
plugin and forwards them to Langfuse. We want to also persist this data in Cloudflare D1 to power a
session explorer UI that shows the flow of each session: user inputs, LLM calls, tool invocations, and
costs.

User choices:

- Hybrid granularity — runs from llemtry + tool_calls summary table
- Summarized content — first ~500 chars of prompt/response (not full content)
- Multi-agent linking — parent_session_id for delegation chains
- Drizzle ORM — TypeScript schema, type-safe queries, drizzle-kit migrations

Data Source: What Llemtry Provides

Each span = one "run" (user message → [LLM + tool loop] → final response). Key fields:

- traceId = sessionId, spanId = runId
- Token usage (input, output, cache_read, cache_write)
- Model, agent, stop_reason, timestamps
- gen_ai.content.prompt event → { system, messages, prompt }
- gen_ai.content.completion event → full last assistant message (with tool_use blocks)

Known gap: For multi-tool runs (e.g., 3 tool calls before a final text response), llemtry captures only
the LAST assistant response. If that response is text-only, no tool_use blocks are present and the
tool_calls table will be empty for that run. Enhancement path documented below.

Schema (Drizzle)

workers/log-receiver/src/db/schema.ts

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

export const modelPricing = sqliteTable('model_pricing', {
  model:      text('model').primaryKey(),
  input:      real('input').notNull().default(0),       // $/1M input tokens
  output:     real('output').notNull().default(0),
  cacheRead:  real('cache_read').notNull().default(0),
  cacheWrite: real('cache_write').notNull().default(0),
  updatedAt:  text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const sessions = sqliteTable('sessions', {
  sessionId:        text('session_id').primaryKey(),
  agentId:          text('agent_id'),
  sessionKey:       text('session_key'),
  parentSessionId:  text('parent_session_id'),
  model:            text('model'),
  status:           text('status').notNull().default('active'),

  // Aggregates (incremented per run upsert)
  runCount:          integer('run_count').notNull().default(0),
  toolCallCount:     integer('tool_call_count').notNull().default(0),
  totalInputTokens:  integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  totalCacheRead:    integer('total_cache_read').notNull().default(0),
  totalCacheWrite:   integer('total_cache_write').notNull().default(0),
  totalCostUsd:      real('total_cost_usd').notNull().default(0),
  totalDurationMs:   integer('total_duration_ms').notNull().default(0),

  // Content previews (~500 chars)
  firstUserPrompt:   text('first_user_prompt'),
  lastAssistantText: text('last_assistant_text'),

  startedAt:  text('started_at').notNull(),
  updatedAt:  text('updated_at').notNull(),
  instanceId: text('instance_id'),
  hostname:   text('hostname'),
}, (t) => [
  index('idx_sessions_updated').on(t.updatedAt),
  index('idx_sessions_agent').on(t.agentId, t.updatedAt),
  index('idx_sessions_parent').on(t.parentSessionId),
])

export const runs = sqliteTable('runs', {
  runId:     text('run_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.sessionId),
  agentId:   text('agent_id'),
  model:     text('model'),
  status:    text('status').notNull().default('OK'),
  errorMessage: text('error_message'),
  stopReason:   text('stop_reason'),

  inputTokens:     integer('input_tokens').notNull().default(0),
  outputTokens:    integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costUsd:         real('cost_usd').notNull().default(0),

  startedAt:  text('started_at').notNull(),
  endedAt:    text('ended_at').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),

  userPrompt:        text('user_prompt'),          // ~500 chars
  assistantResponse: text('assistant_response'),    // ~500 chars
  toolCallCount:     integer('tool_call_count').notNull().default(0),

  maxTokens:   integer('max_tokens'),
  temperature: real('temperature'),
  imagesCount: integer('images_count'),
}, (t) => [
  index('idx_runs_session').on(t.sessionId, t.startedAt),
])

export const toolCalls = sqliteTable('tool_calls', {
  id:           text('id').primaryKey(),
  runId:        text('run_id').notNull().references(() => runs.runId),
  sessionId:    text('session_id').notNull(),       // denormalized
  name:         text('name').notNull(),
  inputSummary: text('input_summary'),              // ~200 chars
  seq:          integer('seq').notNull().default(0),
  createdAt:    text('created_at').notNull(),
}, (t) => [
  index('idx_tool_calls_run').on(t.runId, t.seq),
  index('idx_tool_calls_session').on(t.sessionId, t.createdAt),
])

// Relations (for Drizzle relational queries)
export const sessionsRelations = relations(sessions, ({ many }) => ({
  runs: many(runs),
}))

export const runsRelations = relations(runs, ({ one, many }) => ({
  session: one(sessions, { fields: [runs.sessionId], references: [sessions.sessionId] }),
  toolCalls: many(toolCalls),
}))

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
  run: one(runs, { fields: [toolCalls.runId], references: [runs.runId] }),
}))

Model Pricing Seed Data

Applied via migration seed or wrangler d1 execute:

INSERT INTO model_pricing (model, input, output, cache_read, cache_write, updated_at) VALUES
  ('claude-opus-4-6',   15.0, 75.0, 1.50, 18.75, '2026-02-20T00:00:00.000Z'),
  ('claude-sonnet-4-5',  3.0, 15.0, 0.30,  3.75, '2026-02-20T00:00:00.000Z'),
  ('claude-haiku-4-5',  0.80,  4.0, 0.08,  1.0,  '2026-02-20T00:00:00.000Z'),
  ('claude-sonnet-4',    3.0, 15.0, 0.30,  3.75, '2026-02-20T00:00:00.000Z'),
  ('claude-opus-4',     15.0, 75.0, 1.50, 18.75, '2026-02-20T00:00:00.000Z');

Cost formula: (tokens *price_per_million) / 1_000_000. Calculated at write time.

Implementation

1. Install dependencies

cd workers/log-receiver
npm install drizzle-orm
npm install -D drizzle-kit

1. Create D1 database

npx wrangler d1 create openclaw-telemetry

# Note the database_id from output

1. Add D1 binding + migrations_dir — wrangler.jsonc

"d1_databases": [{
  "binding": "DB",
  "database_name": "openclaw-telemetry",
  "database_id": "<from-step-2>",
  "migrations_dir": "drizzle"
}]

1. Create drizzle.config.ts

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})

Note: For remote introspection/push, add driver: 'd1-http' and dbCredentials with Cloudflare account
details. For our workflow (generate locally, apply via wrangler), the basic config suffices.

1. Generate + apply initial migration

npx drizzle-kit generate              # Creates drizzle/0000_*.sql
npx wrangler d1 migrations apply openclaw-telemetry --remote

1. Regenerate worker types

npx wrangler types

# Adds DB: D1Database to Env in worker-configuration.d.ts

1. Create workers/log-receiver/src/db/index.ts

Drizzle client factory:

import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

export type Db = ReturnType<typeof createDb>

1. Create workers/log-receiver/src/backends/d1.ts

Core persistence logic:

- persistToD1(spans, resource, d1, log) — creates Drizzle client, iterates spans
- persistSpan(db, span, resource) — per-span logic:
  a. Extract content previews (extractUserPrompt, extractAssistantText)
  b. Extract tool calls from completion event (extractToolCalls)
  c. Calculate cost from modelPricing table lookup
  d. Insert run via db.insert(runs).values(...).onConflictDoNothing()
  e. Upsert session via db.insert(sessions).values(...).onConflictDoUpdate(...) with SQL expressions for
  aggregate increments:
  import { sql } from 'drizzle-orm'
.onConflictDoUpdate({
  target: sessions.sessionId,
  set: {
    model: sql`excluded.model`,
    runCount: sql`${sessions.runCount} + 1`,
    toolCallCount: sql`${sessions.toolCallCount} + excluded.tool_call_count`,
    totalInputTokens: sql`${sessions.totalInputTokens} + excluded.total_input_tokens`,
    // ... other aggregates ...
    lastAssistantText: sql`excluded.last_assistant_text`,
    updatedAt: sql`excluded.updated_at`,
    firstUserPrompt: sql`COALESCE(${sessions.firstUserPrompt}, excluded.first_user_prompt)`,
  }
})
  f. Insert tool calls via db.insert(toolCalls).values([...]).onConflictDoNothing()
- Reuse MODEL_ALIAS_MAP from backends/langfuse.ts (extract to src/models.ts shared module)

1. Modify workers/log-receiver/src/llemtry.ts

Add D1 dispatch alongside Langfuse:

if (env.DB) {
  backends.push(persistToD1(batch.spans, batch.resource, env.DB, console.error))
}

1. Deploy

npx wrangler deploy

Migration Workflow (Ongoing)

1. Edit src/db/schema.ts
2. npx drizzle-kit generate                                    # Creates new SQL migration
3. npx wrangler d1 migrations apply openclaw-telemetry --remote # Apply to production
4. Commit drizzle/ migration files to git
5. npx wrangler deploy                                          # Deploy updated worker

Files Summary

File: workers/log-receiver/src/db/schema.ts
Action: Create — Drizzle schema definition
────────────────────────────────────────
File: workers/log-receiver/src/db/index.ts
Action: Create — Drizzle client factory
────────────────────────────────────────
File: workers/log-receiver/src/backends/d1.ts
Action: Create — D1 persistence backend
────────────────────────────────────────
File: workers/log-receiver/src/models.ts
Action: Create — shared MODEL_ALIAS_MAP (extracted from langfuse.ts)
────────────────────────────────────────
File: workers/log-receiver/src/backends/langfuse.ts
Action: Modify — import MODEL_ALIAS_MAP from shared module
────────────────────────────────────────
File: workers/log-receiver/src/llemtry.ts
Action: Modify — add D1 backend dispatch
────────────────────────────────────────
File: workers/log-receiver/wrangler.jsonc
Action: Modify — add d1_databases binding
────────────────────────────────────────
File: workers/log-receiver/drizzle.config.ts
Action: Create — Drizzle Kit configuration
────────────────────────────────────────
File: workers/log-receiver/drizzle/0000_*.sql
Action: Generated — initial migration
────────────────────────────────────────
File: workers/log-receiver/worker-configuration.d.ts
Action: Regenerate — npx wrangler types

Known Limitations & Enhancement Paths

Tool Calls Gap

The completion event only has the LAST assistant response. Multi-tool runs where the final response is
text-only will have empty tool_calls.

Enhancement: Modify deploy/plugins/llm-logger/index.js to populate the openclaw.tool_calls span
attribute by accumulating ALL tool_use blocks across the run. The field exists in the LlemtrySpan type
but is currently unused.

Parent Session Linking

The llemtry span doesn't carry parent_session_id. The openclaw.session.key has hints
(agent:code:subagent:uuid) but not the parent's sessionId.

Enhancement: Add openclaw.parent.session.id to span attributes in the llm-logger plugin.

Verification

1. Schema applied: wrangler d1 execute openclaw-telemetry --remote --command="SELECT name FROM
sqlite_master WHERE type='table';" → 4 tables
2. End-to-end: Trigger agent message, query: SELECT* FROM sessions ORDER BY updated_at DESC LIMIT 1;
3. Cost calculation: Verify cost_usd > 0 for runs using a priced model
4. Langfuse unaffected: Both backends run in parallel via Promise.allSettled
5. Drizzle Studio: npx drizzle-kit studio to visually inspect data

Storage Estimate

~2 KB per session (3 runs, 2 tool calls). At 100 sessions/day: ~6 MB/month, ~76 MB/year. Well within D1
free tier (500 MB).
