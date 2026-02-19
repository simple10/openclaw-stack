# Plan: Observability — Linking LLM API Calls to Sessions

## Context

We want to build full observability for OpenClaw: trace user messages through agents, sub-agents, tool calls, and LLM API calls. The minimum viable step is **linking LLM API calls back to specific sessions**.

Currently, the AI Gateway Worker sends LLM call data to Langfuse with random UUIDs — no session, agent, or user context. Meanwhile, the `llm-logger` plugin (running in the gateway) has full context but only writes to a local log file.

## Current State — Corrected Understanding

### Hypothesis corrections

| # | Hypothesis | Actual |
|---|-----------|--------|
| 1 | llm-logger only fires at task start/end | **Wrong** — fires on EVERY LLM API call (`llm_input` before, `llm_output` after) |
| 2 | llm-logger has session info | **Correct** — has `sessionId`, `agentId`, `sessionKey`, `runId` |
| 3 | AI proxy has no session info | **Correct** — only sees raw HTTP request with auth token |
| 4 | debug logs can link sessions to LLM calls | **Partially** — debug-logger only captures lifecycle events, but llm-logger captures per-call data with session context |

### Data flow today

```
User message → OpenClaw Gateway → AI Gateway Worker → LLM Provider
                    │                    │
                    │                    └─→ Langfuse (random trace IDs, no session context)
                    │
                    ├─→ llm-logger plugin (has session context, writes to llm.log file)
                    ├─→ session JSONL files (full conversation + tool calls)
                    └─→ debug-logger hook (lifecycle events only)
```

### Key insight: llm-logger is the bridge

The llm-logger plugin already has everything we need per LLM call:

- `sessionId`, `agentId`, `sessionKey`, `runId` (context)
- `provider`, `model` (routing)
- `systemPrompt`, `prompt`, `historyMessages` (input)
- `assistantTexts`, `lastAssistant` (output)
- `usage.{input, output, cacheRead, cacheWrite, total}` (tokens)
- `toolCalls` (tool invocations)
- `stopReason`, `durationMs` (completion info)

## Approaches Evaluated

### Approach A: Move Langfuse reporting to llm-logger plugin (Recommended)

Enhance the llm-logger plugin to send data to Langfuse directly, instead of (or in addition to) the AI Gateway Worker.

**How it works:**

- llm-logger creates a Langfuse trace per session (keyed by `sessionId`)
- Each `llm_input`/`llm_output` pair becomes a Langfuse generation under that trace
- Session, agent, and run metadata are included as Langfuse tags/metadata
- Disable Langfuse in the AI Gateway Worker (or keep as fallback)

**Langfuse trace hierarchy:**

```
Trace (sessionId: "abc-123", agentId: "code", userId: "joe")
  ├── Generation 1 (runId: "run-1", model: "claude-sonnet-4-5-20250929")
  │   ├── Input: system prompt + messages
  │   ├── Output: response text
  │   ├── Usage: 1200 in / 450 out
  │   └── Metadata: { toolCalls: ["read", "grep"], stopReason: "tool_use" }
  │
  ├── Generation 2 (runId: "run-2", model: "claude-sonnet-4-5-20250929")
  │   └── ...
  └── ...
```

**Pros:**

- Has ALL context natively — no hacks needed
- Creates proper session-level trace hierarchy in Langfuse
- No OpenClaw source patching required
- Plugin code is fully under our control (`deploy/plugins/llm-logger/`)
- Can batch generations under session traces for clear grouping
- Gateway container already has outbound HTTPS access

**Cons:**

- Adds HTTP calls from gateway process (mitigated: fire-and-forget, non-blocking)
- Gateway container needs Langfuse credentials (env vars in docker-compose)
- Some Langfuse logic duplicated from worker (or extracted into shared module)

**Changes needed:**

1. `deploy/plugins/llm-logger/index.js` — Add Langfuse reporting alongside file logging
2. `deploy/docker-compose.override.yml` — Add `LANGFUSE_*` env vars to gateway container
3. `openclaw-config.env` — Add Langfuse credential fields
4. `deploy/openclaw.json` — Enable llm-logger plugin by default (or keep opt-in)
5. Worker `wrangler.jsonc` — Set `LANGFUSE_ENABLED=false` (or leave as backup)

### Approach B: Inject custom headers via source patch (~35 lines total)

Patch OpenClaw to inject `X-OpenClaw-Session-ID`, `X-OpenClaw-Agent-ID`, `X-OpenClaw-Run-ID` headers into every LLM API request. The AI Gateway Worker extracts these for Langfuse traces.

**Key finding: OpenClaw already has the exact pattern we need.** The codebase uses a composable `streamFn` wrapper chain in `src/agents/pi-embedded-runner/extra-params.ts`. The existing `createOpenRouterHeadersWrapper()` function (lines 163-171) does exactly what we'd do — it wraps the stream function to inject custom headers:

```typescript
// Already exists — our model:
function createOpenRouterHeadersWrapper(baseStreamFn): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: { ...OPENROUTER_APP_HEADERS, ...options?.headers },
    });
}
```

**Patch breakdown (~25 lines gateway + ~10 lines worker):**

| Part | Lines | File |
|------|-------|------|
| New `createSessionHeadersWrapper()` | ~10 | `extra-params.ts` |
| Add optional `sessionContext` param to `applyExtraParamsToAgent()` | ~3 | `extra-params.ts` |
| Call the wrapper inside `applyExtraParamsToAgent()` | ~5 | `extra-params.ts` |
| Pass `{ sessionId, runId, agentId }` at call site | ~5 | `attempt.ts` |
| Extract headers in worker, add to Langfuse metadata | ~10 | `workers/ai-gateway/src/langfuse.ts` |

All context (`sessionId`, `runId`, `agentId`) is already in scope at the call site in `attempt.ts`. The patch just threads it through one function signature.

**Pros:**

- Keeps Langfuse in the worker (single Langfuse integration point)
- Extremely small patch surface (2 OpenClaw files, follows existing pattern)
- Worker gets session context in every request, enriches Langfuse traces
- No new credentials or env vars needed on gateway
- Can use `sessionId` as Langfuse `traceId` for proper session grouping

**Cons:**

- Source patch (#5 in build-openclaw.sh) — needs maintenance on OpenClaw updates
- Patch is against `src/` (TypeScript) so requires rebuild (`pnpm build`)
- Headers go to ALL providers (Anthropic, OpenAI, etc.) — harmless but unnecessary
- Worker-side Langfuse still creates flat per-request traces (no session hierarchy without additional changes)

### Approach C: Timestamp-based correlation

Match llm-logger entries with Langfuse traces by timestamp + model + token count.

**Pros:** Zero code changes
**Cons:** Unreliable, complex join logic, no native linking in Langfuse UI

## Implementation: Approach B — Header Injection

### Overview

Two-part change:

1. **Gateway patch** (~25 lines): Inject `X-OpenClaw-Session-ID`, `X-OpenClaw-Agent-ID`, `X-OpenClaw-Run-ID` headers into every LLM API request
2. **Worker update** (~15 lines): Extract these headers, use `sessionId` as Langfuse trace ID, include agent/run in metadata

### Part 1: Gateway patch (build-openclaw.sh patch #5)

**Target files on VPS:**

- `src/agents/pi-embedded-runner/extra-params.ts` — add wrapper + wire it in
- `src/agents/pi-embedded-runner/run/attempt.ts` — pass session context at call site

**What the patch does:**

1. **Add `createSessionHeadersWrapper()` in `extra-params.ts`** — follows the existing `createOpenRouterHeadersWrapper()` pattern exactly:

```typescript
function createSessionHeadersWrapper(baseStreamFn, sessionId, agentId, runId) {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: {
        'X-OpenClaw-Session-ID': sessionId,
        ...(agentId && { 'X-OpenClaw-Agent-ID': agentId }),
        ...(runId && { 'X-OpenClaw-Run-ID': runId }),
        ...options?.headers,
      },
    });
}
```

1. **Add optional `sessionContext` param to `applyExtraParamsToAgent()`** and call the wrapper:

```typescript
// At end of function body, before closing brace:
if (sessionContext?.sessionId) {
  agent.streamFn = createSessionHeadersWrapper(
    agent.streamFn, sessionContext.sessionId, sessionContext.agentId, sessionContext.runId
  );
}
```

1. **Update call site in `attempt.ts`** to pass session context:

```typescript
applyExtraParamsToAgent(
  activeSession.agent, params.config, params.provider, params.modelId, params.streamParams,
  { sessionId: params.sessionId, agentId: params.agentId, runId: params.runId }
);
```

**Patch implementation in `build-openclaw.sh`:**

- Add as patch #5, same pattern as existing patches (sed-based, auto-skip if already patched)
- Guard: `grep -q 'X-OpenClaw-Session-ID' extra-params.ts`
- Since this is a multi-line patch across 2 files, may use a heredoc-based approach instead of inline sed
- `git checkout` restores both files after build (existing pattern at line 73)

### Part 2: Worker update

**Target files:**

- `workers/ai-gateway/src/index.ts` — extract headers from request, pass to `reportGeneration`
- `workers/ai-gateway/src/langfuse.ts` — use sessionId as trace ID, add metadata

**Changes to `index.ts`** (~5 lines):

```typescript
// Before reportGeneration call, extract OpenClaw headers:
const openclawSessionId = request.headers.get('x-openclaw-session-id')
const openclawAgentId = request.headers.get('x-openclaw-agent-id')
const openclawRunId = request.headers.get('x-openclaw-run-id')

// Pass to reportGeneration:
ctx.waitUntil(reportGeneration(env, log, {
  ...existingOpts,
  openclawSessionId, openclawAgentId, openclawRunId,  // NEW
}))
```

**Changes to `langfuse.ts`** (~10 lines):

1. Add fields to `ReportOptions` interface:

```typescript
openclawSessionId?: string | null
openclawAgentId?: string | null
openclawRunId?: string | null
```

1. In `reportGeneration()`, use sessionId as trace ID for grouping:

```typescript
const traceId = opts.openclawSessionId || crypto.randomUUID()
// ...
body: {
  id: traceId,
  name: opts.openclawAgentId ? `${opts.provider}-${opts.openclawAgentId}` : `${opts.provider}-generation`,
  sessionId: opts.openclawSessionId || undefined,  // Langfuse session grouping
  metadata: {
    provider: opts.provider,
    ...(opts.openclawAgentId && { agentId: opts.openclawAgentId }),
    ...(opts.openclawRunId && { runId: opts.openclawRunId }),
  },
}
```

### Part 3: Ensure headers pass through proxies

**Already verified:** The Anthropic proxy (`providers/anthropic.ts` line 27-31) forwards all request headers except `authorization`, `x-api-key`, and `cf-*`. Our `x-openclaw-*` headers will be forwarded to Anthropic's API but harmlessly ignored. Same for OpenAI proxy (uses `new Headers(request.headers)`).

### Files to modify

| File | Change | Lines |
|------|--------|-------|
| `deploy/build-openclaw.sh` | Add patch #5 for session headers | ~20 |
| `workers/ai-gateway/src/index.ts` | Extract `x-openclaw-*` headers, pass to reportGeneration | ~5 |
| `workers/ai-gateway/src/langfuse.ts` | Use sessionId as traceId, add agent/run to metadata | ~10 |

### Result in Langfuse

After this change, Langfuse traces will show:

- **Session grouping**: All LLM calls from the same session share a `sessionId`, visible in Langfuse's session view
- **Agent tagging**: Each trace tagged with `agentId` (e.g., "code", "skills", "main")
- **Run correlation**: Each generation tagged with `runId` for pairing with llm-logger entries
- **Trace naming**: `anthropic-code` instead of generic `anthropic-generation`

### Future extensions (not in this plan)

- **Approach A overlay**: Add Langfuse reporting to llm-logger plugin for richer session-level trace hierarchy (spans for tool calls, sub-agent routing)
- **Custom observability dashboard**: Read session JSONL + Langfuse data for unified view
- **Cost tracking**: Langfuse has built-in cost calculation for Claude/GPT models

## Verification

1. **Build**: Run `build-openclaw.sh` on VPS — verify patch #5 applies cleanly and build succeeds
2. **Deploy worker**: `cd workers/ai-gateway && wrangler deploy` — deploys header extraction + Langfuse changes
3. **Restart gateway**: `docker compose up -d openclaw-gateway` — picks up new image with session headers
4. **Test**: Send a message to any agent
5. **Check worker logs**: `wrangler tail` — verify `x-openclaw-session-id` header appears in debug logs
6. **Check Langfuse**: Verify traces now show `sessionId`, `agentId`, `runId` in metadata
7. **Session grouping**: Send multiple messages in same session — verify they share a `sessionId` in Langfuse
8. **No regression**: Verify LLM responses still stream correctly, no latency impact
