# 01 - Cloudflare Workers Deployment

Deploy the AI Gateway and Log Receiver Workers to Cloudflare.

## Overview

This playbook deploys:

- **AI Gateway Worker** — Proxies LLM requests through Cloudflare AI Gateway for analytics
- **Log Receiver Worker** — Receives container logs from Vector for Cloudflare capture

## Prerequisites

- Cloudflare account with Workers enabled
- Node.js and npm installed locally
- `wrangler` CLI available (installed as devDependency)

## Variables

From `../openclaw-config.env`:

- `AI_GATEWAY_WORKER_URL` — Set after deploying AI Gateway Worker
- `AI_GATEWAY_AUTH_TOKEN` — Auth token for AI Gateway Worker
- `LOG_WORKER_URL` — Set after deploying Log Receiver Worker
- `LOG_WORKER_TOKEN` — Auth token for Log Receiver Worker

---

## 1.1 Deploy AI Gateway Worker

The AI Gateway Worker proxies LLM API requests through Cloudflare AI Gateway, providing usage analytics without exposing real API keys on the VPS.

### Setup

```bash
cd workers/ai-gateway
npm install
```

### Check for Existing Deployment

Before deploying, check if the worker is already live. If `AI_GATEWAY_WORKER_URL` in `openclaw-config.env` is not a placeholder (no angle brackets), curl its health endpoint:

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

- **If healthy (`{"status":"ok"}`):** The worker is already deployed. Warn the user: re-deploying will overwrite secrets. Ask to confirm before continuing.
- **If unhealthy or URL is a placeholder:** Proceed with fresh deployment.

### Confirm AI Gateway ID

Read `CF_AI_GATEWAY_ID` from `wrangler.jsonc` (currently `"ai-gateway"`). Ask the user to confirm it matches their upstream Cloudflare AI Gateway (Dashboard -> AI -> AI Gateway).

### Configure Secrets

#### 1. ACCOUNT_ID

Obtain automatically from `wrangler whoami` (parse the account ID from output):

```bash
npx wrangler whoami
# Find the account ID in the output, then set it:
echo "<account-id>" | npx wrangler secret put ACCOUNT_ID
```

#### 2. AUTH_TOKEN

If `AI_GATEWAY_AUTH_TOKEN` in `openclaw-config.env` still contains a placeholder (angle brackets), auto-generate a random token:

```bash
openssl rand -hex 32
```

Set the secret and update the config file:

```bash
echo "<generated-token>" | npx wrangler secret put AUTH_TOKEN
# Update AI_GATEWAY_AUTH_TOKEN in openclaw-config.env with the generated value
```

If `AI_GATEWAY_AUTH_TOKEN` already has a real value, use that value instead.

#### 3. CF_AI_GATEWAY_TOKEN

Prompt the user for this value. This is the token for the upstream Cloudflare AI Gateway — a one-time secret, not stored locally.

```bash
npx wrangler secret put CF_AI_GATEWAY_TOKEN
# (user enters value interactively)
```

### Deploy

```bash
npm run deploy
```

Capture the Worker URL from the output (e.g., `https://ai-gateway-proxy.<account>.workers.dev`). Update `AI_GATEWAY_WORKER_URL` in `openclaw-config.env` with the real URL.

### Verify

```bash
curl -s https://<worker-url>/health
# Expected: {"status":"ok"}
```

### Configure Provider API Keys

> **After verifying the worker is healthy**, add your real LLM provider API keys via the Cloudflare Dashboard (Workers & Pages -> ai-gateway-proxy -> Settings -> Variables and Secrets) or via wrangler:
>
> ```bash
> cd workers/ai-gateway
> npx wrangler secret put ANTHROPIC_API_KEY
> npx wrangler secret put OPENAI_API_KEY  # if using OpenAI models
> ```
>
> These keys are stored only in Cloudflare and never touch the VPS. They are not set during automated deployment — configure them yourself when ready.

---

## 1.2 Deploy Log Receiver Worker

The Log Receiver Worker receives batched log events from Vector and `console.log()`s them. Cloudflare captures Worker console output via real-time Logs dashboard and Logpush.

### Setup

```bash
cd workers/log-receiver
npm install
```

### Check for Existing Deployment

Before deploying, check if the worker is already live. If `LOG_WORKER_URL` in `openclaw-config.env` is not a placeholder (no angle brackets), curl its health endpoint:

```bash
# Strip the /logs path suffix to get the base URL for health check
curl -s https://<LOG_WORKER_BASE_URL>/health
```

- **If healthy (`{"status":"ok"}`):** The worker is already deployed. Warn the user: re-deploying will overwrite secrets. Ask to confirm before continuing.
- **If unhealthy or URL is a placeholder:** Proceed with fresh deployment.

### Configure Secrets

If `LOG_WORKER_TOKEN` in `openclaw-config.env` still contains a placeholder (angle brackets), auto-generate a random token:

```bash
openssl rand -hex 32
echo "<generated-token>" | npx wrangler secret put AUTH_TOKEN
# Update LOG_WORKER_TOKEN in openclaw-config.env with the generated value
```

If `LOG_WORKER_TOKEN` already has a real value, use that value instead:

```bash
echo "<existing-token>" | npx wrangler secret put AUTH_TOKEN
```

### Deploy

```bash
npm run deploy
```

Note the Worker URL from the output (e.g., `https://log-receiver.<account>.workers.dev`).

### Update VPS Configuration

Capture the Worker URL from the deploy output and update `LOG_WORKER_URL` in `openclaw-config.env` (include the `/logs` path suffix). `LOG_WORKER_TOKEN` should already be set from the secret configuration step above.

Then update the VPS `.env` and restart Vector:

```bash
# On VPS-1
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart vector'
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
```

### View Logs in Cloudflare

1. Go to **Cloudflare Dashboard** -> **Workers & Pages** -> **log-receiver**
2. Click **Logs** tab
3. You should see log entries from Vector (after VPS-1 is configured)

---

## 1.3 Configure Cloudflare Health Check

Set up uptime monitoring for the gateway.

1. Go to **Cloudflare Dashboard** -> **Traffic** -> **Health Checks**
2. Click **Create**
3. Configure:
   - **Name:** OpenClaw Gateway
   - **URL:** `https://<OPENCLAW_DOMAIN>/health`
   - **Frequency:** Every 5 minutes
   - **Notification:** Email (and/or webhook)
4. Save

This monitors gateway reachability through the Cloudflare Tunnel.

---

## Verification

```bash
# AI Gateway Worker
curl -s https://<ai-gateway-url>/health

# Log Receiver Worker
curl -s https://<log-receiver-url>/health

# Test log ingestion
curl -X POST https://<log-receiver-url>/logs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"container_name":"test","message":"verification","stream":"stdout","timestamp":"2026-02-07T00:00:00Z"}'
```

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

# Verify Worker URL is correct (must include /logs path)
echo $LOG_WORKER_URL

# Test Worker directly
curl -X POST <LOG_WORKER_URL> \
  -H "Authorization: Bearer <token>" \
  -d '{"message":"test"}'
```

### AI Gateway Analytics Not Showing

1. Verify the Gateway ID in `wrangler.jsonc` matches the Cloudflare AI Gateway
2. Check that requests are going through the Worker (not directly to Anthropic)
3. Check Worker logs for errors: Dashboard -> Workers -> ai-gateway-proxy -> Logs

---

## Future Extensions

- **Logpush:** Configure Cloudflare Logpush to send Worker logs to R2, S3, or external destinations for long-term storage
- **R2 Storage:** Modify Log Receiver Worker to write logs to R2 buckets in addition to console.log()
- **Alerts:** Add Worker-based alerting (e.g., error rate thresholds)
