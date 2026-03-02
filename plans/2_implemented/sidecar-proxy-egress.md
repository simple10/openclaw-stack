# Plan: VPS Egress Proxy Sidecar

## Context

chatgpt.com's Cloudflare WAF blocks requests from CF Worker IPs (403 "you have been blocked"). The AI gateway worker can't proxy `openai-codex` requests to `chatgpt.com/backend-api`. We need a VPS-side sidecar that the worker routes through — the VPS has a regular IP that chatgpt.com accepts.

The proxy is generic: it reads the real upstream URL from a `_proxyUpstreamURL_` query param, strips it, and forwards headers + body as-is. Reusable for any WAF-blocked upstream, not just codex.

---

## Architecture

```
OpenClaw → AI Gateway Worker (auth, key swap)
  → openai/anthropic: direct to api.openai.com / api.anthropic.com
  → openai-codex:     egress proxy on VPS → chatgpt.com/backend-api
                       (via Cloudflare Tunnel, no public host ports)
```

---

## 1. Egress Proxy — `egress-proxy/proxy.mjs` (new file)

Single-file Node.js HTTP server (~50 lines). Zero dependencies.

**Request flow:**

1. Validate `X-Proxy-Auth` header against `PROXY_AUTH_TOKEN` env var
2. Read `_proxyUpstreamURL_` query param → real upstream URL
3. Strip the param, preserve any other query params on the upstream URL
4. Strip `host` header (let fetch set it from target URL)
5. Strip `X-Proxy-Auth` header (don't forward proxy auth to upstream)
6. Forward all other headers + body as-is to upstream
7. Return upstream response as-is (streaming passthrough)

**Health:** `GET /health` → `{"status":"ok"}` (no auth required)

**No Dockerfile** — uses `node:22-alpine` image directly and mounts the script (same pattern as vector mounts `vector.yaml`).

---

## 2. Docker Compose — `docker-compose.yml.hbs`

Add conditional sidecar after cloudflared, before vector:

```yaml
{{#if stack.egress_proxy}}
  egress-proxy:
    image: node:22-alpine
    container_name: {{stack.project_name}}-egress-proxy
    restart: unless-stopped
    command: ["node", "/app/proxy.mjs"]
    volumes:
      - ./egress-proxy/proxy.mjs:/app/proxy.mjs:ro
    environment:
      - PORT={{stack.egress_proxy.port}}
      - PROXY_AUTH_TOKEN={{stack.egress_proxy.auth_token}}
    networks: [openclaw-net]
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 64M
{{/if}}
```

Port defaults to `8787`. Internal only — no host port mapping.

---

## 3. Stack Config — `stack.yml.example`

Add under `stack:`:

```yaml
egress_proxy:
  port: 8787
  auth_token: ${EGRESS_PROXY_AUTH_TOKEN}
```

`.env.example` gets `EGRESS_PROXY_AUTH_TOKEN=` placeholder.

---

## 4. Pre-deploy — `build/pre-deploy.mjs`

Copy `egress-proxy/` dir to `.deploy/egress-proxy/` during artifact generation (same pattern as `vector/` and `openclaw-stack/`).

---

## 5. AI Gateway Worker Changes

**`src/config.ts`** — Add `egressProxyUrl` to `ProviderConfig` interface. For `openai-codex`, read `EGRESS_PROXY_URL` from env. Put proxy auth token in `headers` field so the existing headers loop in `proxyOpenAI` applies it automatically:

```typescript
'openai-codex': {
  baseUrl: 'https://chatgpt.com/backend-api',
  egressProxyUrl: env.EGRESS_PROXY_URL || undefined,
  headers: env.EGRESS_PROXY_AUTH_TOKEN
    ? { 'X-Proxy-Auth': `Bearer ${env.EGRESS_PROXY_AUTH_TOKEN}` }
    : undefined,
},
```

**`src/providers/openai.ts`** — When `egressProxyUrl` is set, construct wrapped URL and strip CF-injected headers that shouldn't reach the upstream:

```typescript
const targetUrl = `${config.baseUrl}/${path}`
const url = config.egressProxyUrl
  ? `${config.egressProxyUrl}?_proxyUpstreamURL_=${encodeURIComponent(targetUrl)}`
  : targetUrl

if (config.egressProxyUrl) {
  for (const h of ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
                    'x-real-ip', 'x-forwarded-proto', 'x-forwarded-for']) {
    headers.delete(h)
  }
}
```

**`src/index.ts`** — Update the 403 error message to mention egress proxy as the solution.

**`worker-configuration.d.ts`** — Add `EGRESS_PROXY_URL` and `EGRESS_PROXY_AUTH_TOKEN` to Env.

**`.dev.vars.example`** — Add placeholder vars.

---

## 6. Cloudflare Tunnel Route (manual step)

User adds a route in CF Dashboard for their existing tunnel:

- Hostname: e.g. `egress-proxy.yourdomain.com`
- Service: `http://{{stack.project_name}}-egress-proxy:8787`

The `X-Proxy-Auth` token prevents unauthorized use. Optionally add a CF Access policy.

---

## 7. Worker Secrets (manual step)

```bash
echo "https://egress-proxy.yourdomain.com" | npx wrangler secret put EGRESS_PROXY_URL
echo "<token>" | npx wrangler secret put EGRESS_PROXY_AUTH_TOKEN
```

---

## Files Changed

| File | Change |
|------|--------|
| `egress-proxy/proxy.mjs` | **New** — generic egress proxy (~50 lines) |
| `docker-compose.yml.hbs` | Add conditional egress-proxy sidecar |
| `stack.yml.example` | Add `egress_proxy` section |
| `.env.example` | Add `EGRESS_PROXY_AUTH_TOKEN` |
| `build/pre-deploy.mjs` | Copy egress-proxy dir to .deploy |
| `workers/ai-gateway/src/config.ts` | Add `egressProxyUrl` to ProviderConfig + openai-codex config |
| `workers/ai-gateway/src/providers/openai.ts` | URL wrapping + CF header stripping |
| `workers/ai-gateway/src/index.ts` | Update 403 error message |
| `workers/ai-gateway/worker-configuration.d.ts` | Add env var types |
| `workers/ai-gateway/.dev.vars.example` | Add proxy env vars |

---

## Verification

1. `cd workers/ai-gateway && tsc --noEmit` — typecheck worker
2. Deploy worker with `EGRESS_PROXY_URL` + `EGRESS_PROXY_AUTH_TOKEN` secrets
3. Deploy VPS: `npm run pre-deploy` → sync → `docker compose up -d`
4. Add tunnel route in CF Dashboard
5. `curl https://egress-proxy-hostname/health` — proxy health check
6. `curl -X POST "https://egress-proxy-hostname?_proxyUpstreamURL_=https://httpbin.org/post" -H "X-Proxy-Auth: Bearer <token>" -d '{"test":true}'` — proxy roundtrip test
7. Chat with OpenClaw using openai-codex model — end-to-end test
