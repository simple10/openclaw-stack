# AI Proxy / OpenClaw LLM Routing Overview

How every LLM API call gets from an OpenClaw agent to the upstream provider (Anthropic, OpenAI) via the AI Gateway Worker.

## Architecture Summary

```
OpenClaw Agent (sandbox container)
  │
  │  streamSimple() → HTTP request
  │  Headers: Authorization: Bearer <AI_GATEWAY_AUTH_TOKEN>
  │
  ▼
AI Gateway Worker (Cloudflare Worker)
  │  Routes: /anthropic/v1/messages, /openai/v1/chat/completions
  │  Authenticates via Bearer token
  │  Replaces auth with real provider API key (stored as Worker secrets)
  │  Optionally reports to Langfuse
  │
  ├──► Direct mode: Worker → api.anthropic.com / api.openai.com
  │
  └──► CF AI Gateway mode (if configured):
       Worker → gateway.ai.cloudflare.com → api.anthropic.com / api.openai.com
```

**Key security property:** The VPS never holds real LLM provider API keys. It only has `AI_GATEWAY_AUTH_TOKEN` (a Worker-level auth token). Real keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are encrypted Cloudflare Worker secrets.

---

## The Three Config Layers

Three independent mechanisms ensure all LLM traffic routes through the AI Gateway Worker. Each serves a different consumer.

### Layer 1: `docker-compose.override.yml` — SDK-level env vars

Sets `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` on the gateway container so that any direct SDK usage (tools, skills, or plugins calling the Anthropic/OpenAI SDKs) routes through the Worker:

```yaml
environment:
  - ANTHROPIC_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
  - ANTHROPIC_BASE_URL=${AI_GATEWAY_WORKER_URL}
  - OPENAI_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
  - OPENAI_BASE_URL=${AI_GATEWAY_WORKER_URL}
```

The SDKs append their standard paths (e.g., Anthropic SDK appends `/v1/messages`), which lands on the Worker's `/anthropic/v1/messages` route — **but only if the SDK is configured to use the `/anthropic` prefix.** For direct SDK usage the root URL works because the SDK path construction differs from OpenClaw's internal provider system.

**Limitation:** OpenClaw's built-in Anthropic provider ignores `ANTHROPIC_BASE_URL`. This layer only covers direct SDK calls.

### Layer 2: `deploy/models.json` — OpenClaw provider base URL override

Overrides the base URL for OpenClaw's own model registry. Placed per-agent at `/home/openclaw/.openclaw/agents/<agent>/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "{{AI_GATEWAY_WORKER_URL}}/anthropic"
    },
    "openai": {
      "baseUrl": "{{AI_GATEWAY_WORKER_URL}}/openai/v1"
    }
  }
}
```

**Critical gotcha — override-only format:** This file must contain *only* a `providers` object with `baseUrl`. If a `models` array is included, OpenClaw registers new model entries alongside the built-ins, but the built-ins (with hardcoded `api.anthropic.com` URLs) take precedence — silently breaking proxy routing.

**Per-agent placement:** Must be copied to each agent directory (`main`, `code`, `skills`). The deploy playbook loops over all agents to write and permission the file (`600`, `1000:1000`).

### Layer 3: `build-openclaw.sh` Patch #3 — `docker.ts` env propagation

Upstream bug: `docker.ts` builds the `docker create` args for sandbox containers but never passes `-e` flags from `sandbox.docker.env`. Our build script patches this:

```bash
# Adds: if (params.cfg.env) { for (const [key, value] of Object.entries(params.cfg.env)) { args.push("-e", `${key}=${value}`); } }
sed -i '/^  return args;$/i\  if (params.cfg.env) { ... }' "$DOCKER_FILE"
```

Without this patch, sandbox containers wouldn't inherit env vars like `ANTHROPIC_BASE_URL` set via `openclaw.json`'s `sandbox.docker.env` config, and any SDK calls made inside sandboxes would bypass the proxy.

---

## AI Gateway Worker — Request Flow

Source: `workers/ai-gateway/src/`

### Routing (`routing.ts`)

The Worker matches incoming requests by path prefix:

| Route | Method | Provider | Direct Path | Gateway Path |
|-------|--------|----------|-------------|--------------|
| `/anthropic/v1/messages` | POST | anthropic | `v1/messages` | `anthropic/messages` |
| `/openai/v1/chat/completions` | POST | openai | `v1/chat/completions` | `openai/chat/completions` |
| `/openai/v1/embeddings` | POST | openai | `v1/embeddings` | `openai/embeddings` |
| `/openai/v1/models` | GET | openai | `v1/models` | `openai/models` |

### Request pipeline (`index.ts`)

1. **Health check** — `GET /health` returns `{"status":"ok"}` (no auth)
2. **Auth** — validates `Authorization: Bearer <token>` against `AUTH_TOKEN` secret
3. **Route matching** — `matchProviderRoute()` extracts provider + paths
4. **API key lookup** — `getProviderApiKey()` returns the real provider key from Worker secrets
5. **Proxy** — `proxyAnthropic()` or `proxyOpenAI()` forwards the request upstream
6. **Langfuse** — if enabled, tees the response stream and reports generation metrics in `ctx.waitUntil()`

### Provider proxies

**Anthropic** (`providers/anthropic.ts`):
- Strips: `authorization`, `x-api-key`, `cf-*` headers
- Forwards: all other request headers (including any custom `x-openclaw-*` headers)
- Sets: `x-api-key` (or `Authorization: Bearer` for OAuth tokens) + `anthropic-version`

**OpenAI** (`providers/openai.ts`):
- Copies all request headers
- Replaces `Authorization` header with real OpenAI API key
- Sets any provider-config headers (e.g., `cf-aig-authorization` for gateway mode)

### Langfuse integration (`langfuse.ts`)

When `LANGFUSE_ENABLED=true` and keys are configured:
- Pre-reads the request body before proxying
- Tees the response stream (one copy to client, one for parsing)
- Parses SSE streams (Anthropic and OpenAI formats) to extract output text, usage, and model
- Reports via Langfuse batch ingestion API: creates a trace + generation per LLM call
- Each trace gets a random UUID — **no session context** (this is the observability gap addressed by the header injection plan)

---

## OpenClaw Source Code — LLM Call Chain

The OpenClaw gateway source (`src/agents/`) is on the VPS, not in this repo. This section documents the call chain from research.

### Entry: `pi-embedded-runner/run.ts`

`runEmbeddedPiAgent()` is the top-level entry point for agent LLM sessions. It receives `RunEmbeddedPiAgentParams` which includes:
- `sessionId` — the active session identifier
- `runId` — unique per agent run
- `config` — resolved agent configuration
- `provider` / `modelId` — which LLM to use

### LLM call site: `pi-embedded-runner/run/attempt.ts`

`runEmbeddedAttempt()` sets up the stream function and wrapper chain:

```
Line ~614: agent.streamFn = streamSimple  (or createOllamaStreamFn)
Line ~617: applyExtraParamsToAgent(agent, config, provider, modelId, streamParams)
Line ~620: agent.streamFn = cacheTrace.wrapStreamFn(agent.streamFn)
Line ~622: agent.streamFn = anthropicPayloadLogger.wrapStreamFn(agent.streamFn)
```

The `streamFn` is a composable wrapper chain — each step wraps the previous function, adding behavior (extra params, caching, logging) before delegating to the underlying call.

### Stream function wrappers: `pi-embedded-runner/extra-params.ts`

`applyExtraParamsToAgent()` wraps `streamSimple` to inject provider-specific parameters and headers:

- **`createOpenRouterHeadersWrapper`** — injects `HTTP-Referer` and `X-Title` headers for OpenRouter requests
- **`createOpenAIResponsesStoreWrapper`** — modifies payload content for OpenAI
- Uses pattern: `const underlying = baseStreamFn ?? streamSimple` then returns a new function that calls `underlying(model, context, { ...options, headers: { ...CUSTOM_HEADERS, ...options?.headers } })`

This is the exact pattern for adding session metadata headers (see planned `X-OpenClaw-Session-ID` / `X-OpenClaw-Agent-ID` / `X-OpenClaw-Run-ID` injection).

### Package dependency

LLM calls use `streamSimple` and `SimpleStreamOptions` from `@mariozechner/pi-ai` (pinned at `0.52.12`). This is a private package — the `options.headers` field is confirmed to work for custom HTTP header injection.

---

## Observability Stack

### Current state

| Component | What it captures | Session context? |
|-----------|-----------------|-----------------|
| **AI Gateway Worker + Langfuse** | Every LLM call (model, tokens, latency, I/O) | No — random trace IDs |
| **llm-logger plugin** | Every LLM call (full prompt, response, usage) to `~/.openclaw/logs/llm.log` | Yes — `sessionId`, `runId`, `agentId` |
| **Session transcripts** | Full conversation (tool calls, results, messages) at `~/.openclaw/agents/<id>/sessions/<sid>.jsonl` | Yes |
| **Vector → Log Receiver Worker** | Docker container stdout/stderr (structured JSON) | No |
| **debug-logger hook** | `gateway:startup`, `agent:bootstrap` events to `~/.openclaw/logs/debug.log` | Partial |

### Gap

The Langfuse traces are flat — each LLM call is an isolated trace with no link to the OpenClaw session that produced it. This makes it impossible to group all LLM calls for a conversation or correlate costs to specific agent sessions.

### Planned fix (Approach B — Header Injection)

Inject custom headers at the gateway source level, extract them in the AI Gateway Worker:

1. **Gateway patch** (`build-openclaw.sh` patch #5): Add `createSessionHeadersWrapper()` in `extra-params.ts` that injects `X-OpenClaw-Session-ID`, `X-OpenClaw-Agent-ID`, `X-OpenClaw-Run-ID` on every LLM request
2. **Worker update**: `index.ts` extracts these headers from the incoming request; `langfuse.ts` uses `X-OpenClaw-Session-ID` as the Langfuse `sessionId` for trace grouping
3. **Header passthrough**: Already works — Anthropic proxy forwards all headers except `authorization`, `x-api-key`, and `cf-*`

See `plans/_brainstorming/ai-proxy-llmetry-session-patch.md` for the full implementation plan.

---

## File Reference

| File | Location | Purpose |
|------|----------|---------|
| `deploy/models.json` | Local repo → per-agent on VPS | Provider base URL overrides |
| `deploy/docker-compose.override.yml` | Local repo → VPS | SDK env var injection |
| `deploy/build-openclaw.sh` | Local repo → VPS | Source patches including docker.ts env fix |
| `workers/ai-gateway/src/index.ts` | Local repo | Worker entry point and request pipeline |
| `workers/ai-gateway/src/routing.ts` | Local repo | URL → provider route matching |
| `workers/ai-gateway/src/providers/anthropic.ts` | Local repo | Anthropic proxy (header filtering + forwarding) |
| `workers/ai-gateway/src/providers/openai.ts` | Local repo | OpenAI proxy |
| `workers/ai-gateway/src/langfuse.ts` | Local repo | Langfuse trace/generation reporting |
| `workers/ai-gateway/src/config.ts` | Local repo | Provider config (direct vs CF AI Gateway mode) |
| `deploy/plugins/llm-logger/index.js` | Local repo → VPS | LLM call logging plugin (has session context) |
| `docs/AI-GATEWAY-CONFIG.md` | Local repo | User-facing config guide for the AI Gateway |
| `src/agents/pi-embedded-runner/extra-params.ts` | VPS only | Stream function wrapper chain (header injection point) |
| `src/agents/pi-embedded-runner/run/attempt.ts` | VPS only | LLM call setup and wrapper composition |
| `src/agents/pi-embedded-runner/run.ts` | VPS only | Agent session entry point |
