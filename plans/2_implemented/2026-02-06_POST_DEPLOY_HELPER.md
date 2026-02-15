# Plan: Create `98-post-deploy.md` — First Access & Device Pairing

## Goal

Create a new playbook that Claude follows interactively after deployment to help the user access OpenClaw and pair their first device. This replaces the vague "Access OpenClaw via configured domain" step in `07-verification.md` with a guided, semi-automated flow.

---

## New File

### `playbooks/98-post-deploy.md`

An interactive playbook Claude follows after `07-verification.md` completes. Structure:

**Section 98.1 — Retrieve Gateway Token**

SSH to VPS-1, read `OPENCLAW_GATEWAY_TOKEN` from `/home/openclaw/openclaw/.env`, and construct the access URL:

```
https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat?token=<TOKEN>
```

Present the clickable URL to the user.

**Section 98.2 — Guide User to Open URL**

Tell the user to open the URL in their browser. Explain they'll see either:

- The OpenClaw UI with a "disconnected" or "pairing required" message (expected)
- A connection error (troubleshoot)

**Section 98.3 — Auto-Approve Device Pairing**

After the user confirms they opened the URL:

1. SSH to VPS-1, run `devices list`
2. Find the most recent pending request (match by age — should be seconds old)
3. Auto-approve it
4. Tell the user to wait ~15 seconds for the browser to auto-retry

**Section 98.4 — Verify Connection**

Ask the user to confirm:

- UI shows connected status
- They can see the chat interface

If not working, troubleshoot (check logs, re-list devices, try again).

**Section 98.5 — Manual Reference**

Output a reference block the user can save, covering:

- How to approve future devices via CLI
- How to approve from the Control UI (once one device is paired)
- The `scripts/openclaw_remote.sh` script for interactive container access
- Pending request expiry (5-minute TTL) and browser retry behavior

---

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `playbooks/98-post-deploy.md` | **New file** — interactive first-access playbook |
| 2 | `CLAUDE.md` | Add to playbook table; add as step 15 in execution order |
| 3 | `playbooks/README.md` | Add step 10 to execution order |

---

## Detailed Changes

### 1. `playbooks/98-post-deploy.md` (new)

Full playbook following the standard format (title, overview, prerequisites, numbered sections, bash blocks, troubleshooting). Key bash blocks:

```bash
# 98.1 — Read token from VPS-1
ssh ... "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2"
```

```bash
# 98.3 — List pending devices and approve
ssh ... "sudo docker exec openclaw-gateway node dist/index.js devices list"
ssh ... "sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>"
```

The manual reference section will include:

```bash
# Future device approval via CLI
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway node dist/index.js devices list"
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway node dist/index.js devices approve <requestId>"

# Interactive container access
./scripts/openclaw_remote.sh # SSH into openclaw container
node openclaw.mjs devices list # run openclaw CLI to list devices
```

### 2. `CLAUDE.md`

- Add row to playbook table: `98-post-deploy.md | First access & device pairing | ✓ | -`
- Add step 15 to execution order: `Execute 98-post-deploy.md`

### 3. `playbooks/README.md`

- Add step 10: `98-post-deploy.md - First access & device pairing`

---

## Verification

After creating the playbook:

1. Read back the file to confirm formatting matches other playbooks
2. Verify CLAUDE.md table and execution order are consistent
3. Verify README execution order matches
