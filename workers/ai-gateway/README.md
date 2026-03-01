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

| Client path | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | None | Health check |
| `/config` | GET | None | Self-service credential config UI |
| `/auth/creds` | GET | User token | Get masked credentials |
| `/auth/creds` | PUT | User token | Merge-update credentials |
| `/auth/rotate` | POST | User token | Rotate gateway token |
| `/admin/users` | POST | Admin token | Create user |
| `/admin/users` | GET | Admin token | List users |
| `/admin/users/:id/creds` | PUT | Admin token | Replace user credentials |
| `/admin/users/:id` | DELETE | Admin token | Delete user |
| `/openai/v1/chat/completions` | POST | User token | OpenAI proxy |
| `/openai/v1/embeddings` | POST | User token | OpenAI proxy |
| `/openai/v1/models` | GET | User token | OpenAI proxy |
| `/anthropic/v1/messages` | POST | User token | Anthropic proxy |

## Auth

Multi-user auth via Cloudflare KV. Users authenticate with `Authorization: Bearer <token>`. Tokens and per-user provider credentials are stored in KV (`AUTH_KV` namespace).

- **User tokens** → KV lookup (`token:<tok>` → userId)
- **Provider credentials** → KV per-user (`creds:<userId>` → credentials)
- **Admin token** → `ADMIN_AUTH_TOKEN` env var (timing-safe comparison)

The worker resolves the upstream provider key from the user's stored credentials before forwarding. Provider-prefixed tokens (e.g., `sk-ant-oat-<gateway-token>`) are handled by stripping the prefix.

## Prerequisites

- Cloudflare account with Workers enabled
- Node.js 18+
- (Optional) [Cloudflare AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) — for analytics, caching, and rate limiting

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure wrangler.jsonc

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

### 3. Create KV namespace

```bash
npx wrangler kv namespace create AUTH_KV
```

Copy the returned `id` into `wrangler.jsonc`.

### 4. Configure secrets for local dev

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with real values.

## Deploy

```bash
# Set admin token
echo "$(openssl rand -hex 32)" | npx wrangler secret put ADMIN_AUTH_TOKEN

# Deploy
npm run deploy

# Create first user
curl -X POST https://<worker-url>/admin/users \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-vps"}'
```

Provider credentials are added post-deploy via the config UI at `/config`.

See [docs/AI-GATEWAY-CONFIG.md](../../docs/AI-GATEWAY-CONFIG.md) for the full configuration guide including optional CF AI Gateway setup.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | Run TypeScript type checker |
