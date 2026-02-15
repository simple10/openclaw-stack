# Fix CLI Auto-Pairing During Initial Deployment

## Context

During initial deployment, the OpenClaw CLI inside the container needs to be paired with the gateway before it can run commands like `devices approve`. But the CLI itself requires pairing — a circular dependency. The webchat device (connecting via Cloudflare Tunnel from outside) also needs pairing, but requires the CLI to approve it.

**Root cause:** The gateway config uses `bind: "lan"` (required for Docker — cloudflared reaches the gateway via the bridge network). When the CLI resolves the gateway URL, it picks the bridge IP (e.g., `ws://172.30.0.3:18789`) instead of loopback. The gateway only auto-approves loopback connections (`127.0.0.1` / `::1`) via the `isLocalClient` → `silent: true` mechanism.

**Fix:** Force the CLI to connect via loopback (`--url ws://localhost:18789 --token <token>`) during initial deployment. This triggers the gateway's auto-approval. Once the CLI's device identity is paired, all subsequent connections work regardless of source IP (device identity is stored in `.openclaw/` which persists via bind mount).

## Changes

### 1. `playbooks/04-vps1-openclaw.md` — Section 4.9

Add a CLI auto-pairing step after the gateway is healthy. Insert after the existing `docker compose ps` / `docker logs` commands:

```bash
# ── Auto-pair the CLI via loopback ──────────────────────────────────
# The CLI needs a paired device identity to run gateway commands.
# Force a loopback connection (--url ws://localhost:18789) which the
# gateway auto-approves (isLocalClient → silent: true).
# This breaks the circular dependency: CLI needs pairing → pairing needs CLI.
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token "$GATEWAY_TOKEN"

# Verify: CLI should now work without --url override
openclaw devices list
```

Also update the section comment to mention auto-pairing.

### 2. `playbooks/07-verification.md` — New Section 7.5b (after Host Alerter, before Security Checklist)

Add CLI pairing verification:

```markdown
## 7.5b Verify CLI Pairing

\```bash
# Verify CLI is paired and can communicate with the gateway
openclaw devices list

# Expected: command succeeds and shows at least one paired device (the CLI itself)
\```

**Expected:** Command completes without "pairing required" errors. At least one device should be listed as paired.

**If it fails with "pairing required":**

Re-run the auto-pairing step from `04-vps1-openclaw.md` section 4.9:

\```bash
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token "$GATEWAY_TOKEN"
\```
```

### 3. `playbooks/08-post-deploy.md` — Section 8.3

Replace the entire section with a simplified version. Since the CLI is already paired (from 4.9), `openclaw devices approve` works directly — no jq/node fallback needed.

**New section 8.3:**

```markdown
## 8.3 Approve Device Pairing

After the user opens the URL and sees the "pairing required" message, approve their webchat device.

The CLI was auto-paired during deployment (section 4.9 of `04-vps1-openclaw.md`),
so `openclaw devices approve` works directly.

\```bash
# 1. List pending device requests
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices list"
\```

Find the `requestId` for the `openclaw-control-ui` client, then approve:

\```bash
# 2. Approve the webchat device
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "openclaw devices approve <requestId>"
\```

Tell the user to wait ~15 seconds — the browser auto-retries and should connect.

### If no pending requests appear

- Pending requests have a **5-minute TTL**. If the user waited too long, ask them to refresh.
- Each browser retry creates a new pending request. Use the most recent `requestId`.

### If CLI fails with "pairing required"

The CLI device identity was lost or never created. Re-run auto-pairing:

\```bash
GATEWAY_TOKEN=$(ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2")
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway \
    openclaw devices list --url ws://localhost:18789 --token $GATEWAY_TOKEN"
\```

Then retry the approval above.
```

### 4. Update `playbooks/08-post-deploy.md` — Section 8.5

Simplify reference section — remove the jq/node fallback, keep it clean.

## Files Modified

| File | Change |
|------|--------|
| `playbooks/04-vps1-openclaw.md` | Add CLI auto-pairing to section 4.9 |
| `playbooks/07-verification.md` | Add section 7.5b for CLI pairing verification |
| `playbooks/08-post-deploy.md` | Simplify section 8.3 (remove jq/node fallback) |

## No Changes Needed

| File | Reason |
|------|--------|
| `deploy/entrypoint-gateway.sh` | Auto-pairing runs from playbook, not entrypoint (gateway must be running first) |
| `deploy/openclaw.json` | No config changes needed; `bind: "lan"` stays (Docker requirement) |
| Host CLI wrapper (4.8e) | Once paired, CLI works from any IP; no `--url` override needed in wrapper |

## How It Works (Technical Detail)

1. `openclaw devices list --url ws://localhost:18789 --token <token>` connects the CLI to the gateway via loopback
2. Gateway's `isLocalDirectRequest()` detects loopback (127.0.0.1) → returns `true`
3. `requestDevicePairing()` is called with `silent: true`
4. `approveDevicePairing()` immediately approves the CLI's device key pair
5. Device key pair is stored in `/home/node/.openclaw/identity/` (bind mount → persists)
6. Paired device is stored in `/home/node/.openclaw/devices/paired.json` (bind mount → persists)
7. All subsequent CLI connections (even via bridge IP 172.30.0.x) succeed because device identity is already paired

## Verification

After implementing, verify on VPS:

```bash
# 1. CLI works from host wrapper (no --url override)
openclaw devices list

# 2. Webchat device approval works
# Open URL in browser → "pairing required" → find requestId → approve
openclaw devices approve <requestId>
# Browser auto-reconnects successfully
```
