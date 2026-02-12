# Optional Cloudflare Config

This doc is WIP.

## AI Gateway Proxy Worker

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
>
> Optionally, keys can be stored in the upstream Cloudflare AI Gateway, eliminating the need for the worker to have API keys.

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
