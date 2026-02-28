# 01 - Cloudflare Workers Deployment

Deploy the AI Gateway and Log Receiver Workers to Cloudflare.

## Overview

This playbook deploys:

- **AI Gateway Worker** — Proxies LLM requests to providers (directly or optionally through CF AI Gateway for analytics)
- **Log Receiver Worker** — Receives container logs from Vector for Cloudflare capture

## Prerequisites

- Cloudflare account with Workers enabled
- Node.js and npm installed locally
- `wrangler` CLI available (installed as devDependency)

## Variables

Config variables (read from `.env`):

- `AI_GATEWAY_URL` — Set after deploying AI Gateway Worker
- `AI_GATEWAY_TOKEN` — Auth token for AI Gateway Worker
- `LOG_WORKER_URL` — Set after deploying Log Receiver Worker
- `LOG_WORKER_TOKEN` — Auth token for Log Receiver Worker

---

## 1.1 Deploy AI Gateway Worker

The AI Gateway Worker proxies LLM API requests to providers (Anthropic, OpenAI), keeping real API keys off the VPS. It routes directly to provider APIs by default, or optionally through Cloudflare AI Gateway for analytics/caching when configured.

> **Note:** During deployment, only `AUTH_TOKEN` is set. Provider API keys (e.g., `ANTHROPIC_API_KEY`) and optional CF AI Gateway configuration are added post-deploy — see `08a-configure-llm-proxy.md` and [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md).

### Setup AI Gateway Worker

```bash
cd workers/ai-gateway
npm install
```

### Configure wrangler.jsonc

If `wrangler.jsonc` doesn't exist, copy from the example template:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

No values need to be changed for a standard deployment. If using multiple Cloudflare accounts, add `"account_id": "<id>"` to `wrangler.jsonc`.

### Check for Existing AI Gateway Worker Deployment

Before deploying, check if the worker is already live. If `AI_GATEWAY_URL` in `.env` is not a placeholder (no angle brackets), curl its health endpoint:

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

- **If healthy (`{"status":"ok"}`):** The worker is already deployed. During a **fresh deploy** (called from `00-fresh-deploy-setup.md`), proceed without pausing — secrets will be re-set. Outside of a fresh deploy, warn the user that re-deploying will overwrite secrets and ask to confirm.
- **If unhealthy or URL is a placeholder:** Proceed with fresh deployment.

### Configure AI Gateway Worker Secrets

#### 1. AUTH_TOKEN

If `AI_GATEWAY_TOKEN` in `.env` is still empty or contains a placeholder, auto-generate a random token:

```bash
openssl rand -hex 32
```

Set the secret and update the config file:

```bash
echo "<generated-token>" | npx wrangler secret put AUTH_TOKEN
# Update AI_GATEWAY_TOKEN in .env with the generated value
```

If `AI_GATEWAY_TOKEN` already has a real value, use that value instead.

### Deploy AI Gateway Worker

```bash
npm run deploy
```

Capture the Worker URL from the output (e.g., `https://ai-gateway-proxy.<account>.workers.dev`). Update `AI_GATEWAY_URL` in `.env` with the real URL.

### Verify

```bash
curl -s https://<worker-url>/health
# Expected: {"status":"ok"}
```

> **What about provider API keys?** The worker is now deployed and healthy, but won't proxy LLM requests until provider API keys are added. This is configured during post-deploy (`08a-configure-llm-proxy.md`) so the VPS deployment can proceed uninterrupted.

---

## 1.2 Deploy Log Receiver Worker

The Log Receiver Worker receives batched log events from Vector and `console.log()`s them. Cloudflare captures Worker console output via real-time Logs dashboard and Logpush. It also stores structured telemetry events in a D1 database for dashboard session exploration.

> **VARS:** `D1_DATABASE_NAME` — read from `workers/log-receiver/wrangler.jsonc` → `d1_databases[0].database_name`. All `wrangler d1` commands below use this value.

### Setup Log Receiver

```bash
cd workers/log-receiver
npm install
```

### Configure wrangler.jsonc

If `wrangler.jsonc` doesn't exist, copy from the example template:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

The D1 `database_id` placeholder will be updated after creating the database (see "Create D1 Database" below).

### Check for Existing Log Receiver Deployment

Before deploying, check if the worker is already live. If `LOG_WORKER_URL` in `.env` is not a placeholder (no angle brackets), curl its health endpoint:

```bash
curl -s https://<LOG_WORKER_URL>/health
```

- **If healthy (`{"status":"ok"}`):** The worker is already deployed. During a **fresh deploy**, proceed without pausing. Outside of a fresh deploy, warn the user that re-deploying will overwrite secrets and ask to confirm.
- **If unhealthy or URL is a placeholder:** Proceed with fresh deployment.

### Configure Log Worker Secrets

If `LOG_WORKER_TOKEN` in `.env` is still empty or contains a placeholder, auto-generate a random token:

```bash
openssl rand -hex 32
echo "<generated-token>" | npx wrangler secret put AUTH_TOKEN
# Update LOG_WORKER_TOKEN in .env with the generated value
```

If `LOG_WORKER_TOKEN` already has a real value, use that value instead:

```bash
echo "<existing-token>" | npx wrangler secret put AUTH_TOKEN
```

### Create D1 Database

The Log Worker stores telemetry events in a D1 database. Check if one already exists:

```bash
npx wrangler d1 list | grep <D1_DATABASE_NAME>
```

- **If it exists:** Skip creation, use the existing database ID.
- **If not found:** Create it:

```bash
npx wrangler d1 create <D1_DATABASE_NAME>
```

Capture the `database_id` from the output and update the placeholder in `wrangler.jsonc`.

### Apply D1 Schema

Apply the events table schema to the remote database:

```bash
npx wrangler d1 execute <D1_DATABASE_NAME> --remote --file=src/schema.sql
```

Verify the table was created:

```bash
npx wrangler d1 execute <D1_DATABASE_NAME> --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
# Expected: events
```

### Deploy Log Worker

```bash
npm run deploy
```

Note the Worker URL from the output (e.g., `https://log-receiver.<account>.workers.dev`).

### Update VPS Configuration

Capture the Worker URL from the deploy output and update `LOG_WORKER_URL` in `.env` (base URL only, no path suffix). `LOG_WORKER_TOKEN` should already be set from the secret configuration step above.

> **Fresh deploy:** During initial deployment, skip the VPS update below — Vector
> isn't running yet. The correct values will be resolved by `bun run pre-deploy`
> when building deployment artifacts.

**Re-deployment only** — if Vector is already running on VPS and you're updating the worker:

```bash
# On VPS-1: update LOG_WORKER_URL and LOG_WORKER_TOKEN in vector/.env, then recreate Vector
# IMPORTANT: `restart` does NOT reload .env — use `up -d` to recreate with new env vars
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose up -d vector'
```

### Verify

```bash
# Health check
curl -s https://<worker-url>/health
# Expected: {"status":"ok"}

# Test log ingestion
curl -X POST https://<worker-url>/logs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"container_name":"test","message":"hello","stream":"stdout","timestamp":"2026-02-07T00:00:00Z"}'
# Expected: {"status":"ok","count":1}

# Test events endpoint (D1 storage)
curl -s -X POST https://<worker-url>/openclaw/events \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"instance":{"id":"test"},"events":[]}'
# Expected: {"status":"ok","count":0}
```

### View Logs in Cloudflare

1. Go to **Cloudflare Dashboard** -> **Workers & Pages** -> **log-receiver**
2. Click **Logs** tab
3. You should see log entries from Vector (after VPS-1 is configured)

---

## Troubleshooting

### Worker Not Deploying

```bash
# Check wrangler auth
npx wrangler whoami

# Re-login if needed
npx wrangler login

# Check for config errors
npx wrangler deploy --dry-run
```

### Logs Not Appearing

```bash
# Check Vector logs on VPS-1
sudo docker logs --tail 50 vector

# Verify Worker URL is correct
echo $LOG_WORKER_URL

# Test Worker directly
curl -X POST <LOG_WORKER_URL>/logs \
  -H "Authorization: Bearer <token>" \
  -d '{"message":"test"}'
```

### AI Gateway Analytics Not Showing (CF AI Gateway mode only)

1. Verify the Gateway ID matches your upstream Cloudflare AI Gateway (Dashboard -> AI -> AI Gateway)
2. Check that `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ACCOUNT_ID`, and `CF_AI_GATEWAY_ID` are all set — the worker routes directly to providers if any are missing
3. Check that requests are going through the Worker (not directly to Anthropic)
4. Check Worker logs for errors: Dashboard -> Workers -> ai-gateway-proxy -> Logs
