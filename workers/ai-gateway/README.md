# AI Gateway Proxy Worker

Cloudflare Worker that proxies LLM API calls to Anthropic and OpenAI. Sits between the OpenClaw gateway and providers without changing request/response formats. Routes directly to provider APIs by default, or optionally through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for observability, caching, and rate limiting.

```
Direct mode (default):
  OpenClaw Gateway → Worker (auth, key swap) → Anthropic / OpenAI

CF AI Gateway mode (optional):
  OpenClaw Gateway → Worker (auth, URL rewrite) → Cloudflare AI Gateway → Anthropic / OpenAI
```

Streaming works transparently — request and response bodies are passed through as `ReadableStream` without parsing.

## Routes

| Client path | Method | Provider |
|---|---|---|
| `/health` | GET | Health check (no auth) |
| `/v1/chat/completions` | POST | OpenAI |
| `/v1/embeddings` | POST | OpenAI |
| `/v1/models` | GET | OpenAI |
| `/v1/messages` | POST | Anthropic |

## Prerequisites

- Cloudflare account with Workers enabled
- Node.js 18+
- API keys for the providers you want to proxy (can be added post-deploy)
- (Optional) [Cloudflare AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) created — for analytics, caching, and rate limiting

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. (Optional) Configure CF AI Gateway

By default, the worker routes directly to provider APIs (Anthropic, OpenAI). No `wrangler.jsonc` changes are needed.

To route through **Cloudflare AI Gateway** for analytics/caching, set `CF_AI_GATEWAY_ID` in `wrangler.jsonc` and add the required secrets (see [docs/AI-GATEWAY-CONFIG.md](../../docs/AI-GATEWAY-CONFIG.md)). The worker auto-detects CF AI Gateway mode when `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ACCOUNT_ID`, and `CF_AI_GATEWAY_ID` are all set.

### 3. Configure secrets for local dev

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with real values:

```
AUTH_TOKEN=a-strong-shared-secret
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Local development

```bash
npm run dev
```

Test the health endpoint:

```bash
curl http://localhost:8787/health
```

Test an OpenAI request:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}]}'
```

Test an Anthropic request (streaming):

```bash
curl http://localhost:8787/v1/messages \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

Verify auth rejection:

```bash
curl http://localhost:8787/v1/messages
# → 401 {"error":{"message":"Missing Authorization header"}}
```

## Deploy

### 1. Set AUTH_TOKEN (required during deployment)

```bash
wrangler secret put AUTH_TOKEN
```

### 2. Deploy the worker

```bash
npm run deploy
```

### 3. Verify

```bash
curl https://ai-gateway-proxy.<your-subdomain>.workers.dev/health
```

### 4. Add provider API keys (post-deploy)

Provider keys are added after deployment so the VPS setup can proceed uninterrupted:

```bash
wrangler secret put ANTHROPIC_API_KEY    # Required for Anthropic models
wrangler secret put OPENAI_API_KEY       # Required for OpenAI models
```

See [docs/AI-GATEWAY-CONFIG.md](../../docs/AI-GATEWAY-CONFIG.md) for the full configuration guide including optional CF AI Gateway setup.

## Configuring OpenClaw

Point the OpenClaw gateway at the worker URL instead of directly at the provider APIs. The worker accepts the same request format — just change the base URL and use your `AUTH_TOKEN` as the bearer token.

## Auth

Clients authenticate with `Authorization: Bearer <AUTH_TOKEN>`. The worker swaps this for the real provider API key before forwarding:

- **OpenAI** — replaces with `Authorization: Bearer <OPENAI_API_KEY>`
- **Anthropic** — removes `Authorization`, sets `x-api-key: <ANTHROPIC_API_KEY>`

Token comparison is timing-safe (SHA-256 digest + constant-time compare).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | Run TypeScript type checker |
