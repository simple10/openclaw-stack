# Plan: Rework Playbooks — Require Cloudflare Access Before Deploy

## Context

Users on fresh installs are making errors setting up Cloudflare tunnel and Access during post-deploy (step 8). These misconfigurations propagate to the VPS and aren't properly caught or patched. The root cause: domain and Cloudflare Access configuration is deferred to *after* the entire VPS deployment is complete. By requiring users to set up their tunnel routes and Cloudflare Access *before* the deploy begins, Claude has everything needed to fully automate the deployment end-to-end without user intervention until device pairing.

## Files to Modify (8 files)

### 1. `openclaw-config.env.example` — Make domain vars required upfront

**Change:** Move domain variables from "needed for post-deploy" to required section.

```
# REQUIRED TO START
VPS1_IP=15.x.x.1
CF_TUNNEL_TOKEN=                   # Create tunnel first: see docs/CLOUDFLARE-TUNNEL.md

# DOMAIN CONFIGURATION (required — set up tunnel routes + Cloudflare Access first)
OPENCLAW_DOMAIN=openclaw.<example>.com
OPENCLAW_DOMAIN_PATH=               # URL subpath (no trailing slash), blank for root
OPENCLAW_BROWSER_DOMAIN=openclaw.<example>.com
OPENCLAW_BROWSER_DOMAIN_PATH=/browser    # noVNC base path or blank if separate subdomain
```

Remove the old comment "needed for post-deploy, not initial setup".

---

### 2. `CLAUDE.md` — Update configuration section and setup flow

**Changes:**

- **Line 50-53 (Configuration comment block):** Replace "Domain config deferred to post-deploy" with text indicating domain config is required upfront, validated during fresh deploy setup.

- **Line 72 (Setup Question Flow, New deployment):** Change from "only VPS1_IP + CF_TUNNEL_TOKEN + SSH needed to start. Domain configuration is deferred to post-deploy." → "VPS1_IP, CF_TUNNEL_TOKEN, domain config, and SSH needed. Cloudflare Access must be configured before deploy begins."

- **Line 142-143 (Execution Order step 7):** Change post-deploy description from "Configure Cloudflare Tunnel routes, domain setup, browser VNC access, device pairing" → "Device pairing & deployment report"

---

### 3. `playbooks/00-fresh-deploy-setup.md` — Major rework (consolidate all pre-deploy checks)

**Rewrite the entire file with this structure:**

**Header/Overview:** Update to reflect that domain + Cloudflare Access are required upfront (not just VPS1_IP + CF_TUNNEL_TOKEN).

**Prerequisites:** Add "Cloudflare Tunnel created with public hostname routes configured" and "Cloudflare Access application protecting the domain".

**0.1 Config File Check** — Same as current.

**0.2 Required Config** — Expanded. Validate ALL of these:

1. `VPS1_IP` — not placeholder (existing check)
2. `CF_TUNNEL_TOKEN` — not empty (existing check)
3. `OPENCLAW_DOMAIN` — not placeholder (no `<example>` or angle brackets). If placeholder, tell user to configure tunnel routes first per `docs/CLOUDFLARE-TUNNEL.md`.
4. `OPENCLAW_BROWSER_DOMAIN` — not placeholder. Same guidance.
5. `OPENCLAW_BROWSER_DOMAIN_PATH` — validated (can be empty for separate subdomain, or `/browser` for subpath).
6. `OPENCLAW_DOMAIN_PATH` — validated (can be empty).

Report all missing/invalid fields. Wait for user to fix before continuing.

**0.3 SSH Check** — Same as current.

**0.4 VPS Resource Check** — Same as current.

**0.5 Cloudflare Access Verification** — **NEW SECTION**. This is the key addition:

```markdown
## 0.5 Cloudflare Access Verification

Verify the domain is protected by Cloudflare Access before deploying. Run from the local machine:

\```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
\```

### If 302/403 redirect (Location header contains `cloudflareaccess.com` or `access.`):
Cloudflare Access is protecting the domain. Continue to next step.

### If 200 (unprotected):
> "Your domain is accessible without Cloudflare Access. Anyone with the URL could
> reach OpenClaw after deployment. Configure Cloudflare Access first — see
> [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3: Create
> Access Application, Define Policy, Configure Identity Provider).
>
> Let me know when you've set it up."

Wait for user to confirm. Re-run the curl check to verify.

### If connection refused, timeout, or DNS error:
> "Your domain isn't resolving or the tunnel route isn't configured yet. You need to:
>
> 1. Add public hostname routes in your Cloudflare Tunnel (see
>    [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) Step 4)
> 2. Configure Cloudflare Access (Steps 1-3 in the same doc)
>
> Let me know when you've completed these steps."

Wait for user. Re-check.

### Also verify the browser VNC domain:
\```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/ 2>&1 | head -10
\```

Same logic: expect 302/403. If not, guide user to fix.

### Opt-out:
If the user cannot or does not want to set up Cloudflare Access right now, they can
explicitly say so. Warn them:
> "Deploying without Cloudflare Access means the gateway will be publicly accessible
> once the tunnel routes are active. You can add Access protection later, but the
> gateway will be exposed in the meantime."

Only proceed without Access if the user explicitly confirms.
```

**0.6 Worker Placeholder Detection** — Same as current 0.5.

**0.7 Deployment Overview** — Updated from current 0.6:

- Remove the note about domain vars being placeholders
- Update step 7 description: "Post-deploy: device pairing & deployment report"
- Note that domain/access is already verified

---

### 4. `playbooks/02-base-setup.md` — Minor update

**Line 414:** Remove/update the note "The tunnel connects but has no public hostname yet. The domain is configured in post-deploy after Cloudflare Access is set up." → "The tunnel connects and begins routing traffic to the configured public hostname routes. Domain and Cloudflare Access were verified during fresh deploy setup (00-fresh-deploy-setup.md)."

---

### 5. `playbooks/04-vps1-openclaw.md` — Minor update

**Line 271 comment:** Change "Device pairing: tunnel users need CLI approval — see 08-post-deploy.md." — keep this, it's still accurate.

No other changes needed. The `.env` template substitution in §4.5 already uses the domain variables — they're just now guaranteed to have real values instead of potentially being placeholders.

---

### 6. `playbooks/07-verification.md` — Add domain verification to 7.4

**Line 124 (§7.4 note):** Replace:
> "External access via the domain (`curl https://<OPENCLAW_DOMAIN>`) is tested in `08-post-deploy.md` after the user configures Cloudflare Access and the published hostname route."

With a new domain verification check:

```markdown
### Verify domain routing (run from LOCAL machine)

\```bash
# Should get 302/403 redirect to Cloudflare Access login
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
\```

**Expected:** 302 or 403 response with `Location` header pointing to Cloudflare Access.

\```bash
# Also verify browser VNC route
curl -sI --connect-timeout 10 https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/ 2>&1 | head -10
\```

**Expected:** 302 or 403 redirect to Cloudflare Access login.

If either returns 200 (unprotected), warn the user to configure Cloudflare Access.
If connection fails, check tunnel status and DNS (`dig <OPENCLAW_DOMAIN>`).
```

**Line 442 (Success Criteria note):** Update to remove the reference to domain configuration happening in 08-post-deploy:
> "Full end-to-end verification (user authenticating through Cloudflare Access, sending messages) is covered in `08-post-deploy.md` (device pairing) and [`docs/TESTING.md`](../docs/TESTING.md) (browser automation via Chrome DevTools)."

---

### 7. `playbooks/08-post-deploy.md` — Major simplification

**Remove entirely:**

- §8.0 (Connect Gateway Domain via Cloudflare Tunnel) — lines 24-84
- §8.0b (Connect Browser VNC via Cloudflare Tunnel) — lines 87-151

**Restructure remaining sections:**

```markdown
# 08 - Post-Deploy: Device Pairing & Deployment Report

Guide for pairing your first device and completing deployment.

## Overview

After `07-verification.md` confirms all services are healthy and domain routing is
verified, this playbook walks you through:

- Retrieving the gateway access token
- Opening the OpenClaw UI for the first time
- Approving your first device pairing request
- Generating the deployment report

## Prerequisites

- `07-verification.md` completed successfully
- Domain verified as protected by Cloudflare Access (during 00-fresh-deploy-setup.md)

---

## 8.1 Retrieve Gateway Token
[keep existing content — no changes]

---

## 8.2 Open the URL
[keep existing content — no changes]

---

## 8.3 Approve Device Pairing

[Significantly expand this section with escalating approaches]

After the user opens the URL and sees "pairing required", approve their device.

### Approach 1: Standard CLI Pairing (try first)

The CLI was auto-paired during deployment (04-vps1-openclaw.md §4.9).

\```bash
# List pending device requests
ssh ... "openclaw devices list"
\```

Find the `requestId` for `openclaw-control-ui`, then approve:

\```bash
ssh ... "openclaw devices approve <requestId>"
\```

Tell user to wait ~15 seconds for browser auto-retry.

**If this works:** Skip to §8.4.

### Approach 2: Re-pair CLI with Explicit Token

If `openclaw devices list` fails with "pairing required", the CLI identity was lost.

\```bash
GATEWAY_TOKEN=$(ssh ... "sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2")
ssh ... "sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token $GATEWAY_TOKEN"
\```

This re-pairs the CLI. Now retry Approach 1.

### Approach 3: Manual Identity File Creation

If auto-pairing keeps failing, create the identity files manually.

1. Generate a device key pair inside the container:
\```bash
ssh ... "sudo docker exec --user node openclaw-gateway \
  node -e \"const c=require('crypto');const k=c.generateKeyPairSync('ed25519');
  console.log(JSON.stringify({
    publicKey:k.publicKey.export({type:'spki',format:'der'}).toString('base64'),
    privateKey:k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64')
  }))\""
\```

2. Create the identity directory and files:
\```bash
ssh ... "sudo docker exec --user node openclaw-gateway mkdir -p /home/node/.openclaw/identity"
\```

3. Write the identity and device files using the generated keys.

4. Restart and retry `openclaw devices list`.

**If this approach is needed**, refer to the detailed manual pairing steps in
`04-vps1-openclaw.md` Troubleshooting section.

### Approach 4: Gateway Restart + Fresh Pairing

As a last resort, restart the gateway and try again:

\```bash
ssh ... "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'"
\```

Wait 60 seconds for full startup (sandbox image builds), then retry from Approach 1.

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

## 8.4 Verify Connection
[keep existing content — no changes]

---

## 8.5 Deployment Report
[keep existing content from §8.6 — renumber to 8.5, no content changes]

---

## Troubleshooting
[keep existing troubleshooting section — no changes]
```

**Key change:** Remove §8.5 "Reference: Device Management" as standalone section — fold the useful content into §8.3's expanded approaches.

---

### 8. `playbooks/README.md` — Update post-deploy description

**Line 26:** Change "First access & device pairing" → "Device pairing & deployment report"

---

## Verification

After making all changes:

1. **Read through the new flow end-to-end** to verify no step references "deferred" domain config
2. **Check all cross-references** between playbooks still make sense (grep for `08-post-deploy`, `post-deploy`, `deferred`)
3. **Verify `docs/CLOUDFLARE-TUNNEL.md`** — no changes needed; it already covers the full setup. The only difference is *when* users follow it (now: before deploy, previously: after)
4. **Dry-run the fresh deploy flow mentally:**
   - User fills in config (VPS1_IP, CF_TUNNEL_TOKEN, domain vars)
   - User creates tunnel, adds routes, configures Access (per CLOUDFLARE-TUNNEL.md)
   - Claude runs 00-fresh-deploy-setup.md: validates config, SSH, resources, curls domain for 302/403
   - Claude runs 02→03→04→06→reboot→07 fully automated
   - 07-verification now includes domain routing checks
   - 08-post-deploy: just token retrieval, URL opening, device pairing, report
5. **Test that `openclaw-config.env.example` changes don't break existing deploys** — existing deploys use `00-analysis-mode.md`, not `00-fresh-deploy-setup.md`
