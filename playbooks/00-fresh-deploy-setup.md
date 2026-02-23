# 00 - Fresh Deploy Setup

Validation and overview for starting a fresh VPS deployment. All required configuration — including domain and Cloudflare Access — must be in place before deployment begins.

## Overview

This playbook validates the configuration needed to deploy OpenClaw on a fresh Ubuntu VPS. Domain settings (`OPENCLAW_DOMAIN`, `OPENCLAW_DASHBOARD_DOMAIN`, `OPENCLAW_DASHBOARD_DOMAIN_PATH`, `OPENCLAW_DOMAIN_PATH`) and Cloudflare Access protection are required upfront so the full deployment can run end-to-end without interruption.

## Prerequisites

- A fresh Ubuntu VPS (>= 24.04) with root/sudo access
- An SSH key pair for VPS access
- A Cloudflare account with a domain
- Cloudflare Tunnel created with public hostname routes configured
- Cloudflare Access application protecting the domain

---

## 0.1 Config File Check

Check that `openclaw-config.env` exists:

```bash
ls openclaw-config.env
```

**If missing:** Offer to create it from the example:

```bash
cp openclaw-config.env.example openclaw-config.env
```

Then ask the user to fill in the required values (see section 0.2).

---

## 0.2 Required Config

Validate all of these fields:

1. **`VPS1_IP`** — Must be set and not a placeholder (not `15.x.x.1` or containing `<`).
2. **`CF_TUNNEL_TOKEN`** — Must not be empty.
3. **`OPENCLAW_DOMAIN`** — Must not be a placeholder (no `<example>` or angle brackets).
4. **`OPENCLAW_DASHBOARD_DOMAIN`** — Must not be a placeholder.
5. **`OPENCLAW_DASHBOARD_DOMAIN_PATH`** — Validated (can be empty for separate subdomain, or a path like `/browser`).
6. **`OPENCLAW_DOMAIN_PATH`** — Validated (can be empty for root).
7. **`YOUR_TELEGRAM_ID`** — Must be set and numeric (Telegram user IDs are integers). If empty, warn the user: "Send a message to @userinfobot on Telegram to get your numeric user ID."
8. **`OPENCLAW_TELEGRAM_BOT_TOKEN`** — Must be set. If empty, warn the user: "Create a Telegram bot via @BotFather and paste the token here. See `docs/TELEGRAM.md`."

### If any fields are invalid or missing

Report **all** issues at once (don't stop at the first one). Present them as:

> **Configuration issues found:**
>
> - `VPS1_IP` is still a placeholder (`15.x.x.1`) — set it to your VPS public IP
> - `CF_TUNNEL_TOKEN` is empty — create a tunnel in Cloudflare Dashboard and paste
>   the token (see [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md))
> - `OPENCLAW_DOMAIN` is still a placeholder — set it to your actual domain
>   (e.g., `openclaw.yourdomain.com`). You need to configure Cloudflare Tunnel
>   public hostname routes first (see [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md))
> - `OPENCLAW_DASHBOARD_DOMAIN` is still a placeholder — same as above
> - `YOUR_TELEGRAM_ID` is empty — send a message to @userinfobot on Telegram to get your ID
> - `OPENCLAW_TELEGRAM_BOT_TOKEN` is empty — create a bot via @BotFather and paste the token
>   (see [`docs/TELEGRAM.md`](../docs/TELEGRAM.md))
>
> Update `openclaw-config.env` and let me know when ready.

Wait for user to fix all issues before continuing. Re-validate after they confirm.

---

## 0.3 SSH Check

1. Validate `SSH_KEY_PATH` exists on the local system (default: `~/.ssh/vps1_openclaw_ed25519`).
2. Test SSH connectivity using config values (`SSH_USER`, `SSH_PORT`):

```bash
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS OK"
```

**If SSH fails — diagnose by error type:**

**"Connection refused" or "Connection timed out":**

> "Can't reach the VPS on port 22. Possible causes:
>
> - The VPS isn't running or hasn't finished booting
> - The IP address is incorrect — double-check `VPS1_IP` in `openclaw-config.env`
> - The VPS provider's firewall is blocking SSH — check the provider's dashboard"

**"Host key verification failed" (REMOTE HOST IDENTIFICATION HAS CHANGED):**

> "The SSH host key doesn't match a previously known key for this IP. If you
> reinstalled the VPS or reused the IP from a previous deployment, clear the
> stale entry:"

```bash
ssh-keygen -R <VPS1_IP>
```

Then retry the SSH test.

**"Permission denied (publickey)":**

> "SSH key authentication failed. Possible causes:
>
> - The key at `<SSH_KEY_PATH>` wasn't added to the VPS during provisioning
> - The key file doesn't exist — check: `ls -la <SSH_KEY_PATH>`
> - The SSH agent doesn't have the key loaded — try: `ssh-add <SSH_KEY_PATH>`"

---

## 0.4 VPS Resource Check

After SSH is confirmed working, query the VPS hardware to verify gateway container resource limits match the host.

### Query VPS Resources

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "nproc && free -b | awk '/^Mem:/{print \$2}'"
```

This returns two lines: CPU count (e.g., `6`) and total memory in bytes (e.g., `11811160064`).

### Compare Against Config

Read current gateway resource limits from `deploy/docker-compose.override.yml`:

- `deploy.resources.limits.cpus` (e.g., `"6"`)
- `deploy.resources.limits.memory` (e.g., `10.5G`)

### Expected Values

- **CPUs:** `limits.cpus` should equal the VPS CPU count from `nproc`
- **Memory:** `limits.memory` should be total VPS memory minus 500M–1GB
  - Vector uses ~128M, system/kernel needs ~500M
  - Formula: `total_memory - 750M` (midpoint) is a good default
  - Acceptable range: `total - 1G` to `total - 500M`

### Action

**If values match** (CPUs equal, memory within the 500M–1G buffer range): Report that resource limits look correct and continue.

**If mismatch detected:** Show the user a comparison:

```
VPS Resources:
  CPUs:   <nproc result>
  Memory: <total from free, human-readable>

Current gateway limits (docker-compose.override.yml):
  CPUs:   <current cpus value>
  Memory: <current memory value>

Recommended gateway limits:
  CPUs:   <nproc result>
  Memory: <total - 750M, rounded to nearest 0.5G>
```

Ask the user if they want to adjust the limits. They may choose:

- Accept the recommended values
- Enter custom values
- Keep the current values (skip)

If the user confirms changes, update `deploy/docker-compose.override.yml` with the new `limits.cpus` and `limits.memory` values. Also update `reservations.cpus` if it exceeds the new limit (reservation cannot exceed limit).

---

## 0.5 Cloudflare Access Verification

Verify the domain is protected by Cloudflare Access before deploying. Run from the local machine:

```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
```

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

```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_DASHBOARD_DOMAIN><OPENCLAW_DASHBOARD_DOMAIN_PATH>/ 2>&1 | head -10
```

Same logic: expect 302/403. If not, guide user to fix.

### Opt-out:

If the user cannot or does not want to set up Cloudflare Access right now, they can
explicitly say so. Warn them:

> "Deploying without Cloudflare Access means the gateway will be publicly accessible
> once the tunnel routes are active. You can add Access protection later, but the
> gateway will be exposed in the meantime."

Only proceed without Access if the user explicitly confirms.

---

## 0.6 Worker Placeholder Detection

Scan `AI_GATEWAY_WORKER_URL` and `LOG_WORKER_URL` for angle-bracket placeholders (e.g., `<account>`).

**If placeholders found:** Note that workers will be deployed via `01-workers.md` before VPS setup begins. The user doesn't need to do anything now — this happens automatically as the first deployment step.

**If no placeholders:** Workers are already configured. Skip `01-workers.md` during deployment.

---

## 0.7 Deployment Overview

Present the full deployment plan to the user:

```
Deployment Plan:
  1. [Parallel]
     a. Deploy Cloudflare Workers (01-workers.md) — local              ~5 min
     b. Base setup & hardening (02-base-setup.md) — VPS               ~10 min
  2. Docker installation (03-docker.md)
  3. OpenClaw deployment (04-vps1-openclaw.md)
  4. Backup configuration (06-backup.md)
  5. Reboot & verification (07-verification.md)
  6. Post-deploy: AI proxy configuration, device pairing & deployment report (08-post-deploy.md)
```

Domain and Cloudflare Access have been verified.

> **Note:** AI proxy provider API keys (e.g., `ANTHROPIC_API_KEY`) are configured during post-deploy (step 6, `08-post-deploy.md` § 8.1), not during worker deployment (step 1). Worker deployment only sets up the infrastructure (`AUTH_TOKEN`).

Ask the user to confirm before proceeding with the deployment.

### Automation directive

After the user confirms, launch **01-workers and 02-base-setup as parallel subagents** (two Task tool calls in a single message). These have no shared dependencies — workers run locally via wrangler while base setup runs on the VPS via SSH. After both subagents return, execute playbooks 03 through 07 **continuously without pausing between steps**. Do not ask for confirmation between playbooks. Only stop if:

- A command fails and the error requires user input to resolve
- A playbook step explicitly says to wait for user input (e.g., a blocking error with multiple resolution paths)
- **SSH verification (02-base-setup.md § 2.4 Step 3):** You MUST test SSH on port `<SSH_HARDENED_PORT>` from the local machine and confirm it works before proceeding. This is a mandatory stop point — do not skip it during automated deployment.
- **07-verification.md:** Run in the main context (not a subagent) so the user sees real-time progress and errors can be handled directly. By this point, all heavy steps have been offloaded to subagents and the context window has room. Report the summary table before proceeding to 08-post-deploy.md.

Normal informational output (progress updates, version notes, check results) should be reported inline without pausing. The first user interaction after confirmation should be device pairing in `08-post-deploy.md`.

### Context window management

A full deployment consumes significant context. To avoid mid-deploy compaction, **offload verbose steps to subagents** using the `Task` tool. Subagents run in their own context window — only their short summary returns to the main conversation.

**Delegate to subagents:** Steps that produce verbose output but only need pass/fail + key values back:

| Step | Why it's heavy | Return values |
|------|---------------|---------------|
| 01: Workers deployment | npm install + wrangler deploy output | Worker URLs, auth tokens, D1 database ID |
| 02: System update + package install | apt output (hundreds of lines) | pass/fail |
| 02: SSH hardening (2.5–2.9) | swap, fail2ban, kernel config output | pass/fail, cloudflared version |
| 03: Docker CE installation | apt + daemon config output | pass/fail, Docker/Compose versions |
| 04: Sysbox + infra (4.1–4.2) | dpkg + network/directory creation + SCP | pass/fail, GATEWAY_TOKEN |
| 04: Deploy configuration (4.3) | deploy-config.sh runs on VPS | pass/fail |
| 04: Build + start (4.4) | Full Docker build log | pass/fail |
| 06: Backup setup | Script creation + cron config | pass/fail, test backup size |

> **Parallel launch:** 01 and 02 subagents should be launched together in a single message (multiple Task tool calls). Both must return their values before step 04 can begin — 04 needs worker URLs/tokens from 01 and requires Docker (step 03, which depends on 02).

**Keep in main context:** Steps that generate credentials stored in `openclaw-config.env` (user creation in 02, gateway token recording in 04 after setup-infra.sh returns it), SSH hardening port transition (02), device pairing (04/08), user-facing interactions (08), **07-verification.md** (all checks — runs after heavy steps are done, gives user real-time progress and direct error handling), and the **sandbox build wait** (04: §4.4 — use background task + progress polling pattern for user feedback, ~100 tokens per poll).

**Critical: avoid reading playbooks before delegating.** Do NOT read a playbook into main context and then pass its contents to a subagent — this doubles the context cost. Instead, tell the subagent to read the playbook section itself:

```
Read playbooks/04-vps1-openclaw.md sections 4.1-4.2 and execute them.
SSH: ssh -i <key> -p <port> <user>@<ip>
Config values (pass as env vars to setup-infra.sh):
  AI_GATEWAY_WORKER_URL=<value>
  AI_GATEWAY_AUTH_TOKEN=<value>
  ...
Return: pass/fail, OPENCLAW_GENERATED_TOKEN from stdout.
```

**Template substitution in subagents:** Sections 4.2 and 4.3 now use standalone scripts (`deploy/scripts/setup-infra.sh` and `deploy/scripts/deploy-config.sh`) that are SCP'd to the VPS and run remotely. Config values are passed as env vars — the subagent just needs the variable values, not the script contents.

**Additional techniques:**
- Batch related SSH commands into single calls (e.g., all file deployments in one SSH session)
- Use `2>&1 | tail -5` for build commands where only the final status matters
- After a subagent completes successfully, its verbose output stays out of main context automatically
- Run independent subagents in parallel when possible (e.g., 06-backup can overlap with sandbox build wait)
