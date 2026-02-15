# Refactor AI Gateway Worker Auth & Routing

## Context

Refactor the ai-gateway worker to unify route matching, return the validated auth token for downstream use, and add OAuth token routing for Anthropic (sk-ant-oat tokens use `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`).

## Changes

### 1. `src/types.ts` — Add new env var

- Add `CLAUDE_CODE_OAUTH_TOKEN: string` to `Env`

### 2. `src/auth.ts` — Change return type

- Rename `validateAuth` → `validateAuthToken`
- Return the **provided token string** on success, `null` on failure (instead of error string on failure / null on success)
- Keep the same extraction logic (Bearer header / x-api-key) and timing-safe comparison (exact match + last-segment match)

### 3. New: `src/routing.ts` — Unified route matching

- Export `type Provider = 'anthropic' | 'openai'`
- Export `matchProviderRoute(method, pathname)` → `{ provider, path } | null`
- Merge logic from `matchOpenAI` and `matchAnthropic` into a single route table

### 4. New: `src/keys.ts` — Provider API key resolution

- Export `getProviderApiKey(provider, authToken, env, request)` → `string`
- Logic:
  - `anthropic` + authToken starts with `sk-ant-oat` → `env.CLAUDE_CODE_OAUTH_TOKEN`
  - `anthropic` otherwise → `env.ANTHROPIC_API_KEY`
  - `openai` → `env.OPENAI_API_KEY`

### 5. `src/providers/anthropic.ts` — Accept `apiKey` parameter

- Change signature: `proxyAnthropic(apiKey, request, env, gwPath)`
- Use `apiKey` parameter instead of `env.ANTHROPIC_API_KEY`
- Remove `matchAnthropic` (moved to routing.ts)

### 6. `src/providers/openai.ts` — Accept `apiKey` parameter

- Change signature: `proxyOpenAI(apiKey, request, env, gwPath)`
- Use `apiKey` parameter instead of `env.OPENAI_API_KEY`
- Remove `matchOpenAI` (moved to routing.ts)

### 7. `src/index.ts` — Rewrite main flow

```ts
const authToken = await validateAuthToken(request, env.AUTH_TOKEN)
if (!authToken) {
  return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
}

const route = matchProviderRoute(request.method, pathname)
if (!route) {
  return addCorsHeaders(jsonError('Not found', 404))
}

const apiKey = getProviderApiKey(route.provider, authToken, env, request)

if (route.provider === 'anthropic') {
  response = await proxyAnthropic(apiKey, request, env, route.path)
} else {
  response = await proxyOpenAI(apiKey, request, env, route.path)
}
return addCorsHeaders(response)
```

### 8. `src/cors.ts` — Add `x-api-key` to allowed headers

- Add `x-api-key` to `Access-Control-Allow-Headers` (currently missing)

## Verification

- `npm run typecheck` passes
- `curl /health` returns ok
- Redeploy with `npm run deploy`
