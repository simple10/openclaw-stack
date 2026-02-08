# Plan: Streamline AI Gateway Worker deployment in 01-workers.md

## Context

The current `01-workers.md` section 1.1 requires the user to manually run `wrangler secret put` for 5 secrets (ACCOUNT_ID, AUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, CF_AI_GATEWAY_TOKEN). This is error-prone and tedious. We want to automate what we can, reduce prompts, and guard against accidental re-deployment.

The playbook is triggered automatically from CLAUDE.md Step 0 **only when placeholders are detected** in worker config fields. However, the playbook can also be run manually (e.g., from "Modify" flow), so it needs its own safety check.

## Changes

### 1. Add deployment guard at top of each worker section

At the start of section 1.1 (AI Gateway) and 1.2 (Log Receiver), add a guard step:

**Before deploying, check if the worker is already live** by curling its health endpoint (using the URL from `openclaw-config.env` if it's not a placeholder). If the health check succeeds, the worker is already deployed — **ask the user to confirm** before proceeding, warning that re-deploying will overwrite secrets.

This prevents accidental re-deployment whether the playbook is triggered automatically or manually.

### 2. Rewrite section 1.1 "Configure Secrets" in `playbooks/01-workers.md`

Replace the current block of 5 `wrangler secret put` commands with this flow:

**ACCOUNT_ID** — Obtain automatically from `wrangler whoami` (parse the account ID from its output). Set via `wrangler secret put` non-interactively.

**AUTH_TOKEN** — Auto-generate a random token (e.g., `openssl rand -hex 32`) if `AI_GATEWAY_AUTH_TOKEN` in `openclaw-config.env` still contains a placeholder. Set via `wrangler secret put` non-interactively. Then update `AI_GATEWAY_AUTH_TOKEN` in `openclaw-config.env` with the generated value.

**CF_AI_GATEWAY_TOKEN** — Prompt the user for this value during first deployment. This is the token for the upstream Cloudflare AI Gateway — it's a one-time secret, not stored locally. Set via `wrangler secret put`.

**ANTHROPIC_API_KEY / OPENAI_API_KEY** — Do NOT prompt or set these during deployment. Add a post-deployment note instructing the user to configure provider API keys via Cloudflare Dashboard or `wrangler secret put` after deployment.

### 3. Update the "Configure AI Gateway" subsection

Remove the manual "go to dashboard, note the Gateway ID" steps. Replace with: read `CF_AI_GATEWAY_ID` from `wrangler.jsonc` and confirm with user that it matches their upstream Cloudflare AI Gateway.

### 4. Update "Update VPS Configuration" subsection

After deployment, `openclaw-config.env` should already have the real `AI_GATEWAY_AUTH_TOKEN` (set during secret generation). Note that `AI_GATEWAY_WORKER_URL` should be updated with the URL from the deploy output.

### 5. Add post-deployment note about provider API keys

Add a clearly marked note after the deploy+verify steps:

> **Configure provider API keys:** After verifying the worker is healthy, add your real LLM provider API keys via the Cloudflare Dashboard (Workers & Pages -> ai-gateway-proxy -> Settings -> Variables and Secrets) or via wrangler:
>
> ```bash
> cd workers/ai-gateway
> npx wrangler secret put ANTHROPIC_API_KEY
> npx wrangler secret put OPENAI_API_KEY  # if using OpenAI models
> ```
>
> These keys are stored only in Cloudflare and never touch the VPS.

## File to modify

- `playbooks/01-workers.md` — rewrite section 1.1 (lines 29–91)

## New section 1.1 structure

```
## 1.1 Deploy AI Gateway Worker

[intro paragraph — unchanged]

### Setup
cd workers/ai-gateway && npm install

### Check for Existing Deployment
- If AI_GATEWAY_WORKER_URL is not a placeholder, curl its /health endpoint
- If healthy: warn that worker is already deployed, ask user to confirm before continuing
- If not healthy or URL is a placeholder: proceed with fresh deployment

### Confirm AI Gateway ID
- Read CF_AI_GATEWAY_ID from wrangler.jsonc (currently "ai-gateway")
- Ask user to confirm it matches their Cloudflare AI Gateway

### Configure Secrets
1. Get ACCOUNT_ID from `wrangler whoami`
   - Parse account ID, set via `echo "<id>" | npx wrangler secret put ACCOUNT_ID`
2. Generate AUTH_TOKEN (if AI_GATEWAY_AUTH_TOKEN is a placeholder)
   - `openssl rand -hex 32`
   - Set via `echo "<token>" | npx wrangler secret put AUTH_TOKEN`
   - Update AI_GATEWAY_AUTH_TOKEN in openclaw-config.env
3. Ask user for CF_AI_GATEWAY_TOKEN (one-time, for upstream AI Gateway auth)
   - Set via `npx wrangler secret put CF_AI_GATEWAY_TOKEN`

### Deploy
npm run deploy
- Capture Worker URL from output
- Update AI_GATEWAY_WORKER_URL in openclaw-config.env

### Verify
curl health check

### Configure Provider API Keys
Post-deployment note: add ANTHROPIC_API_KEY, OPENAI_API_KEY via
Dashboard or `wrangler secret put` — not automated, user does this themselves.
```

## Verification

1. Read the rewritten section 1.1 end-to-end for coherent flow
2. Confirm deployment guard checks health endpoint before proceeding
3. Confirm no references to `wrangler secret put ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the automated steps
4. Confirm `CF_AI_GATEWAY_TOKEN` is prompted once (not stored locally)
5. Confirm `AUTH_TOKEN` is auto-generated and saved to `openclaw-config.env`
