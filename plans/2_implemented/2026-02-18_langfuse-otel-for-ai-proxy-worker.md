# Plan: Add LangFuse Observability to AI Gateway Worker

## Context

The AI Gateway Cloudflare Worker (`workers/ai-gateway/`) proxies LLM calls to Anthropic/OpenAI. Currently it has basic `console.log` observability via Cloudflare Workers Logs but no structured LLM tracing. Adding LangFuse gives us trace-level visibility into every LLM call: model, prompt, response, token usage, cache tokens, latency, and cost — all searchable in the LangFuse dashboard.

**Why direct REST API instead of the LangFuse SDK?** The LangFuse v4 JS SDK is OpenTelemetry-based and its span processor (`@langfuse/otel`) requires Node.js >= 20, which is incompatible with the Cloudflare Workers runtime. Instead, we call LangFuse's `/api/public/ingestion` endpoint directly via `fetch()` — zero dependencies, guaranteed edge compatibility.

## Approach

1. **Non-blocking**: All LangFuse work happens in `ctx.waitUntil()` after the response is returned to the client
2. **Stream-safe**: Use `response.body.tee()` to split the response — one branch streams to the client, the other is read in the background for LangFuse
3. **Opt-in**: Only active when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` secrets are set. When unset, the worker behaves exactly as it does today — no code paths touched, no stream splitting, no extra memory. The feature gate check happens before any LangFuse-related work.
4. **Zero dependencies**: Direct `fetch()` to LangFuse REST API with Basic Auth

## Files to Change

### 1. `workers/ai-gateway/src/types.ts` — Add LangFuse env vars

Add to `Env` interface:

```typescript
LANGFUSE_PUBLIC_KEY?: string
LANGFUSE_SECRET_KEY?: string
LANGFUSE_BASE_URL?: string  // default: https://cloud.langfuse.com
```

### 2. `workers/ai-gateway/src/providers/anthropic.ts` — Accept pre-read body

Add optional `body?: string` parameter. Use it instead of calling `request.text()` when provided. This lets `index.ts` read the body once and share it with both the proxy and LangFuse.

### 3. `workers/ai-gateway/src/providers/openai.ts` — Same refactor

Same `body?: string` parameter as Anthropic.

### 4. `workers/ai-gateway/src/langfuse.ts` — NEW: All LangFuse logic

Self-contained module with:

- `isLangfuseEnabled(env)` — feature gate
- `reportGeneration(env, log, opts)` — orchestrator called from `ctx.waitUntil()`
- Request body parser — extracts model, messages, parameters from JSON
- Response body parser — extracts usage AND output from both non-streaming JSON and streaming SSE:
  - **Non-streaming**: Parse JSON response body for usage and output
  - **Anthropic SSE**: `message_start` (input_tokens, cache tokens) + `content_block_delta` (text deltas → reassemble output) + `message_delta` (output_tokens, stop_reason)
  - **OpenAI SSE**: `chat.completion.chunk` events (`delta.content` → reassemble output) + final chunk `usage` field
- Output capture safety:
  - Concatenate text deltas into full output string, capped at **100KB** to bound memory
  - If truncated, set `metadata.output_truncated: true` on the generation
  - If SSE parsing fails mid-stream, send generation with whatever was captured + `metadata.output_partial: true`
- REST client — `POST /api/public/ingestion` with Basic Auth, sends `trace-create` + `generation-create` in one batch

**What's captured per LLM call:**

| Field | Non-streaming | Streaming |
|-------|--------------|-----------|
| Model | Yes | Yes |
| Input (messages) | Yes | Yes |
| Output (response) | Yes | Yes (reassembled from SSE text deltas, capped at 100KB) |
| Token usage | Yes | Yes (parsed from SSE events) |
| Cache tokens (Anthropic) | Yes | Yes |
| Latency | Yes | Yes |
| Status code | Yes | Yes |

### 5. `workers/ai-gateway/src/index.ts` — Wire it all together

Key changes:

- Add `ctx: ExecutionContext` to the fetch handler signature
- Read request body before calling proxy functions (pass body string to proxy)
- After proxy returns, if LangFuse is enabled:
  - `response.body.tee()` to split the stream
  - Return first branch to client (preserves streaming)
  - `ctx.waitUntil()` reads second branch, parses usage, sends to LangFuse
- Only trace LLM routes (`/messages`, `/chat/completions`), skip embeddings/models
- Only trace successful responses (2xx)

### 6. `workers/ai-gateway/wrangler.jsonc` — Add LANGFUSE_BASE_URL var

### 7. `workers/ai-gateway/.dev.vars.example` — Add LangFuse dev vars

## Error Handling

All LangFuse failures are isolated — they never affect the proxy response:

- LangFuse secrets not set → feature silently disabled, zero overhead (no stream tee, no body parsing)
- Request/response parse failures → generation sent without usage/output data
- SSE parse failure mid-stream → generation sent with partial output + `output_partial` metadata flag
- Output exceeds 100KB cap → truncated, `output_truncated` metadata flag set
- Client disconnect during streaming → partial data captured (best-effort)
- LangFuse API errors → logged, not retried
- Batch > 3.5 MB → skipped with warning
- Any exception in background task → caught and logged

## Verification

1. Deploy without LangFuse secrets → verify existing behavior unchanged
2. Set secrets → send non-streaming Anthropic request → verify trace + generation in LangFuse dashboard
3. Send streaming Anthropic request → verify SSE stream reaches client intact AND LangFuse shows token counts AND full output text
4. Send streaming OpenAI request → same verification as #3
5. Send large streaming response (>100KB output) → verify truncation flag in LangFuse metadata
6. Set `LANGFUSE_BASE_URL` to invalid host → verify proxy still works, errors logged

## Deferred Enhancements

- `completionStartTime` via TransformStream (time-to-first-byte for streaming)
- Error response tracing (4xx/5xx from providers)
- Embeddings tracing
- Session/user ID propagation from client headers
- Input truncation for very large prompts (instead of skipping the whole batch)
- Tool use content block capture (currently only text deltas are reassembled)
