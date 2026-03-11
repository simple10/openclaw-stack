# Plan: Replace direct Langfuse with llmetry in AI Gateway Worker

## Context

The log receiver worker now has a `/llmetry` endpoint that accepts OTEL-inspired LLM telemetry spans and forwards them to Langfuse (and future backends). The `llm-logger` plugin already uses this endpoint. Currently the AI gateway worker has its own separate Langfuse integration with duplicate config (keys, URL). This change consolidates: the AI gateway sends llmetry spans to the log worker instead of talking to Langfuse directly.

## Scope

AI gateway worker only (`workers/ai-gateway/`). No deployment. No log worker changes.

## Changes

### 1. Rename `langfuse.ts` → `llmetry.ts` and rewrite

**Remove:**

- All Langfuse API client code (Basic auth, `/api/public/ingestion` POST)
- `LANGFUSE_*` env var references
- Langfuse batch format construction (trace-create + generation-create events)

**Keep:**

- `isLlmRoute()` — still needed to gate telemetry to LLM routes only
- `ReportOptions` interface — still the internal contract from `index.ts`
- All request/response parsing: `parseRequestBody()`, `parseJsonResponse()`, `parseSSE()`, `parseAnthropicStream()`, `parseOpenAIStream()`, `streamToText()`, `buildModelParams()`
- `MAX_OUTPUT_BYTES` truncation

**Add:**

- `isLlmetryEnabled(env, log)` — checks `LLMETRY_ENABLED === 'true'` and that `LLMETRY_ENDPOINT` + `LLMETRY_AUTH_TOKEN` are set
- `reportGeneration()` rewritten to:
  1. Parse request/response (same as today)
  2. Build an `LlmetryBatch` object with one span
  3. POST to `env.LLMETRY_ENDPOINT` with `Authorization: Bearer ${env.LLMETRY_AUTH_TOKEN}`

**Llmetry span mapping** (AI gateway has no session/agent context — send what's available):

```
resource.serviceName       = "openclaw-ai-gateway"
span.traceId               = crypto.randomUUID()  (no session — each call is its own trace)
span.spanId                = crypto.randomUUID()  (no run ID)
span.name                  = "gen_ai.generate"
span.kind                  = "client"
span.startTimeUnixNano     = startTime → epoch nanoseconds string
span.endTimeUnixNano       = endTime → epoch nanoseconds string
span.status.code           = response.ok ? "OK" : "ERROR"

span.attributes:
  gen_ai.system             = provider ("anthropic" | "openai")
  gen_ai.request.model      = parsed model
  gen_ai.usage.input_tokens = parsed usage
  gen_ai.usage.output_tokens= parsed usage
  gen_ai.request.max_tokens = from request body
  gen_ai.request.temperature= from request body
  openclaw.session.id       = "ai-gateway"  (placeholder — no session context)
  openclaw.run.id           = same as spanId (placeholder)
  openclaw.usage.cache_read_tokens  = from parsed response
  openclaw.usage.cache_write_tokens = from parsed response

span.events:
  - name: "gen_ai.content.prompt",  body: { messages, system? }
  - name: "gen_ai.content.completion", body: output text (truncated to 100KB)
```

### 2. Update `index.ts`

- Change imports: `langfuse` → `llmetry` (function names stay the same: `isLlmetryEnabled`, `isLlmRoute`, `reportGeneration`)
- Rename local variable `langfuseActive` → `llmetryActive`
- No structural changes — the tee-and-report-in-background pattern stays identical

### 3. Update `wrangler.jsonc`

Replace the Langfuse vars section:

```jsonc
// ---- LLM telemetry via llmetry (optional) ----
"LLMETRY_ENABLED": "false",  // Set to "true" to send LLM telemetry to log receiver worker
// LLMETRY_ENDPOINT   — URL of log receiver /llmetry endpoint, set via `wrangler secret put ...`
// LLMETRY_AUTH_TOKEN  — Bearer token for log receiver, set via `wrangler secret put ...`
```

Remove: `LANGFUSE_ENABLED`, `LANGFUSE_BASE_URL`, and comments about `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`.

## Files

| File | Action |
|------|--------|
| `workers/ai-gateway/src/langfuse.ts` | Delete |
| `workers/ai-gateway/src/llmetry.ts` | Create (rewritten from langfuse.ts) |
| `workers/ai-gateway/src/index.ts` | Edit imports + variable names |
| `workers/ai-gateway/wrangler.jsonc` | Replace Langfuse vars with llmetry vars |

## Verification

1. `cd workers/ai-gateway && npx tsc --noEmit` — type-checks cleanly
2. Grep for `langfuse` / `LANGFUSE` in `workers/ai-gateway/` — zero results
3. Review `llmetry.ts` output format against `workers/log-receiver/src/llmetry.ts` types
