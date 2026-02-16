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

Verify the AI proxy worker and configure an Anthropic API key so the gateway can reach LLM providers before device pairing.

### Step 1: Health Check

```bash
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** `{"status":"ok"}` — the worker was deployed during step 1 (`01-workers.md`).

**If unhealthy:** The worker may not have deployed correctly. Re-run `01-workers.md` § 1.1 before continuing.

### Step 2: Check Anthropic API Key

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

- **Skip:** Note in the deployment report (§ 8.6) that the AI proxy is not configured. Continue to § 8.2.

### Step 3: Test LLM Proxy

Send a minimal request through the AI proxy to verify the key works:

```bash
curl -s -w "\n%{http_code}" https://<AI_GATEWAY_WORKER_URL>/anthropic/v1/messages \
  -H "Authorization: Bearer <AI_GATEWAY_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"Say hi"}]}'
```

**If 200:** AI proxy is configured and working. Continue to § 8.2.

**If error:** Note in the deployment report that the key is set but the test failed. Don't block the deploy.

Brief troubleshooting tips to share with the user:

- Check the API key is correct (no trailing whitespace)
- Verify the Anthropic account has active billing
- Wait 30 seconds and retry (worker may still be picking up the new secret)

Continue to § 8.2.

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

### Approach 3: File-Based Pairing

If the CLI pairing keeps failing, bypass WebSocket pairing entirely via file manipulation.

```bash
# 1. Fix .openclaw ownership (gateway creates dirs as root before gosu drops to node)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway chown -R 1000:1000 /home/node/.openclaw"

# 2. Trigger a pending CLI pairing request (expected to fail, but registers the device)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway openclaw devices list 2>&1 || true"

# 3. Approve the CLI device via file manipulation — moves CLI entry from pending.json to paired.json
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "sudo python3 -c \"
import json, time, os
pending_file = '/home/openclaw/.openclaw/devices/pending.json'
paired_file = '/home/openclaw/.openclaw/devices/paired.json'
if not os.path.exists(pending_file):
    print('No pending.json found'); exit(1)
with open(pending_file) as f: pending = json.load(f)
paired = {}
if os.path.exists(paired_file):
    with open(paired_file) as f: paired = json.load(f)
for req_id, req in list(pending.items()):
    if req.get('clientId') == 'cli':
        now = int(time.time() * 1000)
        paired[req['deviceId']] = {
            'deviceId': req['deviceId'], 'publicKey': req['publicKey'],
            'platform': req['platform'], 'clientId': req['clientId'],
            'clientMode': req['clientMode'], 'role': req['role'],
            'roles': req['roles'], 'scopes': req['scopes'],
            'remoteIp': req['remoteIp'],
            'createdAtMs': now, 'approvedAtMs': now, 'tokens': {},
        }
        del pending[req_id]; break
else:
    print('No CLI pending request found'); exit(1)
with open(paired_file, 'w') as f: json.dump(paired, f, indent=2)
with open(pending_file, 'w') as f: json.dump(pending, f, indent=2)
print('CLI device approved')
\""

# 4. Verify CLI is paired (gateway reads files on each connection — no restart needed)
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

Include the appropriate callout in the report based on § 8.1 outcome:

**If configured and working (Step 3 returned 200):**

> **AI Proxy:** Configured and verified.

**If configured but test failed (Step 3 returned an error):**

> **AI Proxy:** Anthropic API key is set but the test request failed. Check the key and provider billing. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for troubleshooting.

**If skipped (user chose to skip in Step 2):**

> **AI Proxy:** Not configured. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) to add provider API keys.

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
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> adminclaw@<VPS1_IP>
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
| Daily report | Daily at <HOSTALERT_DAILY_REPORT_TIME> via Telegram | <see note> |
| Maintenance checker | Daily (30 min before daily report) | Active |
```

Check `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` in `openclaw-config.env`.

**If both are set:** Host alerter and daily report are active. Show status as `Active` in both rows. For the daily report schedule, use the value of `HOSTALERT_DAILY_REPORT_TIME` (default: `9:00 AM UTC`).

**If either is empty:** Show status as `Not configured` for both rows and append:

> **Host alerter & daily report** are not configured. To enable disk/memory/CPU alerts and daily health reports via Telegram:
>
> 1. Follow [`docs/TELEGRAM.md`](../docs/TELEGRAM.md) to create a Telegram bot and get your chat ID
> 2. Tell Claude to update the host alerter with your bot token and chat ID

```

---

### Quick Reference

| Task | Command |
|------|---------|
| SSH to VPS | `./scripts/ssh-vps.sh` |
| SSH to Gateway | `./scripts/ssh-gateway.sh` |
| Gateway logs | `./scripts/logs-gateway.sh` |
| Health Checks | `./scripts/health-check.sh` |
| OpenClaw CLI | `./scripts/openclaw.sh [command]` or SSH to Gateway `openclaw` |
| Run backup | `claude "run the backup script on the vps"` |
| Update OpenClaw | `claude "update openclaw"` |
| Update Sandboxes | `claude "update ffmpeg in the sandbox toolkit"` |
```

> For additional AI provider configuration (OpenAI, Cloudflare AI Gateway, Claude Code subscription), see [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md).

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
