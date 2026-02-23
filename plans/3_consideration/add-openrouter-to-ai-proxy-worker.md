# Add OpenRouter Provider to AI Gateway Proxy Worker

## Context

The AI gateway proxy worker currently supports Anthropic and OpenAI via Cloudflare AI Gateway. OpenRouter provides access to many LLM providers through an OpenAI-compatible API, but CF AI Gateway doesn't natively support it. This adds OpenRouter as a direct-proxy provider (bypassing CF AI Gateway, but still getting auth isolation and CORS from our worker), and wires the OpenClaw gateway to route OpenRouter traffic through it.

## Key Design Decision: Routing

OpenRouter uses OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`), which already map to the OpenAI provider. Solution: use a `/openrouter/` path prefix to disambiguate.

| Client path | Upstream |
|---|---|
| `POST /openrouter/v1/chat/completions` | `https://openrouter.ai/api/v1/chat/completions` |
| `POST /openrouter/v1/embeddings` | `https://openrouter.ai/api/v1/embeddings` |
| `GET /openrouter/v1/models` | `https://openrouter.ai/api/v1/models` |

Unlike Anthropic/OpenAI providers, OpenRouter proxies **directly** to `openrouter.ai` (no CF AI Gateway URL, no `cf-aig-authorization` header).

## Part 1: Worker Changes

### 1. Create `workers/ai-gateway/src/providers/openrouter.ts`

New provider following the existing `match` + `proxy` pattern from `openai.ts`:

- `matchOpenRouter(method, pathname)` — checks `/openrouter/v1/...` routes via `ROUTE_MAP`
- `proxyOpenRouter(request, env, apiPath)` — constructs `https://openrouter.ai/api/{apiPath}`, swaps auth to `Bearer ${env.OPENROUTER_API_KEY}`, adds `HTTP-Referer` and `X-Title` headers for OpenRouter app attribution

### 2. Modify `workers/ai-gateway/src/types.ts`

Add to `Env` interface:

- `OPENROUTER_API_KEY: string` (secret)

### 3. Modify `workers/ai-gateway/src/index.ts`

- Import `matchOpenRouter`, `proxyOpenRouter`
- Add routing block before the OpenAI match

### 4. Modify `workers/ai-gateway/wrangler.jsonc`

- Add `OPENROUTER_API_KEY` to the secrets documentation comment

### 5. Modify `workers/ai-gateway/.dev.vars.example`

- Add `OPENROUTER_API_KEY=sk-or-...`

### 6. Modify `workers/ai-gateway/README.md`

- Update architecture diagram, routes table, auth section, deploy secrets, and add curl test example

## Part 2: VPS-Side Wiring (Playbook Updates)

How OpenClaw gets configured to route OpenRouter through the proxy, following the same pattern used for Anthropic/OpenAI.

### 7. Modify `playbooks/04-vps1-openclaw.md` — Compose Override (§ 4.6)

Uncomment `OPENROUTER_API_KEY` and add `OPENROUTER_BASE_URL` in the environment block:

```yaml
    environment:
      # ... existing Anthropic/OpenAI lines ...
      - OPENROUTER_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - OPENROUTER_BASE_URL=${AI_GATEWAY_WORKER_URL}/openrouter/v1
```

**URL math**: OpenClaw's OpenRouter provider (OpenAI-compatible) appends `/chat/completions` to the base URL. With `baseUrl = ${AI_GATEWAY_WORKER_URL}/openrouter/v1`, requests go to `${AI_GATEWAY_WORKER_URL}/openrouter/v1/chat/completions`, matching the worker's route.

**Note**: OpenClaw reads `OPENROUTER_API_KEY` env var for auth (confirmed in `model-auth.ts:298`). Whether it reads `OPENROUTER_BASE_URL` needs verification — if not, the models.json override below handles it.

### 8. Modify `playbooks/04-vps1-openclaw.md` — models.json (§ 4.8)

Add `openrouter` provider to the models.json override, same override-only format as Anthropic/OpenAI:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>"
    },
    "openai": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>/v1"
    },
    "openrouter": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>/openrouter/v1"
    }
  }
}
```

This is the primary mechanism — the embedded agent reads `models.json` from its agent directory and uses `baseUrl` when making API calls for `openrouter/*` models.

### 9. Modify `playbooks/01-workers.md`

Add `OPENROUTER_API_KEY` to the provider secrets deployment section.

## Verification

```bash
cd workers/ai-gateway

# Type check
npm run typecheck

# Local dev (after adding OPENROUTER_API_KEY to .dev.vars)
npm run dev

# Test OpenRouter chat completion
curl http://localhost:8787/openrouter/v1/chat/completions \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-20250514","max_tokens":50,"messages":[{"role":"user","content":"Say hello"}]}'

# Test models list
curl http://localhost:8787/openrouter/v1/models \
  -H "Authorization: Bearer <AUTH_TOKEN>"

# Auth rejection
curl http://localhost:8787/openrouter/v1/chat/completions
# → 401

# Regression: existing OpenAI route still works
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}]}'
```

Deploy: `wrangler secret put OPENROUTER_API_KEY` then `npm run deploy`.

## Key Files

| File | Action |
|---|---|
| `workers/ai-gateway/src/providers/openrouter.ts` | CREATE |
| `workers/ai-gateway/src/types.ts` | MODIFY |
| `workers/ai-gateway/src/index.ts` | MODIFY |
| `workers/ai-gateway/wrangler.jsonc` | MODIFY |
| `workers/ai-gateway/.dev.vars.example` | MODIFY |
| `workers/ai-gateway/README.md` | MODIFY |
| `playbooks/04-vps1-openclaw.md` | MODIFY (§ 4.6 compose override, § 4.8 models.json) |
| `playbooks/01-workers.md` | MODIFY (add secret) |
