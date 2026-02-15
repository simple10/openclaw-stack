# Post-Deploy Configuration

Optional configuration steps to run after the automated deployment.

## AI Gateway Proxy Worker

### Configure Provider API Keys

Provider API keys are configured during post-deploy (`08-post-deploy.md` § 8.5). The automated deployment only sets up the worker infrastructure (`AUTH_TOKEN`).

The worker supports two modes:

- **Direct API (default):** Add provider API keys as Worker secrets — requests go directly to Anthropic/OpenAI
- **Cloudflare AI Gateway (optional):** Route through CF AI Gateway for analytics/caching — requires additional setup

See [`docs/AI-GATEWAY-CONFIG.md`](AI-GATEWAY-CONFIG.md) for the full configuration guide covering both modes.

## 2. (Optional) Configure Cloudflare Health Check

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
