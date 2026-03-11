# Plan: LLM Telemetry via Log Worker (llmetry)

## Context

LLM API calls from OpenClaw have no session/agent context in Langfuse. The `llm-logger` plugin has full context (sessionId, agentId, runId, model, tokens, prompts, responses) but only writes to a local file. We want to route this data through the Log Worker — our central observability hub — which converts it to Langfuse format (and in the future, other backends like Traceloop, PostHog, etc.).

### Architecture

```
llm-logger plugin ──POST /llmetry──→ Log Worker ──→ Langfuse API
  (gateway)            (OTEL-style)    (CF Worker)     (or future backends)
                                          │
                                          └──→ console.log (CF Workers Logs, same as /logs)
```

### Key findings from exploration

- **llm-logger fires on EVERY LLM call** (not just task boundaries) — has `sessionId`, `agentId`, `runId`, model, tokens, prompts, responses, tool calls
- **Log Worker** (`workers/log-receiver/`) is a simple CF Worker with `POST /logs` endpoint, Bearer auth, structured console output to CF Workers Logs
- **Log Worker has no persistence** — it forwards to CF Workers Logs (and optionally Logpush). Adding Langfuse forwarding fits the same pattern.
- **llm-logger runs in gateway process** — has `process.env` access and outbound HTTPS

## Implementation

### Part 1: Log Worker — new `/llmetry` endpoint

**Files to modify/create:**

| File | Action |
|------|--------|
| `workers/log-receiver/src/index.ts` | Add `/llmetry` route |
| `workers/log-receiver/src/llmetry.ts` | NEW — handle llmetry batches, dispatch to backends |
| `workers/log-receiver/src/backends/langfuse.ts` | NEW — convert llmetry spans to Langfuse ingestion format |
| `workers/log-receiver/src/env.d.ts` | Add Langfuse secret declarations |
| `workers/log-receiver/wrangler.jsonc` | Add `LANGFUSE_BASE_URL` var |

#### 1a. Request format (OTEL-inspired, OpenClaw-specific)

```typescript
// POST /llmetry — accepts a batch of LLM generation spans
interface LlmetryBatch {
  resource: {
    serviceName: string              // "openclaw-gateway"
    instanceId?: string              // OPENCLAW_INSTANCE_ID — unique per deployment
    hostname?: string                // VPS_HOSTNAME — friendly name (e.g., "openclaw-dev")
    attributes?: Record<string, string | number | boolean>
  }
  spans: LlmetrySpan[]
}

interface LlmetrySpan {
  traceId: string                    // sessionId — groups all LLM calls in a session
  spanId: string                     // runId — unique per LLM round-trip
  parentSpanId?: string              // future: sub-agent tracking
  name: string                       // "gen_ai.generate"
  kind: "client"
  startTimeUnixNano: string          // epoch nanoseconds (OTEL convention)
  endTimeUnixNano: string
  status: { code: "OK" | "ERROR", message?: string }
  attributes: {
    // OTEL GenAI semantic conventions
    "gen_ai.system": string          // "anthropic" | "openai"
    "gen_ai.request.model": string   // "claude-sonnet-4-5-20250929"
    "gen_ai.usage.input_tokens"?: number
    "gen_ai.usage.output_tokens"?: number
    "gen_ai.request.max_tokens"?: number
    "gen_ai.request.temperature"?: number
    "gen_ai.response.stop_reason"?: string
    // OpenClaw-specific — session context (instance id/hostname are on resource level)
    "openclaw.agent.id"?: string
    "openclaw.session.id": string
    "openclaw.session.key"?: string
    "openclaw.run.id": string
    "openclaw.usage.cache_read_tokens"?: number
    "openclaw.usage.cache_write_tokens"?: number
    "openclaw.tool_calls"?: string   // JSON array of {name, id}
    "openclaw.images_count"?: number
    [key: string]: string | number | boolean | undefined
  }
  events?: Array<{
    name: string                     // "gen_ai.content.prompt" | "gen_ai.content.completion"
    timeUnixNano: string
    body: unknown                    // prompt messages/system or response content
  }>
}
```

Response: `{"status":"ok","count":<spans_processed>}` (same pattern as `/logs`)

#### 1b. `llmetry.ts` — handler

```typescript
export async function handleLlmetry(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response>
```

- Parse and validate the `LlmetryBatch`
- Log a summary to console (same pattern as `/logs` — counts visible in CF dashboard)
- If Langfuse is configured, dispatch to backend via `ctx.waitUntil()` (non-blocking)
- Return immediately with count

#### 1c. `backends/langfuse.ts` — Langfuse adapter

```typescript
export async function sendToLangfuse(
  spans: LlmetrySpan[],
  resource: LlmetryBatch["resource"],
  env: Env,
  log: (...args: unknown[]) => void
): Promise<void>
```

Converts llmetry spans to Langfuse batch ingestion format:

| Llmetry field | Langfuse field |
|--------------|----------------|
| `traceId` (sessionId) | `trace.sessionId` |
| `spanId` (runId) | `generation.id` |
| `resource.instanceId` | `trace.metadata.instanceId`, `generation.metadata.instanceId` |
| `resource.hostname` | `trace.metadata.hostname`, `generation.metadata.hostname` |
| `attributes["openclaw.agent.id"]` | `trace.name` = `"agent-{agentId}"`, `trace.metadata.agentId` |
| `attributes["gen_ai.request.model"]` | `generation.model` |
| `attributes["gen_ai.usage.*"]` | `generation.usage` |
| `events[name="gen_ai.content.prompt"]` | `generation.input` |
| `events[name="gen_ai.content.completion"]` | `generation.output` |
| `startTimeUnixNano` / `endTimeUnixNano` | `generation.startTime` / `endTime` |
| All `openclaw.*` attributes | `generation.metadata` |

**Langfuse trace grouping**: Uses `sessionId` as Langfuse `sessionId` field. All generations from the same OpenClaw session appear under one Langfuse session. Each generation gets a unique trace (keyed by `runId`).

**Secrets needed** (set via `wrangler secret put`):

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`

**Env var** (in wrangler.jsonc vars):

- `LANGFUSE_BASE_URL` (default: `https://cloud.langfuse.com`)

#### 1d. Backend adapter pattern

The handler checks which backends are configured and dispatches to each:

```typescript
// In llmetry.ts — easy to extend
const backends: Promise<void>[] = []

if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
  backends.push(sendToLangfuse(batch.spans, batch.resource, env, console.error))
}
// Future:
// if (env.POSTHOG_API_KEY) backends.push(sendToPostHog(...))
// if (env.TRACELOOP_API_KEY) backends.push(sendToTraceloop(...))

if (backends.length > 0) {
  ctx.waitUntil(Promise.allSettled(backends))
}
```

### Part 2: llm-logger plugin — add Log Worker output

**File to modify:** `deploy/plugins/llm-logger/index.js`

#### 2a. Two independent output modes

```javascript
// Configuration from environment variables
const FILE_LOGGING = true  // always enabled (existing behavior)
const LLMETRY_LOGGING = process.env.ENABLE_LLMETRY_LOGGING === 'true'
const LLMETRY_URL = process.env.LOG_WORKER_URL?.replace(/\/logs$/, '/llmetry')
const LLMETRY_TOKEN = process.env.LOG_WORKER_TOKEN
const INSTANCE_ID = process.env.OPENCLAW_INSTANCE_ID || undefined
const HOSTNAME = process.env.VPS_HOSTNAME || undefined
```

- **File logging**: Always on. Existing `writeLine()` to `~/.openclaw/logs/llm.log`. No changes.
- **Llmetry logging**: Only when `ENABLE_LLMETRY_LOGGING=true`. Sends to Log Worker `/llmetry` endpoint. Derives URL from existing `LOG_WORKER_URL` (replaces `/logs` suffix with `/llmetry`). Uses existing `LOG_WORKER_TOKEN` for auth.

#### 2b. Span assembly (pair llm_input + llm_output by runId)

The plugin receives two events per LLM call. It needs to combine them into one span:

```javascript
// In-memory buffer: runId → pending input event
const pendingInputs = new Map()

api.on('llm_input', async (event, ctx) => {
  // ... existing file logging ...

  if (LLMETRY_LOGGING) {
    pendingInputs.set(event.runId, {
      timestamp: Date.now(),
      event, ctx,
    })
  }
})

api.on('llm_output', async (event, ctx) => {
  // ... existing file logging ...

  if (LLMETRY_LOGGING) {
    const input = pendingInputs.get(event.runId)
    pendingInputs.delete(event.runId)

    const span = buildLlmetrySpan(input, event, ctx)
    sendSpan(span).catch(err =>
      console.error(`[llm-logger] llmetry send failed: ${err.message}`)
    )
  }
})
```

Stale pending inputs are cleaned up periodically (e.g., discard entries older than 5 minutes) to prevent memory leaks if an `llm_output` is never received.

#### 2c. Span construction

```javascript
function buildLlmetrySpan(input, outputEvent, ctx) {
  const startNano = input ? String(input.timestamp * 1_000_000) : String(Date.now() * 1_000_000)
  const endNano = String(Date.now() * 1_000_000)

  return {
    traceId: outputEvent.sessionId ?? ctx.sessionId,
    spanId: outputEvent.runId ?? ctx.runId,
    name: "gen_ai.generate",
    kind: "client",
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    status: { code: "OK" },
    attributes: {
      "gen_ai.system": outputEvent.provider,
      "gen_ai.request.model": outputEvent.model,
      "gen_ai.usage.input_tokens": outputEvent.usage?.input,
      "gen_ai.usage.output_tokens": outputEvent.usage?.output,
      "gen_ai.request.max_tokens": input?.event?.maxTokens,
      "gen_ai.request.temperature": input?.event?.temperature,
      "gen_ai.response.stop_reason": outputEvent.stopReason,
      "openclaw.agent.id": ctx.agentId,
      "openclaw.session.id": outputEvent.sessionId ?? ctx.sessionId,
      "openclaw.session.key": ctx.sessionKey,
      "openclaw.run.id": outputEvent.runId ?? ctx.runId,
      "openclaw.usage.cache_read_tokens": outputEvent.usage?.cacheRead,
      "openclaw.usage.cache_write_tokens": outputEvent.usage?.cacheWrite,
      "openclaw.images_count": input?.event?.imagesCount,
    },
    events: [
      input && {
        name: "gen_ai.content.prompt",
        timeUnixNano: startNano,
        body: {
          system: input.event.systemPrompt,
          messages: input.event.historyMessages,
          prompt: input.event.prompt,
        }
      },
      {
        name: "gen_ai.content.completion",
        timeUnixNano: endNano,
        body: outputEvent.lastAssistant ?? outputEvent.assistantTexts,
      }
    ].filter(Boolean),
  }
}
```

#### 2d. HTTP send (fire-and-forget)

```javascript
async function sendSpan(span) {
  const batch = {
    resource: {
      serviceName: "openclaw-gateway",
      instanceId: INSTANCE_ID,
      hostname: HOSTNAME,
    },
    spans: [span],
  }
  const res = await fetch(LLMETRY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLMETRY_TOKEN}`,
    },
    body: JSON.stringify(batch),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }
}
```

### Part 3: Configuration

**`deploy/docker-compose.override.yml`** — add env vars to gateway service:

```yaml
- ENABLE_LLMETRY_LOGGING=${ENABLE_LLMETRY_LOGGING:-false}
- OPENCLAW_INSTANCE_ID=${OPENCLAW_INSTANCE_ID:-}
- VPS_HOSTNAME=${VPS_HOSTNAME:-}
```

Note: `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` are already available if Vector log shipping is enabled. The plugin derives the llmetry URL from these. No new URL/token config needed.

**`openclaw-config.env.example`** — add:

```bash
OPENCLAW_INSTANCE_ID=             # Unique deployment ID (auto-generated UUID on first deploy if empty)
ENABLE_LLMETRY_LOGGING=false      # Set to true to send LLM telemetry to Log Worker → Langfuse
```

**Auto-generation**: During deploy (playbook 04 or 00), if `OPENCLAW_INSTANCE_ID` is empty, generate a UUID and write it back to `openclaw-config.env`:

```bash
if [ -z "${OPENCLAW_INSTANCE_ID}" ]; then
  OPENCLAW_INSTANCE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  # Write back to config
fi
```

**Log Worker secrets** (set via `wrangler secret put` during deployment):

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`

**Log Worker vars** (in `wrangler.jsonc`):

- `LANGFUSE_BASE_URL` (default: `https://cloud.langfuse.com`)

### Part 4: Verification playbook update

Add to `playbooks/07-verification.md`:

```markdown
## 7.x LLM Telemetry (llmetry)

If `ENABLE_LLMETRY_LOGGING=true` in `openclaw-config.env`:

1. **Log Worker reachable**: `curl -s https://<LOG_WORKER_URL>/health` returns `{"status":"ok"}`
2. **Llmetry endpoint exists**: `curl -s -X POST https://<LOG_WORKER_URL_BASE>/llmetry -H "Authorization: Bearer <LOG_WORKER_TOKEN>" -H "Content-Type: application/json" -d '{"resource":{"serviceName":"test"},"spans":[]}' ` returns `{"status":"ok","count":0}`
3. **Langfuse configured** (if using Langfuse backend): Check `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set as Log Worker secrets
4. **End-to-end**: Send a message to an agent, check Langfuse dashboard for traces with `sessionId` and `agentId` metadata
```

**Critical validation in llm-logger startup**: When `ENABLE_LLMETRY_LOGGING=true`, the plugin should validate on registration that:

- `LOG_WORKER_URL` is set and non-empty
- `LOG_WORKER_TOKEN` is set and non-empty
- Log a clear warning (not silent failure) if either is missing, and disable llmetry output

```javascript
// In register():
if (LLMETRY_LOGGING) {
  if (!LLMETRY_URL || !LLMETRY_TOKEN) {
    api.logger.error(
      '[llm-logger] ENABLE_LLMETRY_LOGGING is true but LOG_WORKER_URL or LOG_WORKER_TOKEN is missing. ' +
      'LLM telemetry will NOT be sent. Set these env vars or disable ENABLE_LLMETRY_LOGGING.'
    )
    llmetryEnabled = false
  } else {
    api.logger.info(`[llm-logger] LLM telemetry enabled → ${LLMETRY_URL}`)
  }
}
```

## Files summary

| File | Action | Lines |
|------|--------|-------|
| `workers/log-receiver/src/index.ts` | Add `/llmetry` route (4 lines) | ~4 |
| `workers/log-receiver/src/llmetry.ts` | NEW — parse batch, log summary, dispatch to backends | ~60 |
| `workers/log-receiver/src/backends/langfuse.ts` | NEW — convert spans to Langfuse batch format, POST to API | ~80 |
| `workers/log-receiver/src/env.d.ts` | Add Langfuse secret types | ~4 |
| `workers/log-receiver/wrangler.jsonc` | Add `LANGFUSE_BASE_URL` var | ~2 |
| `deploy/plugins/llm-logger/index.js` | Add llmetry output mode (span assembly, HTTP send, validation) | ~80 |
| `deploy/docker-compose.override.yml` | Add `ENABLE_LLMETRY_LOGGING`, `OPENCLAW_INSTANCE_ID`, `VPS_HOSTNAME` env vars | ~3 |
| `openclaw-config.env.example` | Document `OPENCLAW_INSTANCE_ID`, `ENABLE_LLMETRY_LOGGING` | ~2 |
| `playbooks/07-verification.md` | Add llmetry verification section | ~15 |

## Verification (end-to-end)

1. **Deploy Log Worker**: `cd workers/log-receiver && wrangler deploy` + set Langfuse secrets
2. **Test endpoint**: `curl -X POST .../llmetry` with empty batch → `{"status":"ok","count":0}`
3. **Enable on gateway**: Set `ENABLE_LLMETRY_LOGGING=true` in docker-compose env, enable llm-logger plugin, restart gateway
4. **Check plugin startup**: Gateway logs should show `[llm-logger] LLM telemetry enabled → https://...`
5. **Send agent message**: Any message triggers LLM calls
6. **Check Log Worker**: `wrangler tail` or CF dashboard — should see llmetry summary entries
7. **Check Langfuse**: Traces appear with `sessionId`, `agentId`, model, token usage
8. **Validation test**: Set `ENABLE_LLMETRY_LOGGING=true` without `LOG_WORKER_URL` → should see error log, no crashes
