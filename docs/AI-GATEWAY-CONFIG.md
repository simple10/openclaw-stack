# AI Gateway Proxy — Configuration Guide

The AI Gateway Worker proxies LLM requests from the OpenClaw gateway to Anthropic and OpenAI. Provider credentials are stored per-user in Cloudflare KV and managed via the self-service `/config` UI.

The worker supports two upstream routing modes, auto-detected based on which secrets are configured.

See also [Claude Subscription](CLAUDE-SUBSCRIPTION.md) for using OpenClaw with a Claude Code subscription.

## Routing Modes

### Direct API (default)

Requests go directly from the worker to provider APIs (`api.anthropic.com`, `api.openai.com`). This is the simplest setup — just add your provider credentials via the config UI.

```
OpenClaw Gateway → Worker → Anthropic / OpenAI
```

### Cloudflare AI Gateway (optional)

Requests route through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for analytics, caching, and rate limiting. Requires a CF AI Gateway instance and additional secrets.

```
OpenClaw Gateway → Worker → CF AI Gateway → Anthropic / OpenAI
```

The worker auto-detects which mode to use: if `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ACCOUNT_ID`, and `CF_AI_GATEWAY_ID` are all set, it uses CF AI Gateway mode. Otherwise, it routes directly.

---

## Adding Provider Credentials

Visit the config UI at `https://<AI_GATEWAY_WORKER_URL>/config` and authenticate with your gateway token.

The config page supports four credential types:

| Provider | Credential | Field | Notes |
|----------|-----------|-------|-------|
| Anthropic | API Key | `sk-ant-api-*` | Standard API key |
| Anthropic | OAuth Token | `sk-ant-oat-*` | Claude Code subscription token (takes priority over API key) |
| OpenAI | API Key | `sk-*` | Standard API key |
| OpenAI | Codex OAuth | Paste `.codex/auth.json` | Codex subscription (takes priority over API key, auto-refreshes) |

Credentials are stored in Cloudflare KV — they never touch the VPS. Changes take effect immediately.

For each provider, OAuth/subscription credentials take priority over static API keys. You can have both configured as a fallback.

---

## CF AI Gateway Setup

### 1. Create an AI Gateway

1. Go to **Cloudflare Dashboard** -> **AI** -> **AI Gateway**
2. Click **Create Gateway**
3. Note the **Gateway ID** (e.g., `openclaw-ai-gateway`)

### 2. Set the Gateway ID

Edit `workers/ai-gateway/wrangler.jsonc` and set `CF_AI_GATEWAY_ID` to your gateway ID:

```jsonc
"vars": {
  "CF_AI_GATEWAY_ID": "your-gateway-id",
  // ...
}
```

### 3. Set secrets

```bash
cd workers/ai-gateway

# Your Cloudflare account ID (find via `npx wrangler whoami`)
echo "<account-id>" | npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID

# AI Gateway authentication token (create in CF Dashboard -> AI -> AI Gateway -> Settings)
echo "<token>" | npx wrangler secret put CF_AI_GATEWAY_TOKEN
```

### 4. Redeploy

```bash
npm run deploy
```

---

## Verification

### Health check

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
# Expected: {"status":"ok"}
```

### Test an LLM request (Anthropic)

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/anthropic/v1/messages \
  -H "Authorization: Bearer <AI_GATEWAY_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'
```

**Expected:** A valid response from Claude.

### Test an LLM request (OpenAI)

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/openai/v1/chat/completions \
  -H "Authorization: Bearer <AI_GATEWAY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'
```

### Verify CF AI Gateway analytics (CF AI Gateway mode only)

1. Go to **Cloudflare Dashboard** -> **AI** -> **AI Gateway** -> your gateway
2. Check the **Analytics** tab for the test requests

---

## Switching Modes

### From Direct API to CF AI Gateway

1. Create an AI Gateway in the Cloudflare Dashboard
2. Set `CF_AI_GATEWAY_ID` in `wrangler.jsonc`
3. Add `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_TOKEN` secrets
4. Redeploy: `npm run deploy`

### From CF AI Gateway to Direct API

Remove the CF AI Gateway secrets — the worker will automatically fall back to direct mode:

```bash
cd workers/ai-gateway
npx wrangler secret delete CF_AI_GATEWAY_TOKEN
npx wrangler secret delete CF_AI_GATEWAY_ACCOUNT_ID
```

No redeploy needed — secrets take effect immediately.

---

## Admin Endpoints

User and credential management is available via admin API endpoints protected by `ADMIN_AUTH_TOKEN`:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/users` | Create user with optional creds |
| `GET` | `/admin/users` | List all users |
| `PUT` | `/admin/users/:id/creds` | Replace user credentials |
| `DELETE` | `/admin/users/:id` | Delete user + tokens + creds |

Self-service (authenticated by user's own token):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Config UI (no auth — page handles it via JS) |
| `GET` | `/auth/creds` | Get masked credentials |
| `PUT` | `/auth/creds` | Merge-update credentials |
| `POST` | `/auth/rotate` | Rotate token (old tokens expire in 1 hour) |

---

## Troubleshooting

### "No API key configured" error

The user has no provider credentials set for the requested provider. Visit `/config` to add them.

### CF AI Gateway analytics not showing

- Verify all three CF AI Gateway values are set: `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ACCOUNT_ID` (secrets), and `CF_AI_GATEWAY_ID` (var in `wrangler.jsonc`)
- If any are missing, the worker silently falls back to direct mode
- Check Worker logs: Dashboard -> Workers & Pages -> ai-gateway-proxy -> Logs

### 401/403 from provider

- Check credentials via the `/config` UI — ensure the correct key type is set
- Verify the provider account is active and has billing configured
- For Anthropic: API key should start with `sk-ant-api-`, OAuth token with `sk-ant-oat-`
