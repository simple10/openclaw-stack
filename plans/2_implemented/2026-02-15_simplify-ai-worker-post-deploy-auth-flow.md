# Plan: Simplify AI Worker Post-Deploy Flow

## Context

The current post-deploy AI proxy flow (§ 8.1) presents three options including Claude Code subscription (OAuth), which requires special payload spoofing by `pi-ai` and is beyond the scope of a guided deploy. During the first deploy, this OAuth path caused multiple failures (TypeError crashes, double-slash URLs, Anthropic rejecting OAuth tokens). We want to simplify the guided flow to only support Anthropic API keys, and point users to docs for advanced setups.

## Changes

### 1. Rewrite `playbooks/08-post-deploy.md` § 8.1 (lines 23-156)

Replace the entire § 8.1 with the simplified flow:

**Step 1: Health Check** (same as current)

- `curl -s https://<AI_GATEWAY_WORKER_URL>/health`
- If unhealthy, re-run `01-workers.md § 1.1`

**Step 2: Check if ANTHROPIC_API_KEY is set**

- Run `npx wrangler secret list --cwd workers/ai-gateway` and check if `ANTHROPIC_API_KEY` appears
- If set → go to Step 3
- If not set → use `AskUserQuestion` to ask if user wants to add it now
  - **Yes:** Ask for key, run `echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY --cwd workers/ai-gateway`
  - **Skip:** Note in deployment report that AI proxy is not configured, continue to § 8.2

**Step 3: Test LLM proxy** (only if key is set)

- Send the same curl test as current Step 2
- If 200 → AI proxy configured, continue to § 8.2
- If error → note in deployment report (key may be invalid, billing inactive, etc.), don't block the deploy
  - Show brief troubleshooting tips (check key, check billing)
  - Continue to § 8.2

Remove: Option 2 (CF AI Gateway), Option 3 (Chat about it), Claude Code Subscription sub-option, the extensive debugging section, and the `enable-claude-subscription.sh` reference.

### 2. Update § 8.6 deployment report (lines 333-337)

Update the "AI proxy status" callout:

**If configured and working:**
> **AI Proxy:** Configured and verified.

**If configured but test failed:**
> **AI Proxy:** Anthropic API key is set but the test request failed. Check the key and provider billing. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for troubleshooting.

**If skipped:**
> **AI Proxy:** Not configured. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) to add provider API keys.

### 3. Add post-report link to docs

After the deployment report output (after the Quick Reference section), add a line:

> For additional AI provider configuration (OpenAI, Cloudflare AI Gateway, Claude Code subscription), see [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md).

### 4. Remove `keys.ts` OAuth fallback

File: `workers/ai-gateway/src/keys.ts`

Revert the `?? env.CLAUDE_CODE_OAUTH_TOKEN` fallback that was added during the deploy. The OAuth path should only activate when the auth token explicitly starts with `sk-ant-oat`. Without a fallback, a missing `ANTHROPIC_API_KEY` will be `undefined`, which needs to be handled gracefully.

Change:

```typescript
return env.ANTHROPIC_API_KEY ?? env.CLAUDE_CODE_OAUTH_TOKEN
```

Back to:

```typescript
return env.ANTHROPIC_API_KEY
```

### 5. Add undefined key guard in `index.ts`

File: `workers/ai-gateway/src/index.ts`

After `getProviderApiKey()` returns, check if `apiKey` is undefined and return a clear error:

```typescript
const apiKey = getProviderApiKey(route.provider, authToken, env)
if (!apiKey) {
  return addCorsHeaders(jsonError(`No API key configured for ${route.provider}. Set it via: npx wrangler secret put ${route.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`, 500))
}
```

This prevents the `TypeError: Cannot read properties of undefined (reading 'startsWith')` crash in `proxyAnthropic` when no key is configured.

### 6. Update `wrangler.jsonc` secrets documentation

File: `workers/ai-gateway/wrangler.jsonc`

Keep `CLAUDE_CODE_OAUTH_TOKEN` in the comments (it's still supported), but move it under a separate "Advanced" heading to de-emphasize it.

## Files to modify

| File | Change |
|------|--------|
| `playbooks/08-post-deploy.md` | Rewrite § 8.1, update § 8.6 report callouts, add post-report docs link |
| `workers/ai-gateway/src/keys.ts` | Remove `?? env.CLAUDE_CODE_OAUTH_TOKEN` fallback |
| `workers/ai-gateway/src/index.ts` | Add undefined API key guard before proxying |
| `workers/ai-gateway/wrangler.jsonc` | Reorganize secrets comments |

## Verification

1. Read the updated § 8.1 and confirm the flow matches the 3-step spec
2. Read keys.ts and index.ts to confirm the undefined guard works
3. Deploy worker: `npx wrangler deploy --cwd workers/ai-gateway`
4. Test with no ANTHROPIC_API_KEY set → should get clear error message (not a crash)
5. Test health endpoint → `{"status":"ok"}`
