# 98 - Post-Deploy: First Access & Device Pairing

Interactive guide for accessing OpenClaw and pairing your first device after deployment.

## Overview

After `07-verification.md` confirms all services are healthy, this playbook walks you through:

- Retrieving the gateway access token
- Opening the OpenClaw UI for the first time
- Approving your first device pairing request
- Verifying the connection works end-to-end

## Prerequisites

- `07-verification.md` completed successfully
- OpenClaw gateway running on VPS-1
- Cloudflare Tunnel configured and active (05-cloudflare-tunnel.md)
- Browser available on your local machine

---

## 98.1 Retrieve Gateway Token

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

## 98.2 Open the URL

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

## 98.3 Approve Device Pairing

After the user confirms they opened the URL, approve their device.

### First device pairing (file-based)

The CLI command `devices list` connects to the gateway via WebSocket, which itself requires
a paired device — a circular dependency on first deployment. Use the file-based approach instead:

```bash
# 1. Read pending requests directly from the filesystem
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway cat /home/node/.openclaw/devices/pending.json"
```

Find the `requestId` from the output, then approve it:

```bash
# 2. Approve the most recent pending request
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  'sudo docker exec openclaw-gateway python3 << "PYEOF"
import json, os, time
pending_file = "/home/node/.openclaw/devices/pending.json"
paired_file = "/home/node/.openclaw/devices/paired.json"
with open(pending_file) as f:
    pending = json.load(f)
if not pending:
    print("No pending requests found. Ask the user to refresh the browser page.")
    exit(1)
paired = []
if os.path.exists(paired_file):
    with open(paired_file) as f:
        paired = json.load(f)
device = pending[-1]
device["approvedAt"] = int(time.time() * 1000)
paired.append(device)
with open(paired_file, "w") as f:
    json.dump(paired, f, indent=2)
print(f"Approved device: {device.get('"'"'name'"'"', device.get('"'"'requestId'"'"', '"'"'unknown'"'"'))}")
PYEOF'
```

Tell the user to wait approximately 15 seconds — the browser will automatically retry the connection and should connect successfully once the device is approved.

> **Note:** After the first device is paired, subsequent devices can be approved from the
> Control UI or via the CLI `devices approve` command (see below).

### Subsequent devices (CLI)

Once at least one device is paired, the CLI works normally:

```bash
# List pending/approved devices
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices list"

# Approve a pending device
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices approve <requestId>"
```

### If no pending requests appear

- Pending requests have a **5-minute TTL**. If the user waited too long, the request may have expired. Ask them to refresh the page and re-read `pending.json`.
- Each browser retry creates a new pending request, so there may be multiple. The Python script approves the most recent one.

---

## 98.4 Verify Connection

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

## 98.5 Reference: Device Management

Present this reference block for the user to save:

```
╔══════════════════════════════════════════════════════════════╗
║                   Device Pairing Reference                   ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  APPROVE DEVICES VIA CLI                                     ║
║  ─────────────────────                                       ║
║  # List pending/approved devices:                            ║
║  ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \ ║
║    "openclaw devices list"                                   ║
║                                                              ║
║  # Approve a pending device:                                 ║
║  ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \ ║
║    "openclaw devices approve <requestId>"                    ║
║                                                              ║
║  APPROVE FROM CONTROL UI                                     ║
║  ───────────────────────                                     ║
║  Once at least one device is paired, you can approve         ║
║  new devices directly from the OpenClaw Control UI           ║
║  without using the CLI.                                      ║
║                                                              ║
║  INTERACTIVE CONTAINER ACCESS                                ║
║  ────────────────────────────                                ║
║  ./scripts/openclaw_remote.sh                                ║
║                                                              ║
║  NOTES                                                       ║
║  ─────                                                       ║
║  • Pending requests expire after 5 minutes (TTL).            ║
║  • The browser automatically retries the connection.         ║
║  • Each retry creates a new pending request.                 ║
║  • If a request expired, refresh the page to create a new    ║
║    one, then approve it.                                     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
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
