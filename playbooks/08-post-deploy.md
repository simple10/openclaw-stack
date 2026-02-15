# 08 - Post-Deploy: Device Pairing & Deployment Report

Guide for configuring the AI proxy, pairing your first device, and completing deployment.

## Overview

After `07-verification.md` confirms all services are healthy and domain routing is
verified, this playbook walks you through:

- Verifying and configuring the AI proxy
- Retrieving the gateway access token
- Opening the OpenClaw UI for the first time
- Approving your first device pairing request
- Generating the deployment report

## Prerequisites

- `07-verification.md` completed successfully
- Domain verified as protected by Cloudflare Access (during `00-fresh-deploy-setup.md`)

---

## 8.1 AI Proxy Configuration

Verify the AI proxy worker and configure provider access so the gateway can reach LLM providers before device pairing.

### Step 1: Health Check

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** `{"status":"ok"}` — the worker was deployed during step 1 (`01-workers.md`).

**If unhealthy:** The worker may not have deployed correctly. Re-run `01-workers.md` § 1.1 before continuing.

### Step 2: Test LLM Proxy

Send a minimal request through the AI proxy to verify it can reach a provider:

```bash
curl -s -w "\n%{http_code}" https://<AI_GATEWAY_WORKER_URL>/anthropic/v1/messages \
  -H "Authorization: Bearer <AI_GATEWAY_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'
```

### Step 3: Evaluate Result

**If 200 (LLM responds):** Provider access is already configured. Skip to § 8.2 (Retrieve Gateway Token).

**If error (expected on fresh deploy — no provider access yet):**

The AI proxy is deployed and healthy, but doesn't have provider access configured yet. Present three options using `AskUserQuestion`:

1. **Setup API keys now** — configure provider keys interactively
2. **Configure Cloudflare AI Gateway** — self-service with instructions
3. **Chat about it** — discuss options with Claude before deciding

#### Option 1: Setup API keys now

Ask a sub-question with two choices:

- **Anthropic API Key** — direct API access with a `sk-ant-*` key
- **Claude Code Subscription** — use an existing Claude Code subscription

**Anthropic API Key flow:**

> "I can add your Anthropic API key to the worker now. The key is stored only in Cloudflare as an encrypted Worker secret — it never touches the VPS and is not saved locally."

Ask the user for their Anthropic API key. When provided (should start with `sk-ant-`):

```bash
cd workers/ai-gateway
echo "<key>" | npx wrangler secret put ANTHROPIC_API_KEY
```

> **OpenAI:** If the user also wants OpenAI, add it the same way: `echo "<key>" | npx wrangler secret put OPENAI_API_KEY`. Otherwise, note in the deployment report that they can add it later.

**Claude Code Subscription flow:**

Tell the user they need a setup token first:

1. Run `claude setup-token` in another terminal, **OR**
2. Run `scripts/ssh-agent.sh` to SSH into the code sandbox, then run `claude setup-token` there

Once the user has the token:

```bash
scripts/enable-claude-subscription.sh --all
```

The script will:

- Prompt the user to paste the token (input is hidden)
- Store the token in the AI Gateway worker via `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN`
- Write `auth-profiles.json` to all agents on the VPS
- Restart the gateway

Wait for the script to complete before continuing.

#### Option 2: Configure Cloudflare AI Gateway

Tell the user the secrets they'll need to set:

| Secret | How to get it |
|--------|---------------|
| `CF_AI_GATEWAY_ACCOUNT_ID` | Run `wrangler whoami` or check CF Dashboard |
| `CF_AI_GATEWAY_TOKEN` | CF Dashboard → AI → AI Gateway settings |
| `CF_AI_GATEWAY_ID` | Set in `wrangler.jsonc` |
| Provider API key(s) | `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` |

Link them to the [Cloudflare Dashboard](https://dash.cloudflare.com/) and [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for the full guide. Note this in the deployment report and continue to § 8.2 — they can finish setup later.

#### Option 3: Chat about it

Explain the options conversationally:

- **Anthropic API Key** is the simplest — paste a key and go. Requires an Anthropic API account with billing.
- **Claude Code Subscription** uses an existing Claude Code subscription (Max or Team plan). No separate API billing needed.
- **Cloudflare AI Gateway** adds analytics, caching, and rate limiting on top of either provider key approach. More setup, but useful for monitoring usage.

When the user is ready, loop back to the options above.

### Step 4: Re-test

After configuration (Option 1 or Option 2), re-run the LLM proxy test from Step 2.

**If 200:** AI proxy is fully configured. Continue to § 8.2.

**If still failing:** Debug before continuing.

#### Debugging

1. **Check worker logs** — run briefly from the local machine while retrying the curl test:

   ```bash
   cd workers/ai-gateway
   npx wrangler tail --format pretty
   ```

   In another terminal, re-run the curl test from Step 2 and check the wrangler tail output for errors.

2. **Common issues:**
   - Invalid API key — double-check the key value, ensure no trailing whitespace
   - Expired or invalid subscription token — re-run `claude setup-token` and `scripts/enable-claude-subscription.sh --all`
   - Provider billing — check your Anthropic/OpenAI account has active billing
   - Worker not picking up new secrets — wait 30 seconds and retry

3. **After 2-3 debugging iterations**, offer to skip:

   > "Would you like to skip AI proxy setup for now and continue with device pairing? You can configure it later via [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md)."

   If skipped, note it in the deployment report (§ 8.6).

---

## 8.2 Retrieve Gateway Token

Read the gateway token from VPS-1:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2"
```

Construct and present the access URL to the user:

```
https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat?token=<TOKEN>
```

> **Note:** If `OPENCLAW_DOMAIN_PATH` is empty in `openclaw-config.env`, the URL is simply `https://<OPENCLAW_DOMAIN>/chat?token=<TOKEN>`.

---

## 8.3 Open the URL

Tell the user to open the URL in their browser.

**Expected behavior:** The browser will connect to the gateway. Because this is a new (unpaired) device, the gateway will close the WebSocket connection with code `1008: pairing required`. The UI will show a "disconnected" or "pairing required" message. This is normal.

**If the page doesn't load at all (connection error or timeout):**

1. Check the tunnel is running:
   - `ssh ... "sudo systemctl status cloudflared"`
2. Check the gateway is running: `ssh ... "sudo docker ps | grep openclaw-gateway"`
3. Check gateway logs: `ssh ... "sudo docker logs --tail 20 openclaw-gateway"`
4. Verify DNS is resolving to the correct destination

Ask the user to confirm they can see the page (even with the pairing error) before proceeding.

---

## 8.4 Approve Device Pairing

After the user opens the URL and sees "pairing required", approve their device.

### Approach 1: Standard CLI Pairing (try first)

The CLI was auto-paired during deployment (`04-vps1-openclaw.md` §4.9).

```bash
# List pending device requests
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices list"
```

Find the `requestId` for the `openclaw-control-ui` client, then approve:

```bash
# Approve the webchat device
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices approve <requestId>"
```

Tell the user to wait ~15 seconds for browser auto-retry.

**If this works:** Skip to § 8.5.

### Approach 2: Re-pair CLI with Explicit Token

If `openclaw devices list` fails with "pairing required", the CLI identity was lost.

```bash
GATEWAY_TOKEN=$(ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2")
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway \
    openclaw devices list --url ws://localhost:18789 --token $GATEWAY_TOKEN"
```

This re-pairs the CLI. Now retry Approach 1.

### Approach 3: File-Based Pairing (from 04-vps1-openclaw.md)

If the CLI pairing keeps failing, use the file-manipulation approach from the
initial deployment. This bypasses the WebSocket pairing handshake entirely.

```bash
# 1. Fix .openclaw ownership (gateway creates dirs as root before gosu drops to node)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway chown -R 1000:1000 /home/node/.openclaw"

# 2. Trigger a pending CLI pairing request (expected to fail, but registers the device)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway openclaw devices list 2>&1 || true"

# 3. Approve the CLI device via file manipulation on the VPS
```

For step 3, run the Python approval script from `04-vps1-openclaw.md` §4.9 on the VPS.
It reads `pending.json`, moves the CLI entry to `paired.json`, and the gateway picks
up the change immediately (no restart needed).

```bash
# 4. Verify CLI is paired
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "openclaw devices list"
```

**Expected:** Shows 1 paired device with role `operator`. Now retry Approach 1 to
approve the browser device.

### Approach 4: Gateway Restart + Fresh Pairing

As a last resort, restart the gateway and try again:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'"
```

Wait 30-60 seconds for full startup (sandbox images are cached, so restarts are faster
than first boot), then retry from Approach 1.

### Tips for Users

- **Pending requests expire after 5 minutes.** If the user waited too long between
  opening the URL and running `devices list`, ask them to refresh the browser page
  to generate a new request.
- **Each browser refresh creates a new request.** Always use the most recent
  `requestId` from `devices list`.
- **The browser auto-retries** every few seconds. After approval, the user just
  needs to wait — no manual refresh needed.
- **Check the browser console** (F12 → Console) if the page doesn't connect after
  approval. Look for WebSocket errors.

---

## 8.5 Verify Connection

Ask the user to confirm:

1. The UI now shows a **connected** status (no more "pairing required" or "disconnected")
2. They can see the **chat interface** and interact with it

**If still not connecting after approval:**

```bash
# Check gateway logs for auth/pairing errors
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker logs --tail 30 openclaw-gateway"

# Re-list devices to confirm approval went through
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices list"
```

If the device shows as approved but the browser still can't connect, ask the user to hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R) and try again.

---

## 8.6 Deployment Report

**IMPORTANT:** After the user confirms the chat interface is working, output a complete deployment report. This is the final step — do NOT skip it.

Collect the following values and present them in a single, neatly formatted report:

### Values to collect

1. **User passwords** — these were generated and displayed during `02-base-setup.md` section 2.2. If you no longer have them in context (e.g., context was compressed), check the `# DEPLOYED:` lines in `openclaw-config.env` first (`grep 'DEPLOYED.*PASSWORD' openclaw-config.env`). If those are also empty, inform the user the passwords were displayed during base setup and can be reset via VNC/console access.

2. **Gateway token** — read from VPS:

   ```bash
   ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
     "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2"
   ```

3. **Domain and URLs** — from `openclaw-config.env`.

### AI proxy status

If AI proxy configuration was skipped in § 8.1, include this callout in the report:

> **AI Proxy:** Not configured. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) to add provider API keys, or run `scripts/enable-claude-subscription.sh` to use a Claude Code subscription.

### Report format

Output the report using exactly this structure:

```
## OpenClaw Deployment Report

**Date:** <current date>
**VPS IP:** <VPS1_IP>
**Domain:** <OPENCLAW_DOMAIN>

---

### VPS Users

| User | Password | Purpose |
|------|----------|---------|
| `adminclaw` | `<password>` | SSH admin, passwordless sudo |
| `openclaw` | `<password>` | App runtime, no SSH, no sudo |

> These passwords are for emergency VNC/console access only. Normal access is via SSH key.

---

### SSH Access

\`\`\`bash
ssh -i <SSH_KEY_PATH> -p 222 adminclaw@<VPS1_IP>
\`\`\`

---

### Gateway Token

\`\`\`
<GATEWAY_TOKEN>
\`\`\`

---

### URLs

| Service | URL |
|---------|-----|
| **Chat** | `https://<DOMAIN><PATH>/chat?token=<TOKEN>` |
| **Control UI** | `https://<DOMAIN><PATH>/?token=<TOKEN>` |
| **Browser VNC** | `https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/` |

All URLs are protected by Cloudflare Access.

---

### Workers

| Worker | URL |
|--------|-----|
| AI Gateway Proxy | `<AI_GATEWAY_WORKER_URL>` |
| Log Receiver | `<LOG_WORKER_URL without /logs suffix>` |

---

### Automated Jobs

| Job | Schedule | Status |
|-----|----------|--------|
| Backup | Daily at 3:00 AM UTC (30-day retention) | Active |
| Host alerter | Every 15 minutes via Telegram | <see note> |
```

Check `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` in `openclaw-config.env`.

**If both are set:** Host alerter is active. Show status as `Active` in the table.

**If either is empty:** Show status as `Not configured` and append:

> **Host alerter** is not configured. To enable disk/memory/CPU alerts via Telegram:
>
> 1. Follow [`docs/TELEGRAM.md`](../docs/TELEGRAM.md) to create a Telegram bot and get your chat ID
> 2. Tell Claude to update the host alerter with your bot token and chat ID

```

---

### Quick Reference

| Task | Command |
|------|---------|
| SSH to VPS | `ssh -i <KEY> -p 222 adminclaw@<IP>` |
| Gateway logs | `sudo docker logs -f openclaw-gateway` |
| Container status | `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'` |
| List devices | `openclaw devices list` |
| Approve device | `openclaw devices approve <requestId>` |
| Run backup | `sudo /home/openclaw/scripts/backup.sh` |
| Update OpenClaw | See `04-vps1-openclaw.md` § Updating OpenClaw |
```

> **Note:** If user passwords are no longer in the conversation context, check `openclaw-config.env` for `# DEPLOYED:` lines first (`grep 'DEPLOYED' openclaw-config.env`). These are written automatically during deployment as a safety net. If those are also empty, the passwords can be reset via VNC/console access.

---

## Troubleshooting

### "Connection refused" when opening the URL

- Tunnel is not running, or DNS is not configured correctly.
- Check `07-verification.md` section 7.6 for networking verification steps.

### Token is rejected (401/403)

- The token in the URL may not match `OPENCLAW_GATEWAY_TOKEN` in the `.env` file.
- Re-read the token from VPS-1 and try again.

### No pending devices after opening URL

- The page may not have fully loaded or attempted a WebSocket connection.
- Check browser developer console for errors.
- Ensure the URL includes the correct token parameter.

### Device approved but still "disconnected"

- Hard-refresh the browser page.
- Check gateway logs for errors after the approval.
- Verify the gateway container hasn't restarted: `sudo docker ps | grep openclaw-gateway`
