# Add Direct API Support to AI Gateway Worker

## Context

Both providers currently hardcode the Cloudflare AI Gateway URL and `cf-aig-authorization` header. We want users to optionally bypass CF AI Gateway and hit provider APIs directly, configurable per-provider via env vars.

## Changes

### 1. New: `src/config.ts` — Provider config factory

- `ProviderConfig` interface: `{ mode: 'gateway' | 'direct', baseUrl: string, headers: Record<string, string> }`
- `createProviderConfig(env)` → `Record<Provider, ProviderConfig>`
- If `ANTHROPIC_DIRECT_URL` is set → direct mode with that URL, no extra headers
- If not set → gateway mode with CF AI Gateway URL + `cf-aig-authorization` header
- Same pattern for `OPENAI_DIRECT_URL`

### 2. `src/types.ts` — Add optional env vars

- `ANTHROPIC_DIRECT_URL?: string`
- `OPENAI_DIRECT_URL?: string`
- Re-export `ProviderConfig` from `./config`

### 3. `src/routing.ts` — Expose both path variants

- Rename `path` → `gatewayPath` in `RouteMatch`
- Add `directPath` field (strip provider prefix, keep `/v1/`)
- Add `toDirectPath()`: `"anthropic/v1/messages"` → `"/v1/messages"`
- Existing `toGatewayPath()`: `"anthropic/v1/messages"` → `"anthropic/messages"`

### 4. `src/providers/anthropic.ts` — Use config instead of env

- Replace `env: Env` param with `config: ProviderConfig, path: string`
- URL: `${config.baseUrl}/${path}`
- Merge `config.headers` instead of hardcoding `cf-aig-authorization`
- Remove all `env.ACCOUNT_ID`, `env.CF_AI_GATEWAY_ID`, `env.CF_AI_GATEWAY_TOKEN` references

### 5. `src/providers/openai.ts` — Same pattern

- Replace `env: Env` param with `config: ProviderConfig, path: string`
- URL: `${config.baseUrl}/${path}`
- Merge `config.headers` instead of hardcoding `cf-aig-authorization`

### 6. `src/index.ts` — Wire up config and path selection

- Create config via `createProviderConfig(env)`
- Pick path: `config.mode === 'gateway' ? route.gatewayPath : route.directPath`
- Pass `providerConfig` and `upstreamPath` to proxy functions

### 7. `wrangler.jsonc` — Document new vars in comments

## Files unchanged

`auth.ts`, `cors.ts`, `errors.ts`, `keys.ts`, `log.ts` — no changes needed

## Verification

- `npm run typecheck` passes
- Default behavior (no `*_DIRECT_URL` set) unchanged — still proxies through CF AI Gateway
- `npm run deploy`
