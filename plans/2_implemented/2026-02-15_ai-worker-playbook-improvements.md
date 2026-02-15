> let's improve the post-deploy process where claude helps the user setup the AI proxy api keys.
>
> the test and guided setup for the AI worker should come before the device pairing. This way the user
> can just start chatting with openclaw as soon as device pairing is completed.
>
> the flow when prompting the user when the AI proxy test fails...
>
> Ask user if they want to add API keys to the worker or plan on using Cloudflare AI Gateway.
> Give the user three options 1) Setup API keys now, 2) Configure Cloudflare AI Gateway, 3) Chat about it
>
> If the user select #2, tell them the keys they will need and give them the link to the Cloudflare
> (<https://dash.cloudflare.com/>) with some basic instructions.
>
> If the user selects #1, give them the option of Anthropic API Key or Claude Code Subscription. If they select
> subscription, tell them to run `claude setup-token` in another terminal window or to run `scripts/ssh-agent.sh`
> to ssh into the code sandbox, then run `claude setup-token`. Wait for the user to get the setup API key.
> Then have claude run `scripts/enable-claude-subscripton.sh --all` and have the user paste in the API key. The script
> will put the key securely to the cloudflare AI worker and configure openclaw to use the subscription format
> with the AI worker.
>
> Retest the AI worker. Help the user debug it if it's not working. Have claude check the logs output from the AI
> worker via wrangler if needed. Give the user the option to skip AI worker setup and fix it later after a few
> debugging iterations.
>
> Then give the full deployment report. It's critical the full deployment report is shown to the user.

---

# Plan: Improve post-deploy AI proxy setup flow

## Context

The current `08-post-deploy.md` runs AI proxy configuration (§ 8.5) **after** device pairing (§ 8.3-8.4). This means the user finishes pairing, then has to configure API keys, then finally gets the deployment report — but can't actually chat until keys are set up. Moving AI proxy setup before device pairing means the user can start chatting immediately after their device is approved.

The current AI proxy setup flow also lacks:

- Claude Code Subscription as an option (only offers raw API key or CF AI Gateway)
- Debugging guidance when the proxy still fails after configuration
- A way to gracefully skip and come back later

## Files to modify

### 1. `playbooks/08-post-deploy.md` — Rewrite sections 8.1-8.6

**New section order:**

```
8.1 AI Proxy Configuration    (moved from 8.5, rewritten)
8.2 Retrieve Gateway Token     (was 8.1)
8.3 Open the URL               (was 8.2)
8.4 Approve Device Pairing     (was 8.3)
8.5 Verify Connection          (was 8.4)
8.6 Deployment Report          (was 8.6, unchanged)
```

**New § 8.1 AI Proxy Configuration — full rewrite:**

**Step 1: Health check** — `curl /health` on the worker. If unhealthy, re-run `01-workers.md`.

**Step 2: Test LLM proxy** — curl a tiny Anthropic request through the proxy. Same test as today.

**Step 3: If 200** — already configured, skip to § 8.2.

**Step 3: If error** — present three options using AskUserQuestion:

1. **Setup API keys now** — configure provider keys interactively
2. **Configure Cloudflare AI Gateway** — self-service with instructions
3. **Chat about it** — discuss options with Claude before deciding

**Option 1 flow (Setup API keys now):** Ask sub-question with two choices:

- **Anthropic API Key** — ask user to paste their `sk-ant-*` key, run `echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY` from `workers/ai-gateway/`
- **Claude Code Subscription** — tell user to get a setup token:
  1. Run `claude setup-token` in another terminal, OR
  2. Run `scripts/ssh-agent.sh` to SSH into the code sandbox, then run `claude setup-token` there
  3. Once user has the token, Claude runs `scripts/enable-claude-subscription.sh --all`
  4. User pastes the token when the script prompts (input is hidden)
  5. Script stores token in worker via wrangler, writes auth-profiles to all agents, restarts gateway

**Option 2 flow (CF AI Gateway):** Tell user the secrets they'll need:

- `CF_AI_GATEWAY_ACCOUNT_ID` — from `wrangler whoami`
- `CF_AI_GATEWAY_TOKEN` — from CF Dashboard AI Gateway settings
- `CF_AI_GATEWAY_ID` — set in `wrangler.jsonc`
- Plus provider API keys (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)

Link them to [Cloudflare Dashboard](https://dash.cloudflare.com/) and `docs/AI-GATEWAY-CONFIG.md`. Continue to § 8.2 — they can finish setup later.

**Option 3 flow (Chat about it):** Claude explains the options conversationally. User decides. Loop back to the options when ready.

**Step 4: Re-test** — after configuration, re-run the LLM proxy test.

**Step 4a: If still failing — debugging:**

- Check worker logs: `npx wrangler tail --format pretty` from `workers/ai-gateway/` (run briefly, retry the curl, check output)
- Common issues: invalid API key, expired subscription token, provider billing
- After 2-3 debugging iterations, offer to skip: "Would you like to skip AI proxy setup for now and continue with device pairing? You can configure it later via `docs/AI-GATEWAY-CONFIG.md`."
- If skipped, note it in the deployment report

**Step 4b: If 200** — AI proxy working. Continue to § 8.2.

### 2. `playbooks/08-post-deploy.md` — Overview section (lines 7-13)

Update the overview bullet list to reflect the new order:

- Verifying and configuring the AI proxy
- Retrieving the gateway access token
- Opening the OpenClaw UI for the first time
- Approving your first device pairing request
- Generating the deployment report

### 3. `playbooks/08-post-deploy.md` — Deployment Report (§ 8.6)

Add to the report: if AI proxy was skipped, include a callout:

> **AI Proxy:** Not configured. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) to add provider API keys.

Also mention `scripts/enable-claude-subscription.sh` for Claude Code subscription setup.

---

### 4. Cross-reference updates (§ 8.5 → § 8.1)

These files reference `08-post-deploy.md § 8.5` and need updating to `§ 8.1`:

- `REQUIREMENTS.md:565` — secrets table note
- `playbooks/01-workers.md:33` — deployment note
- `playbooks/01-workers.md:89` — provider keys note
- `playbooks/00-fresh-deploy-setup.md:249` — deployment overview note
- `playbooks/07-verification.md:124` — health check note
- `playbooks/07-verification.md:377` — E2E test note
- `docs/POST-DEPLOY.md:9` — provider keys reference

---

## What stays the same

- § 8.2-8.5 (gateway token, open URL, device pairing, verify connection) — content unchanged, just renumbered
- § 8.6 (deployment report format) — unchanged except the AI proxy status callout
- Troubleshooting section — unchanged

## Verification

1. Read through the full rewritten 08-post-deploy.md to confirm the flow reads correctly: health check → test → ask user → configure → re-test → debug → gateway token → open URL → pair → verify → report
2. Verify the `scripts/enable-claude-subscription.sh --all` usage is accurate (it prompts for token, sets worker secret, writes auth-profiles, restarts gateway)
3. Verify section cross-references: other playbooks referencing `08-post-deploy.md § 8.5` need to be updated to `§ 8.1`
4. Search for `§ 8.5` or `8.5` references in other files that point to the old AI proxy section
