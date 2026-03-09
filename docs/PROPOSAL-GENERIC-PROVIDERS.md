# Proposal: feat/generic-providers — Universal Multi-Provider LLM Gateway

**Status:** Implemented
**Branch:** `feat/generic-providers`
**Depends on:** None

---

## Problem

The AI Gateway Worker routes requests to 3 hardcoded providers (Anthropic, OpenAI, OpenAI-Codex). Adding a new provider requires code changes.

---

## Goal

Generalize the Worker into a universal authenticated LLM proxy — 11 additional OpenAI-compatible providers, zero code changes per provider.

---

## Value

- **11 additional providers** (DeepSeek, Groq, Mistral, Together, xAI, OpenRouter, Perplexity, Cohere, Fireworks, MiniMax, Moonshot) available through a single authenticated endpoint
- **Centralized credential management** — all provider API keys in Cloudflare KV, managed via the existing `/config` UI
- **Single gateway token** — clients authenticate once; the Worker resolves the real provider key per request
- **Unified telemetry** — all provider traffic logged through Llemtry, regardless of upstream provider
- **Security boundary** — real API keys never leave KV; clients only see the gateway token
- **No external dependencies** — works immediately with OpenClaw's existing `models.providers` config

Users can add a DeepSeek or Groq key via the Config UI and start using those providers from OpenClaw within minutes.

---

## Architecture

```
OpenClaw agent
  → AI Gateway Worker (Cloudflare)
    [validates gateway token, fetches provider key from KV]
    → Real provider API (DeepSeek, Groq, Mistral, etc.)
```

OpenClaw's `models.providers` config points at `/proxy/{provider}` routes on the Worker:

```jsonc
// openclaw.jsonc
"models": {
  "providers": {
    "deepseek": {
      "baseUrl": "${AI_GATEWAY_URL}/proxy/deepseek",
      "models": []
    }
  }
}
```

---

## Provider Support

11 generic providers (all OpenAI-compatible). Z.AI excluded — its path (`/api/paas/v4/`) is incompatible with the standard `/v1/` pattern.

| Provider    | Base URL                              | Auth   | Notes                   |
|-------------|---------------------------------------|--------|-------------------------|
| cohere      | `https://api.cohere.ai/compatibility` | Bearer | `/compatibility` prefix |
| deepseek    | `https://api.deepseek.com`            | Bearer | Standard                |
| fireworks   | `https://api.fireworks.ai/inference`  | Bearer | `/inference` prefix     |
| groq        | `https://api.groq.com/openai`         | Bearer | `/openai` prefix        |
| minimax     | `https://api.minimax.io`              | Bearer | Standard                |
| mistral     | `https://api.mistral.ai`              | Bearer | Standard                |
| moonshot    | `https://api.moonshot.ai`             | Bearer | `.ai` not `.cn`         |
| openrouter  | `https://openrouter.ai/api`           | Bearer | `/api` prefix           |
| perplexity  | `https://api.perplexity.ai`           | Bearer | No `/v1/models`         |
| together    | `https://api.together.xyz`            | Bearer | Standard                |
| xai         | `https://api.x.ai`                    | Bearer | Standard                |

All 11 use `Authorization: Bearer <key>`. No provider-specific headers required.

Plus 3 existing legacy providers (anthropic, openai, openai-codex) on their existing static routes.

### URL Construction

```
Request:  POST /proxy/groq/v1/chat/completions
               ──── ─────────────────────────
               provider  directPath

Target:   https://api.groq.com/openai/v1/chat/completions
          ───────────────────────────── ─────────────────────
          PROVIDER_DEFAULTS["groq"]     directPath
```

Base URLs do NOT include `/v1` — the `directPath` from route matching provides it.

### Allowed Endpoints (whitelist)

- `POST /proxy/{provider}/v1/chat/completions`
- `POST /proxy/{provider}/v1/embeddings`
- `GET  /proxy/{provider}/v1/models`

No `v1/responses` (OpenAI-specific). No `v1/messages` (Anthropic-specific).

---

## Implementation

### Files changed

| File | Change |
|------|--------|
| `types.ts` | `LegacyProvider` type alias, `GenericRouteMatch` export, `providers` field on `UserCredentials` |
| `routing.ts` | `GENERIC_PROVIDERS` set, `GENERIC_ENDPOINTS` whitelist, `matchGenericRoute()` |
| `config.ts` | `PROVIDER_DEFAULTS` record (11 base URLs), `getGenericProviderConfig()` |
| `keys.ts` | `getGenericApiKey()` reads from `creds.providers[provider].apiKey` |
| `providers/generic.ts` | New — OpenAI-compatible passthrough proxy |
| `index.ts` | Generic route handling: auth → key lookup → `proxyGeneric()` → Llemtry |
| `admin.ts` | `mergeCredentials`/`maskCredentials` extended for `providers` field |
| `config-ui.ts` | Collapsible "Additional Providers" section, 11 API key fields |
| `llemtry.ts` | `ReportOptions.provider` widened to `string` |

### KV Schema (additive, no migration)

```json
{
  "anthropic": { "apiKey": "...", "oauthToken": "..." },
  "openai": { "apiKey": "...", "oauth": { ... } },
  "providers": {
    "deepseek": { "apiKey": "..." },
    "groq": { "apiKey": "..." }
  }
}
```

### Security

- **Endpoint whitelist:** 3 paths only — no arbitrary upstream path probing
- **Provider whitelist:** 11 known providers — no proxying to arbitrary hosts
- **No key, no call:** 401 if `apiKey` is falsy after KV lookup
- **Token isolation:** Gateway token never forwarded — fresh `Authorization` built from KV key
- **KV isolation:** `providers.*` namespace can't collide with legacy keys

### Backward Compatibility

- Existing static routes unchanged
- Existing KV credential format unchanged — `providers` is additive
- Existing OAuth flows unchanged
- Legacy code paths untouched — generic uses separate functions
