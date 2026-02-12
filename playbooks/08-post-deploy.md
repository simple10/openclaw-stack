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

## 8.0 Connect Domain via Cloudflare Tunnel

Check if the domain is already routing through the tunnel:

```bash
# Test if the domain resolves and responds
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
```

**If the domain is not reachable (connection refused, timeout, or DNS error):**

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

**If the domain is reachable:** Check for Cloudflare Access headers:

```bash
# Check for CF-Access headers (indicates Access is configured)
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | grep -i 'cf-access\|cf-authorization'
```

If Access headers are present (or the response is a 302/403 redirect to the Access login page), Access is configured — proceed to section 8.1.

If no Access headers and the response is 200 (domain accessible without auth), warn:

> "Your domain is accessible without Cloudflare Access authentication. This means anyone with the URL can reach OpenClaw.
>
> Configure Cloudflare Access now — see [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3).
>
> Let me know when done."

Wait for the user to confirm before proceeding.

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
