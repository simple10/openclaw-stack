# 08a - Configure LLM Proxy

Verify the AI proxy worker and configure provider API keys so claws can reach LLM providers.

## Prerequisites

- `07-verification.md` completed successfully (AI Gateway Worker health check passed)
- Workers deployed (`01-workers.md`)

---

## Step 1: Health Check

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** `{"status":"ok"}` — the worker was deployed during step 1 (`01-workers.md`).

**If unhealthy:** The worker may not have deployed correctly. Re-run `01-workers.md` § 1.1 before continuing.

## Step 2: Check Anthropic API Key

Check if `ANTHROPIC_API_KEY` is already configured:

```bash
npx wrangler secret list --cwd workers/ai-gateway
```

**If `ANTHROPIC_API_KEY` appears in the list:** Go to Step 3.

**If not set:** Use `AskUserQuestion` to ask the user if they want to add an Anthropic API key now.

- **Yes:** Ask for the key (should start with `sk-ant-`). The key is stored only in Cloudflare as an encrypted Worker secret — it never touches the VPS and is not saved locally.

  ```bash
  echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY --cwd workers/ai-gateway
  ```

  > **OpenAI:** If the user also wants OpenAI, add it the same way: `echo "<key>" | npx wrangler secret put OPENAI_API_KEY --cwd workers/ai-gateway`.

  Go to Step 3.

- **Skip:** Note in the deployment report (`08c-deploy-report.md`) that the AI proxy is not configured. Continue to device pairing (`08b-pair-devices.md`).

## Step 3: Test LLM Proxy

Send a minimal request through the AI proxy to verify the key works:

```bash
curl -s -w "\n%{http_code}" https://<AI_GATEWAY_WORKER_URL>/anthropic/v1/messages \
  -H "Authorization: Bearer <AI_GATEWAY_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'
```

**If 200:** AI proxy is configured and working. Continue to device pairing (`08b-pair-devices.md`).

**If error:** Note in the deployment report that the key is set but the test failed. Don't block the deploy.

Brief troubleshooting tips to share with the user:

- Check the API key is correct (no trailing whitespace)
- Verify the Anthropic account has active billing
- Wait 30 seconds and retry (worker may still be picking up the new secret)

Continue to device pairing (`08b-pair-devices.md`).
