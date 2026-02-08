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

## 1.1Deploy AI Gateway Worker

The AI Gateway Worker proxies LLM API requests through Cloudflare AI Gateway, providing usage analytics without exposing real API keys on the VPS.

### Setup

```bash
cd workers/ai-gateway
npm install
```

### Configure Secrets

```bash
# Account ID (find in Cloudflare Dashboard -> Overview -> right sidebar)
npx wrangler secret put ACCOUNT_ID

# Auth token (generate a random token — this is what OpenClaw uses as its "API key")
npx wrangler secret put AUTH_TOKEN

# Real Anthropic API key (stays only in Cloudflare, never on VPS)
npx wrangler secret put ANTHROPIC_API_KEY

# Real OpenAI API key (if using OpenAI models)
npx wrangler secret put OPENAI_API_KEY

# Cloudflare AI Gateway token (for authenticated gateway access)
npx wrangler secret put CF_AI_GATEWAY_TOKEN
```

### Configure AI Gateway

1. Go to **Cloudflare Dashboard** -> **AI** -> **AI Gateway**
2. Create a new gateway (or use existing)
3. Note the Gateway ID (used in `wrangler.jsonc` as `GATEWAY_ID`)

### Deploy

```bash
npm run deploy
```

Note the Worker URL from the output (e.g., `https://ai-gateway-proxy.<account>.workers.dev`).

### Update VPS Configuration

On VPS-1, update the gateway's `.env` to route LLM requests through the Worker:

```bash
# All provider API keys on the VPS are set to the Worker's AUTH_TOKEN
# Anthropic and OpenAI base URLs point to the Worker
# No real provider API keys ever touch the VPS
```

Update `openclaw-config.env` with the Worker URL and auth token.

### Verify

```bash
curl -s https://<worker-url>/health
# Expected: {"status":"ok"}
```

---

## 1.2Deploy Log Receiver Worker

The Log Receiver Worker receives batched log events from Vector and `console.log()`s them. Cloudflare captures Worker console output via real-time Logs dashboard and Logpush.

### Setup

```bash
cd workers/log-receiver
npm install
```

### Configure Secrets

```bash
# Auth token (generate a random token — Vector uses this to authenticate)
npx wrangler secret put AUTH_TOKEN
```

### Deploy

```bash
npm run deploy
```

Note the Worker URL from the output (e.g., `https://log-receiver.<account>.workers.dev`).

### Update VPS Configuration

Update `openclaw-config.env`:

```
LOG_WORKER_URL=https://log-receiver.<account>.workers.dev/logs
LOG_WORKER_TOKEN=<the AUTH_TOKEN you set above>
```

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

## 1.3Configure Cloudflare Health Check

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
