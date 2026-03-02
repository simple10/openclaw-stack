# Plan: Multi-User Auth & Credential Management via KV

## Context

The AI gateway worker currently uses a single `AUTH_TOKEN` env var for client auth and static env-var API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) for provider credentials. This limits the gateway to a single user/stack.

This plan replaces the entire auth system with KV-backed multi-user support: per-user credentials, rotatable gateway tokens, admin CRUD endpoints, and self-service token rotation. Clean break from env-var auth — no backwards compatibility with `AUTH_TOKEN`.

The OpenAI OAuth refresh logic from the previous plan is preserved but scoped per-user.

---

## KV Key Structure

```
token:tok_a1b2c3...   →  "usr_f7e8d9..."              (userId string, KV TTL for expiring tokens)
creds:usr_f7e8d9...   →  { anthropic: {...}, openai: {...} }   (per-user provider credentials)
users                  →  { "usr_f7e8d9...": { name, ip, tokens, createdAt } }
```

Dashboard browsing: keys sort alphabetically into clean groups (`creds:*`, `token:*`, `users`). Filterable by prefix.

Token expiry uses **KV native TTL** (`kv.put(key, val, { expiration })`) — expired tokens auto-delete. No expiry checks in code.

### Credential Shape

```typescript
interface UserCredentials {
  anthropic?: {
    apiKey?: string       // sk-ant-api-* (regular API key)
    oauthToken?: string   // sk-ant-oat-* (Claude Code subscription)
  }
  openai?: {
    apiKey?: string       // static API key
    oauth?: {             // Codex OAuth (priority over apiKey)
      accessToken: string
      refreshToken: string
      expiresAt: number   // epoch ms
    }
  }
}
```

For Anthropic: `oauthToken` preferred over `apiKey`. The proxy already handles header format by prefix (`sk-ant-oat-*` → `Authorization: Bearer`, else → `x-api-key`).

For OpenAI: `oauth` preferred over `apiKey`. Refresh logic (5-min buffer, graceful degradation on refresh failure) is preserved from prior implementation but scoped per-user.

---

## Endpoints

### Admin (protected by `ADMIN_AUTH_TOKEN` env var)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/users` | Create user with creds, returns `{ userId, token }` |
| `GET` | `/admin/users` | List all users (from `users` registry) |
| `PUT` | `/admin/users/:id/creds` | Update user's provider credentials |
| `DELETE` | `/admin/users/:id` | Delete user + all tokens + creds |

### Self-Service (protected by user's own token)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/rotate` | Generate new token, expire all old tokens in 1 hour |

### Existing (protected by user token — unchanged)

| Method | Path |
|--------|------|
| `POST` | `/anthropic/v1/messages` |
| `POST` | `/openai/v1/chat/completions` |
| `POST` | `/openai/v1/embeddings` |
| `GET`  | `/openai/v1/models` |
| `GET`  | `/health` (no auth) |

---

## Request Flow (proxy)

```
Request with Authorization: Bearer tok_xxx
  → extractToken(request) → "tok_xxx"
  → kv.get("token:tok_xxx") → "usr_abc"  (null = 401, expired = auto-deleted by KV)
  → matchProviderRoute(method, pathname) → RouteMatch
  → kv.get("creds:usr_abc") → UserCredentials
  → resolve provider key (oauthToken/apiKey, with OpenAI OAuth refresh)
  → proxyAnthropic() or proxyOpenAI()
```

---

## Implementation Steps

### Step 1: Rename KV binding, update Env

**`wrangler.jsonc`** — Rename `OPENAI_OAUTH_KV` → `AUTH_KV`. Remove old provider key comments. Add `ADMIN_AUTH_TOKEN` comment.

**`worker-configuration.d.ts`** — Update `Cloudflare.Env`:

- Remove: `AUTH_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_OAUTH_KV`
- Add: `AUTH_KV: KVNamespace`, `ADMIN_AUTH_TOKEN: string`

**`.dev.vars.example`** — Remove old provider key vars and `AUTH_TOKEN`. Add `ADMIN_AUTH_TOKEN`. Update KV comments.

### Step 2: Add KV types to `src/types.ts`

Add `UserCredentials`, `UserEntry`, `UsersRegistry` interfaces (shapes shown above).

### Step 3: Rewrite `src/auth.ts`

Replace env-var comparison with KV token lookup:

```typescript
// Extract token from Authorization: Bearer or x-api-key header
export function extractToken(request: Request): string | null

// Look up token in KV, return userId or null
export async function authenticateRequest(request: Request, kv: KVNamespace): Promise<string | null>

// Compare admin token against env var (timing-safe)
export async function validateAdminToken(request: Request, expectedToken: string): Promise<boolean>
```

Keep `timingSafeEqual` for admin token comparison.

### Step 4: Rewrite `src/keys.ts`

Per-user credential resolution from KV:

```typescript
export async function getProviderApiKey(
  provider: Provider,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<string | undefined>
```

Logic:

1. Read `creds:<userId>` from KV
2. **Anthropic:** return `oauthToken` ?? `apiKey`
3. **OpenAI:** if `oauth` present → check expiry → refresh if needed (via `refreshOpenAIToken`) → write updated creds back to KV → return `accessToken`. Fall back to `apiKey`.

The OpenAI OAuth expiry check + KV write-back moves inline here. `openai-oauth.ts` simplifies to just the HTTP refresh call.

### Step 5: Simplify `src/openai-oauth.ts`

Strip down to just the token refresh HTTP call:

```typescript
export async function refreshOpenAIToken(
  refreshToken: string,
  log: Log
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null>
```

Constants (`TOKEN_ENDPOINT`, `CLIENT_ID`, `REFRESH_BUFFER_MS`) stay. All KV read/write logic moves to `keys.ts`.

### Step 6: Create `src/admin.ts` (new)

Admin CRUD + token rotation handlers:

```typescript
export async function handleAdminRequest(
  request: Request, pathname: string, kv: KVNamespace, log: Log
): Promise<Response>

export async function handleTokenRotation(
  userId: string, kv: KVNamespace, log: Log
): Promise<Response>
```

**`POST /admin/users`** — Generate `usr_` + 16 hex chars (userId) and `tok_` + 48 hex chars (token). Write `token:<token>` → userId, `creds:<userId>` → credentials, update `users` registry. Return `{ userId, token }`.

**`GET /admin/users`** — Read and return `users` registry.

**`PUT /admin/users/:id/creds`** — Validate user exists in registry. Overwrite `creds:<userId>`. Return `{ ok: true }`.

**`DELETE /admin/users/:id`** — Read user's token list from registry. Delete each `token:*` entry. Delete `creds:<userId>`. Remove user from registry. Return `{ ok: true }`.

**`POST /auth/rotate`** (handleTokenRotation) — Read user's tokens from registry. Generate new token. Put `token:<new>` → userId (no TTL). For each old token: re-put with `{ expiration: now + 3600 }` (KV native TTL, 1 hour). Update registry tokens list (append new token). Return `{ token, oldTokensExpireAt }`.

Path matching uses simple regex: `/^\/admin\/users\/([^/]+)(\/creds)?$/`.

### Step 7: Update `src/index.ts`

New routing order:

```
OPTIONS           → CORS preflight
GET /health       → health check (no auth)
/admin/*          → validateAdminToken → handleAdminRequest
POST /auth/rotate → authenticateRequest → handleTokenRotation
/anthropic/*      → authenticateRequest → proxy
/openai/*         → authenticateRequest → proxy
```

Guard: if `!env.AUTH_KV`, return 500 "AUTH_KV not configured" (except health check).

Remove: old `AUTH_TOKEN` usage, old `getProviderApiKey(route.provider, authToken, env, log)` call signature.

### Step 8: Update `src/cors.ts`

Add `PUT` and `DELETE` to `Access-Control-Allow-Methods` for admin endpoints.

---

## Files Changed (summary)

| File | Change |
|------|--------|
| `wrangler.jsonc` | Rename KV binding, update comments |
| `worker-configuration.d.ts` | Remove old env vars, add `AUTH_KV` + `ADMIN_AUTH_TOKEN` |
| `.dev.vars.example` | Remove old vars, add `ADMIN_AUTH_TOKEN`, update comments |
| `src/types.ts` | Add `UserCredentials`, `UserEntry`, `UsersRegistry` |
| `src/auth.ts` | Rewrite: KV token lookup + admin token validation |
| `src/keys.ts` | Rewrite: per-user KV credential resolution |
| `src/openai-oauth.ts` | Simplify to just the HTTP refresh function |
| `src/admin.ts` | **New** — admin CRUD + token rotation |
| `src/index.ts` | New routing, KV-based auth flow |
| `src/cors.ts` | Add PUT, DELETE to allowed methods |

---

## Design Decisions

1. **Clean break** — no `AUTH_TOKEN` fallback. All auth is KV-based. Simpler code, clear migration point.

2. **KV native TTL for token expiry** — `kv.put(key, val, { expiration })` auto-deletes expired tokens. No expiry checks in code. Clean dashboard view (expired tokens disappear).

3. **Per-user OpenAI OAuth refresh** — each user's Codex tokens are refreshed independently. Updated tokens written back to `creds:<userId>`. Same 5-min buffer + graceful degradation as before.

4. **Separate Anthropic fields** — explicit `apiKey` and `oauthToken` fields. Self-documenting, no ambiguity about what credential type is stored.

5. **Simple path matching** — regex in admin.ts instead of a routing framework. The worker only has ~8 routes total.

6. **Single `users` registry** — one KV entry with all user metadata. Acceptable for the expected scale (<10 users). Avoids KV list API calls.

---

## Verification

1. **Typecheck**: `cd workers/ai-gateway && tsc --noEmit`
2. **Deploy dry run**: `wrangler deploy --dry-run`
3. **Create user**: `curl -X POST /admin/users -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"test","ip":"1.2.3.4","creds":{...}}'`
4. **Proxy with user token**: `curl /openai/v1/chat/completions -H "Authorization: Bearer tok_xxx" -d '...'`
5. **Rotate token**: `curl -X POST /auth/rotate -H "Authorization: Bearer tok_xxx"` → verify old token works for 1 hour, new token works immediately
6. **List users**: `curl /admin/users -H "Authorization: Bearer $ADMIN_TOKEN"`
7. **Delete user**: `curl -X DELETE /admin/users/usr_xxx -H "Authorization: Bearer $ADMIN_TOKEN"` → verify token stops working
