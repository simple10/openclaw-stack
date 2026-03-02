# 08a - Configure LLM Proxy

Provide the user with their AI Gateway config link so they can add provider API keys.

## Prerequisites

- Workers deployed (`01-workers.md`)
- Gateway user created with a token (`AI_GATEWAY_TOKEN` in `.env`)

---

## Step 1: Health Check

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** `{"status":"ok"}` — the worker was deployed during step 1 (`01-workers.md`).

**If unhealthy:** The worker may not have deployed correctly. Re-run `01-workers.md` § 1.1 before continuing.

## Step 2: Share Config Link

Provider credentials are managed via the self-service config UI. Give the user their config URL and auth token:

```
Config URL: https://<AI_GATEWAY_WORKER_URL>/config
Auth Token: <AI_GATEWAY_TOKEN from .env>
```

The config page lets users add or update:

- **Anthropic API Key** (`sk-ant-api-*`) — standard API key
- **Anthropic OAuth Token** (`sk-ant-oat-*`) — Claude Code subscription token (takes priority over API key)
- **OpenAI API Key** (`sk-*`) — standard API key
- **OpenAI Codex OAuth** — paste `.codex/auth.json` contents (takes priority over API key)
- **Codex Paste Token** — the config UI can generate a JWT paste token for `openai-codex` setup (used by the `codex --full-setup` flow to authenticate against the AI gateway's codex endpoint)

Credentials are stored in Cloudflare KV — they never touch the VPS.

> **Egress proxy required for Codex:** The `openai-codex` provider routes through `chatgpt.com/backend-api`, which blocks Cloudflare Worker IPs. If `stack.egress_proxy` is configured in `stack.yml`, codex requests are automatically routed through the VPS egress proxy sidecar. Without it, codex requests will fail with a 502 error.

> **Note:** Provider credentials can be added now or later. The deployment can proceed without them — claws will show an error when trying to reach a provider without configured credentials.

See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for details on credential types and optional Cloudflare AI Gateway integration.

Continue to device pairing (`08b-pair-devices.md`).
