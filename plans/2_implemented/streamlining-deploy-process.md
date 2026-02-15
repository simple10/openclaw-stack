> we've made some changes to how the ai worker functions. it no longer requires upstream Cloudflare AI Gateway, it's an
> options. By default, the worker will use direct API to the providers (anthropic & openai) if the cloudflare ai gateway env
> vars are not set in the worker.
>
> please scan CLAUDE.md, docs/*and playbooks/* to see what we need to update to reflect this change.
>
> the intended fresh deploy flow is now:
>
> 1. user setups cloudflare tunnel, cloudflare access (including the domain), and the VPS & ssh keys
> 2. claude can then do the full deploy up until device pairing
> 3. User then adds provider API keys or CF AI Gateway config to the AI workers secrets (wrangler put secret). this can
> happen while claude is doing the deploy or during the post deploy. As part of the post deploy verification (before the
> report is shown), claude should test the AI worker endpoint to see if it works, if not, claude should let the user know
> that the ai proxy is not yet working, and then ask them if they plan on using Cloudflare AI Gateway, direct API access to
> the providers, or are not sure. If they're not sure or want to use direct API access, ask them if they would like claude to
> add their anthropic API key to the worker. let them know this will not be saved or shared with the openclaw vps, it will
> be securely added to the worker. If they say ok, then ask for their anthropic api key. When they provide it and it looks
> valid, save it to the worker with wrangler put secret, then test the ai worker endpoint again. Then show them the final
> report. If the ai gateway returned an error, let the user know and direct them to the docs/AI-GATEWAY-CONFIG.md to finish
> setting up the worker.

---

# Plan: Update docs to reflect AI Gateway Worker's optional CF AI Gateway

## Context

The AI Gateway Worker code (`workers/ai-gateway/src/config.ts`) already supports two modes:

1. **Direct API** — routes requests directly to Anthropic/OpenAI APIs (default when CF AI Gateway env vars are not set)
2. **CF AI Gateway** — routes through Cloudflare AI Gateway for analytics/caching (when `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ID`, `CF_AI_GATEWAY_ACCOUNT_ID` are set)

However, all documentation and playbooks still assume CF AI Gateway is **required**. Additionally, provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) were expected to be configured during worker deployment, but the new flow defers this to post-deploy so the VPS deployment can proceed uninterrupted.

**New fresh deploy flow:**

1. User sets up CF Tunnel, CF Access, domain, VPS, and SSH keys
2. Claude runs the full deploy (workers through device pairing) — worker deploys with just `AUTH_TOKEN` (no provider keys needed yet)
3. After device pairing, Claude tests the AI proxy endpoint. If it's not working (no provider keys), Claude walks the user through adding their Anthropic API key (or CF AI Gateway config) via `wrangler secret put`
4. Final deployment report is shown after AI proxy is verified (or user is directed to docs)

---

## Files to modify (14 files)

### 1. `CLAUDE.md` — lines 5, 10

- **Line 10 component table:** Change AI Gateway Worker description from "Cloudflare AI Gateway analytics, API key isolation" to "LLM proxy (direct API or optional CF AI Gateway), API key isolation"
- **Line 5 overview:** Adjust "LLM proxying" wording slightly

### 2. `playbooks/01-workers.md` — Section 1.1 (lines 29-109)

**Major rewrite of AI Gateway Worker deployment:**

- Update description (line 31): no longer "through Cloudflare AI Gateway" — now "proxies LLM requests, optionally through CF AI Gateway"
- **Remove** "Confirm AI Gateway ID" section (lines 51-53) — not needed during deploy
- **Remove** `CF_AI_GATEWAY_TOKEN` secret (lines 86-93) — not set during deploy
- **Remove** `ACCOUNT_ID` secret (lines 57-65) — only needed for CF AI Gateway mode
- **Keep** `AUTH_TOKEN` secret configuration (lines 69-84)
- **Add** a note that provider API keys and optional CF AI Gateway config are set post-deploy (see `08-post-deploy.md`)
- Update the overview (lines 1-10) to reflect the worker proxies LLM requests with optional CF AI Gateway

### 3. `playbooks/08-post-deploy.md` — New section 8.5, renumber old 8.5 to 8.6

**Add new section "8.5 AI Proxy Configuration" between "8.4 Verify Connection" and the deployment report:**

The flow (as specified by the user):

1. Test AI worker health endpoint (`/health`) — should be ok since worker was deployed
2. Test an actual LLM request through the proxy (curl with AUTH_TOKEN to `/v1/messages` with a tiny prompt)
3. **If it works:** Great, move on to the report
4. **If it fails (expected on fresh deploy — no provider keys yet):**
   - Tell user the AI proxy is deployed but not yet configured with provider API keys
   - Ask: Do you plan to use (a) Cloudflare AI Gateway, (b) Direct API access to providers, or (c) Not sure?
   - **If (b) or (c):** Ask if they'd like Claude to add their Anthropic API key to the worker now. Explain: "This will not be saved or shared with the OpenClaw VPS — it will be securely added to the Cloudflare Worker."
   - If yes: Ask for their Anthropic API key
   - When provided and looks valid (`sk-ant-*`): Run `echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY` from `workers/ai-gateway/`
   - Test the AI proxy endpoint again
   - **If (a):** Direct user to `docs/AI-GATEWAY-CONFIG.md` to finish setup
5. If the proxy works after configuration, continue to report
6. If it still fails, note it in the report and direct to `docs/AI-GATEWAY-CONFIG.md`

**Note:** Only offer to add the Anthropic API key interactively. The deployment report should include instructions for adding OpenAI API key separately (via `wrangler secret put OPENAI_API_KEY`).

### 4. `playbooks/07-verification.md` — lines 115-129, 359-375

- **Section 7.3 AI Gateway Worker** (lines 115-129): Keep the health check. Add a note that the health check passing does NOT mean provider keys are configured — that's verified in post-deploy (08)
- **Section 7.7 End-to-End Test** (lines 367-375): Update step 3 wording — LLM response depends on AI proxy having provider keys configured. Add note that this may fail until post-deploy AI proxy configuration

### 5. `REQUIREMENTS.md` — lines 20, 304, 538-566

- **Line 20:** Update architecture diagram line to not imply CF AI Gateway is the only mode
- **Line 304:** Update to reflect that LLM requests go through the AI Gateway Worker (which routes to providers directly or via CF AI Gateway)
- **Lines 538-566 (Section 4.1):** Rewrite description. Split secrets table into "Required" (AUTH_TOKEN) and "Optional — set post-deploy" (ANTHROPIC_API_KEY, OPENAI_API_KEY, CF_AI_GATEWAY_TOKEN, CF_AI_GATEWAY_ACCOUNT_ID). Update vars table.

### 6. `workers/ai-gateway/README.md` — lines 1-45, 99-107

- **Line 1-3:** Update description — CF AI Gateway is optional, worker can route directly
- **Line 6 diagram:** Add alternative flow: `OpenClaw Gateway → Worker → Anthropic / OpenAI` (direct mode)
- **Line 22-23:** Remove "Cloudflare account with AI Gateway created" from prerequisites, or mark optional
- **Lines 35-45 (Setup section 2):** Remove wrangler.toml CF AI Gateway config as a required step. Add a section explaining the two modes (direct vs CF AI Gateway)
- **Lines 99-107 (Deploy secrets):** Show AUTH_TOKEN as required during deploy, provider keys and CF AI Gateway secrets as post-deploy

### 7. `workers/ai-gateway/wrangler.jsonc` — lines 17-34

- Update comments: clarify that CF AI Gateway is optional and auto-detected
- Remove the misleading "To bypass Cloudflare AI Gateway... edit src/config.ts" comment (line 32-33) — bypassing is automatic when env vars aren't set

### 8. `docs/AI-GATEWAY-CONFIG.md` — Currently a stub ("TODO: write this doc")

**Write the full doc.** Sections:

- Overview: two modes (direct API vs CF AI Gateway)
- **Direct API Setup:** `wrangler secret put ANTHROPIC_API_KEY`, `wrangler secret put OPENAI_API_KEY`
- **CF AI Gateway Setup:** Create AI Gateway in CF Dashboard, set `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_TOKEN`, `CF_AI_GATEWAY_ID`
- **Verification:** How to test the proxy with a curl request
- **Switching modes:** Just add/remove the CF AI Gateway secrets and redeploy

### 9. `docs/POST-DEPLOY.md` — lines 1-19

- Update the "Configure Provider API Keys" section to reference the new post-deploy flow in `08-post-deploy.md`
- Mention both modes (direct API and CF AI Gateway)

### 10. `openclaw-config.env.example` — lines 19-23

- Update the comment from "CLOUDFLARE WORKERS (auto-deployed if placeholders remain)" to clarify that provider API keys are configured post-deploy, not here
- These vars are just for the worker URL and auth token (infra), not provider keys

### 11. `playbooks/00-fresh-deploy-setup.md` — lines 232-249

- Section 0.7 deployment overview: Add a note that AI proxy provider keys are configured during post-deploy (step 7), not during worker deployment (step 1). Worker deployment only sets up the infrastructure (AUTH_TOKEN).

### 12. `playbooks/README.md` — line 19

- Update description: "Deploy Cloudflare Workers (AI Gateway + Log Receiver)" — clarify that AI Gateway refers to the proxy worker, not CF AI Gateway

### 13. `playbooks/maintenance.md` — lines 74-84

- Provider API key rotation: mention both modes. In CF AI Gateway mode, keys can optionally be stored in the upstream gateway instead.

### 14. `CLAUDE.md` — Execution Order section (line ~87)

- No change needed — the execution order stays the same. The AI proxy configuration just happens within post-deploy (step 7/8).

---

## Verification

After all edits:

1. Read through each modified file to confirm consistency
2. Search for remaining references to "Cloudflare AI Gateway" that still imply it's required — `grep -r "Cloudflare AI Gateway" --include="*.md"` — and verify each is correctly framed as optional
3. Verify no references to `CF_AI_GATEWAY_TOKEN` as a required secret during deployment
4. Verify the new 08-post-deploy.md flow makes sense end-to-end: health check → test LLM → ask user → configure → re-test → report
5. Verify `docs/AI-GATEWAY-CONFIG.md` covers both modes clearly
