# Plan: Cloudflare Worker — AI Gateway Proxy

## Context

OpenClaw gateway currently calls Anthropic/OpenAI APIs directly. This worker sits in between, routing all LLM traffic through Cloudflare AI Gateway for observability, caching, and rate limiting — without changing request/response formats.

The `workers/ai-gateway/` directory is empty. This is a greenfield implementation.

## Architecture

```
OpenClaw Gateway
  → Worker (auth check, URL rewrite, header swap)
    → Cloudflare AI Gateway
      → Anthropic / OpenAI
```

The worker is a transparent proxy. It does **not** parse or modify request/response bodies. Streaming works by passing `ReadableStream` through unchanged.

## File Structure

```
workers/ai-gateway/
├── package.json              # Zero runtime deps — only wrangler + TS types
├── tsconfig.json
├── wrangler.toml             # ACCOUNT_ID, GATEWAY_ID as vars; secrets via CLI
├── .gitignore
├── .dev.vars.example         # Example secrets for local dev
└── src/
    ├── index.ts              # Fetch handler + router (if/else, no library)
    ├── auth.ts               # Bearer token validation (timing-safe)
    ├── cors.ts               # CORS preflight + header helpers
    ├── errors.ts             # JSON error response helpers
    ├── types.ts              # Env interface
    └── providers/
        ├── openai.ts         # /v1/chat/completions, /v1/embeddings, /v1/models
        └── anthropic.ts      # /v1/messages
```

9 files total. No routing library — only 5 routes.

## Route Mapping

| Client path | Provider | AI Gateway path |
|---|---|---|
| `GET /health` | — | Health check (no auth) |
| `POST /v1/chat/completions` | OpenAI | `.../openai/chat/completions` |
| `POST /v1/embeddings` | OpenAI | `.../openai/embeddings` |
| `GET /v1/models` | OpenAI | `.../openai/models` |
| `POST /v1/messages` | Anthropic | `.../anthropic/v1/messages` |

AI Gateway base: `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_ID}`

## Auth & Header Transformation

- **Client → Worker**: `Authorization: Bearer <AUTH_TOKEN>` (single shared token, stored as Worker secret)
- **Worker → OpenAI**: Replaces with `Authorization: Bearer <OPENAI_API_KEY>`
- **Worker → Anthropic**: Removes `Authorization`, sets `x-api-key: <ANTHROPIC_API_KEY>`, ensures `anthropic-version` header exists

Timing-safe token comparison via SHA-256 hash + constant-time buffer compare.

## Streaming

No special code needed. Workers runtime handles this natively:

1. `request.body` (ReadableStream) passed directly to upstream `fetch()`
2. Upstream returns `Content-Type: text/event-stream` with ReadableStream body
3. Worker returns the Response as-is — stream pipes to client automatically

## Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `AUTH_TOKEN` | Token clients use to authenticate to the worker |
| `OPENAI_API_KEY` | Forwarded to OpenAI via AI Gateway |
| `ANTHROPIC_API_KEY` | Forwarded to Anthropic via AI Gateway |

## Implementation Steps

1. **Create `package.json`** — zero runtime deps, wrangler + @cloudflare/workers-types + typescript as devDeps
2. **Create `tsconfig.json`** — ESNext target, bundler moduleResolution, @cloudflare/workers-types
3. **Create `wrangler.toml`** — name, main, compatibility_date, [vars] with ACCOUNT_ID/GATEWAY_ID placeholders
4. **Create `.gitignore`** — node_modules, .dev.vars, .wrangler, dist
5. **Create `.dev.vars.example`** — example secrets for local dev
6. **Create `src/types.ts`** — Env interface with vars + secrets
7. **Create `src/errors.ts`** — `jsonError(message, status)` helper
8. **Create `src/cors.ts`** — preflight handler + `addCorsHeaders()` wrapper
9. **Create `src/auth.ts`** — `validateAuth()` with timing-safe comparison
10. **Create `src/providers/openai.ts`** — URL rewrite + header swap for OpenAI endpoints
11. **Create `src/providers/anthropic.ts`** — URL rewrite + header swap for Anthropic endpoint
12. **Create `src/index.ts`** — fetch handler with router, CORS, auth, provider dispatch

## Design Decisions

- **No routing library** — 5 routes don't justify a dependency. Simple `if/else` on pathname.
- **No body parsing** — proxy passes `ReadableStream` through unchanged. Parsing would break streaming and risk altering payloads.
- **`fetch()` not AI Gateway binding** — the `[ai]` binding is for Workers AI models, not proxying to external providers.
- **CORS `*` origin** — safe because auth is bearer-token-based, not cookie-based.
- **Timing-safe auth** — trivial to implement, eliminates timing attack class entirely.

## Verification

```bash
cd workers/ai-gateway
npm install
cp .dev.vars.example .dev.vars  # Fill in real keys + ACCOUNT_ID/GATEWAY_ID in wrangler.toml
npm run dev

# Health check
curl http://localhost:8787/health

# OpenAI (non-streaming)
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}]}'

# Anthropic (streaming)
curl http://localhost:8787/v1/messages \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'

# Auth rejection
curl http://localhost:8787/v1/messages  # → 401

# Deploy
wrangler secret put AUTH_TOKEN && wrangler secret put OPENAI_API_KEY && wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```
