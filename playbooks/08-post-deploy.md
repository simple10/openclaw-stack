# 08 - Post-Deploy: First Access & Device Pairing

Interactive guide for accessing OpenClaw and pairing your first device after deployment.

## Overview

After `07-verification.md` confirms all services are healthy, this playbook walks you through:

- Configuring Cloudflare Access and connecting the domain
- Retrieving the gateway access token
- Opening the OpenClaw UI for the first time
- Approving your first device pairing request
- Verifying the connection works end-to-end

## Prerequisites

- `07-verification.md` completed successfully
- OpenClaw gateway running on VPS-1
- Cloudflare Tunnel service running (02-base-setup.md section 2.9)
- Browser available on your local machine

---

## 8.0 Connect Gateway Domain via Cloudflare Tunnel

### Check if OPENCLAW_DOMAIN has a placeholder

Read `OPENCLAW_DOMAIN` from `openclaw-config.env`. If it still contains `<example>` or other angle-bracket placeholders:

> "Your gateway domain isn't configured yet. You need to:
>
> 1. **Decide on your domain** (e.g., `openclaw.yourdomain.com`)
> 2. **Configure Cloudflare Access** — see [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3)
> 3. **Add a public hostname** to your tunnel pointing to `localhost:18789`
>
> Once done, tell me your domain (e.g., `openclaw.mydomain.com`) and I'll update the config."

Wait for the user to provide the domain. Update `OPENCLAW_DOMAIN` in `openclaw-config.env`, then continue.

### Verify domain is protected by Cloudflare Access

```bash
# Test if the domain resolves — should get a 302/403 redirect to the Access login page
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
```

**If connection refused, timeout, or DNS error:**

The user needs to configure Cloudflare Access and add the published hostname route. Present:

> "Your tunnel is running but the domain isn't connected yet. Before connecting it, you should set up Cloudflare Access so the domain is protected from the first request.
>
> Follow the steps in [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md):
>
> 1. **Configure Cloudflare Access** (Steps 1-3) — set up the application, policy, and identity provider
> 2. **Connect your domain** (Step 4) — add the published hostname route in the tunnel config
> 3. **Test** (Step 5) — verify the Access login page appears in an incognito window
>
> Let me know when you've completed these steps."

Wait for the user to confirm before proceeding.

**If the response is a 302/403 redirect** (to a URL containing `cloudflareaccess.com` or `access.` in the `Location` header): Cloudflare Access is protecting the domain. Proceed to section 8.0b.

**If the response is 200** (domain accessible without auth), warn:

> "Your domain is accessible without Cloudflare Access authentication. This means anyone with the URL can reach OpenClaw.
>
> Configure Cloudflare Access now — see [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3).
>
> Let me know when done."

Wait for the user to confirm before proceeding.

> **Note:** Do NOT attempt to verify that the gateway is reachable through the tunnel from here. Cloudflare Access blocks unauthenticated requests. The gateway was already verified internally (localhost) in `07-verification.md`. End-to-end browser verification happens in [`docs/TESTING.md`](../docs/TESTING.md) where the user authenticates through Cloudflare Access via Chrome DevTools.

> **Tunnel routing:** The gateway's WebSocket endpoint accepts connections at any URL path,
> but the Control UI client connects to `wss://<host>/` (root path, not the basePath).
> This means the reverse proxy/tunnel **must use catch-all routing** for the gateway hostname
> — path-based routing (e.g., only forwarding `/openclaw/*`) will break WebSocket connections.
> If both gateway and browser VNC share the same hostname, configure the browser path rule
> (`/browser` → `localhost:6090`) **before** the catch-all gateway rule (`*` → `localhost:18789`).
> There is no gateway config option for a WebSocket basePath.

---

## 8.0b Connect Browser VNC via Cloudflare Tunnel

### Check if OPENCLAW_BROWSER_PUBLIC_URL has a placeholder

Read `OPENCLAW_BROWSER_PUBLIC_URL` from `openclaw-config.env`. If it contains `<example>` or other angle-bracket placeholders:

> "Your browser VNC URL isn't configured yet. You need to:
>
> 1. **Decide on your browser URL** — either:
>    - A subpath on your main domain (e.g., `openclaw.yourdomain.com/browser`)
>    - A separate subdomain (e.g., `browser-openclaw.yourdomain.com`)
> 2. **Add a public hostname** (or path) in your Cloudflare Tunnel pointing to `http://localhost:6090`
> 3. **Protect it with Cloudflare Access** (same Access application or a new one)
>
> Tell me the full browser URL and I'll update the config."

Wait for the user to provide the URL. Then:

1. Update `OPENCLAW_BROWSER_PUBLIC_URL` in `openclaw-config.env`
2. Parse the path component:
   - `openclaw.example.com/browser` → `NOVNC_BASE_PATH=/browser`
   - `browser-openclaw.example.com` → `NOVNC_BASE_PATH=` (empty)
3. Update `NOVNC_BASE_PATH` in the `.env` file on VPS:

```bash
# Update NOVNC_BASE_PATH in .env on VPS
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo sed -i 's|^NOVNC_BASE_PATH=.*|NOVNC_BASE_PATH=<extracted-path>|' /home/openclaw/openclaw/.env"
```

4. Restart the gateway to pick up the new base path:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'"
```

### Verify browser VNC route is protected

```bash
# Test browser VNC URL — should get 302/403 redirect to Cloudflare Access login
curl -sI --connect-timeout 10 https://<OPENCLAW_BROWSER_PUBLIC_URL>/ 2>&1 | head -10
```

**Expected:** A 302 or 403 response redirecting to the Cloudflare Access login page. This confirms the tunnel route exists and is protected. Do NOT expect a 200 — Cloudflare Access blocks unauthenticated requests.

If you get a connection error or timeout, the tunnel route hasn't been configured yet. Ask the user to add it in the Cloudflare Dashboard.

### Verify novnc-proxy internally (via SSH)

```bash
# Check novnc-proxy is running with the correct base path
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker logs openclaw-gateway 2>&1 | grep 'novnc-proxy'"
```

**Expected:** Log line showing `[novnc-proxy] Listening on port 6090, base path: /browser` (or similar, matching the configured path).

```bash
# Internal check: verify the proxy responds on localhost (inside the VPS, bypasses Cloudflare Access)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "curl -sI http://localhost:6090/<NOVNC_BASE_PATH_WITHOUT_LEADING_SLASH>/ 2>&1 | head -5"
```

**Expected:** 200 response with `text/html` content type (the index page).

> **Note:** Full end-to-end browser verification (authenticating through Cloudflare Access and viewing VNC sessions) is covered in [`docs/TESTING.md`](../docs/TESTING.md).

---

## 8.1 Retrieve Gateway Token

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

## 8.2 Open the URL

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

## 8.3 Approve Device Pairing

After the user opens the URL and sees the "pairing required" message, approve their webchat device.

The CLI was auto-paired during deployment (section 4.9 of `04-vps1-openclaw.md`),
so `openclaw devices approve` works directly.

```bash
# 1. List pending device requests
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices list"
```

Find the `requestId` for the `openclaw-control-ui` client, then approve:

```bash
# 2. Approve the webchat device
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices approve <requestId>"
```

Tell the user to wait ~15 seconds — the browser auto-retries and should connect.

### If no pending requests appear

- Pending requests have a **5-minute TTL**. If the user waited too long, ask them to refresh.
- Each browser retry creates a new pending request. Use the most recent `requestId`.

### If CLI fails with "pairing required"

The CLI device identity was lost or never created. Re-run auto-pairing:

```bash
GATEWAY_TOKEN=$(ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2")
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway \
    openclaw devices list --url ws://localhost:18789 --token $GATEWAY_TOKEN"
```

Then retry the approval above.

---

## 8.4 Verify Connection

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

## 8.5 Reference: Device Management

**CLI commands** (from local machine via SSH):

```bash
openclaw devices list                    # List pending/approved
openclaw devices approve <requestId>     # Approve a device
```

**Control UI:** Once one device is paired, approve new devices from the Control UI.

**Notes:** Pending requests expire after 5 minutes. The browser auto-retries, creating new requests. Refresh the page if a request expired.

**Re-pairing the CLI** (if device identity is lost):

```bash
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token "$GATEWAY_TOKEN"
```

---

## 8.6 Deployment Report

**IMPORTANT:** After the user confirms the chat interface is working, output a complete deployment report. This is the final step — do NOT skip it.

Collect the following values and present them in a single, neatly formatted report:

### Values to collect

1. **User passwords** — these were generated and displayed during `02-base-setup.md` section 2.2. If you no longer have them in context (e.g., context was compressed), read them from your conversation history or inform the user they were displayed during base setup and should have been saved.

2. **Gateway token** — read from VPS:
   ```bash
   ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
     "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2"
   ```

3. **Domain and URLs** — from `openclaw-config.env` values set during this playbook.

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
| **Browser VNC** | `https://<BROWSER_URL>/` |

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

Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `openclaw-config.env`.

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

> **Note:** If user passwords are no longer in the conversation context, note that they were displayed during step 2.2 and should have been saved at that time. The passwords can also be reset via VNC/console access if needed.

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
