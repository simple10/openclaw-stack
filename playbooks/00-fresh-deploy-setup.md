# 00 - Fresh Deploy Setup

Validation and overview for starting a fresh VPS deployment. All required configuration — including domain and Cloudflare Access — must be in place before deployment begins.

## Overview

This playbook validates the configuration needed to deploy OpenClaw on a fresh Ubuntu VPS. Per-claw domain settings (`claws.<name>.domain`, `defaults.domain_path`, `defaults.dashboard_path` in `stack.yml`) and Cloudflare Access protection are required upfront so the full deployment can run end-to-end without interruption.

## Prerequisites

- A fresh Ubuntu VPS (>= 24.04) with root/sudo access
- An SSH key pair for VPS access
- A Cloudflare account with a domain
- Cloudflare Tunnel token (`CLOUDFLARE_TUNNEL_TOKEN`, manual) OR Cloudflare API token (`CLOUDFLARE_API_TOKEN`, automated)
- Cloudflare Access application protecting the domain

---

## 0.1 Config File Check

Check that `.env` and `stack.yml` exist:

```bash
ls .env stack.yml
```

**If missing:** Offer to create from examples:

```bash
cp .env.example .env && cp stack.yml.example stack.yml
```

Then ask the user to fill in the required values (see section 0.2).

---

## 0.2 Required Config

Run this single validation command to check all required fields at once:

```bash
echo "=== local tools ===" && \
echo "node: $(node --version 2>/dev/null || echo MISSING)" && \
source .env 2>/dev/null && \
echo "=== .env ===" && \
echo "VPS_IP=${VPS_IP:-EMPTY}" && \
echo "CF_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:+SET}" && \
echo "CF_API_TOKEN=${CLOUDFLARE_API_TOKEN:+SET}" && \
echo "ADMIN_TELEGRAM_ID=${ADMIN_TELEGRAM_ID:-EMPTY}" && \
echo "SSH_KEY=${SSH_KEY:-~/.ssh/vps1_openclaw_ed25519}" && \
grep '_TELEGRAM_BOT_TOKEN=' .env | grep -v '^#' && \
echo "=== stack.yml ===" && \
grep '^\s*domain:' stack.yml | head -1 && \
echo "=== claws ===" && \
grep -A1 '^claws:' stack.yml | tail -n +2 | grep '^\s\+[a-z]' | sed 's/://;s/^\s*//'
```

### Validation rules

1. **Local tools** — `node` is required for `npm run pre-deploy` (builds deployment artifacts) and worker deployment (`npm install`, `npx wrangler`). It must show a version, not `MISSING`. Install: [nodejs.org](https://nodejs.org).
2. **`VPS_IP`** — Must not be `EMPTY` or contain `<`.
3. **`CF_TUNNEL_TOKEN`** or **`CF_API_TOKEN`** — At least one must show `SET`. If both missing: "Set `CLOUDFLARE_TUNNEL_TOKEN` (manual — create tunnel in CF Dashboard) or `CLOUDFLARE_API_TOKEN` (automated). See [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md)."
4. **`domain`** — The `stack.yml` domain line must not contain angle brackets (e.g., `<example>`). `${VAR}` references are OK — verify the referenced `.env` variable (e.g., `ROOT_DOMAIN`) is set.
5. **`ADMIN_TELEGRAM_ID`** — Must be numeric. If empty: "Send a message to @userinfobot on Telegram to get your numeric user ID."
6. **Bot tokens** — Each claw name needs a matching `<NAME>_TELEGRAM_BOT_TOKEN` line in `.env` (uppercased, hyphens→underscores). If missing: "Create a Telegram bot via @BotFather and paste the token. See `docs/TELEGRAM.md`."
7. **Claws** — The `claws` section lists claw names. Single claw = standard deploy. Multiple claws: inform user each gets its own container/domain.

### If any fields are invalid or missing

Report **all** issues at once (don't stop at the first one). Wait for user to fix all issues before continuing. Re-validate after they confirm.

---

## 0.2b Automated Tunnel Setup (CF_API_TOKEN)

**Skip this section entirely if `CF_API_TOKEN` is not set.** The manual flow (user already has `CF_TUNNEL_TOKEN`) is unchanged.

When `CF_API_TOKEN` is set, automate tunnel creation, route configuration, and DNS setup:

1. **Verify token permissions:**
   ```bash
   scripts/cf-tunnel-setup.sh verify
   ```
   If verification fails, report the missing permissions and link to the API token creation page.

2. **List existing tunnels:**
   ```bash
   scripts/cf-tunnel-setup.sh list-tunnels
   ```

3. **Prompt user:** Use an existing tunnel or create a new one?
   - If existing: user selects from the list, then fetch the tunnel token:
     ```bash
     scripts/cf-tunnel-setup.sh get-token <tunnel-id>
     ```
   - If new: ask for a tunnel name (default: `openclaw`), then create:
     ```bash
     scripts/cf-tunnel-setup.sh create-tunnel <name>
     ```
     This outputs `TUNNEL_ID=...` and `CF_TUNNEL_TOKEN=...`.

4. **Write `CLOUDFLARE_TUNNEL_TOKEN`** to `.env` (the value from step 3).

5. **Configure routes + DNS:**
   ```bash
   scripts/cf-tunnel-setup.sh setup-routes
   ```
   This reads all instance configs, configures tunnel ingress rules, and creates DNS CNAME records.

6. **Report** what was configured (routes, DNS records created). Remind the user that Cloudflare Access still needs manual setup (see § 0.5).

> **Multi-instance note:** When using `CF_API_TOKEN` with multiple claws, a single Cloudflare Access
> application with a wildcard domain (e.g., `openclaw*.example.com` or `*claw.example.com`) can
> protect all instance subdomains. This must still be configured manually in the CF Dashboard.

---

## 0.3 SSH Check

1. Validate `SSH_KEY` exists on the local system (default: `~/.ssh/vps1_openclaw_ed25519`).
2. Test SSH connectivity using values from `.env` (`SSH_USER`, `SSH_PORT`):

```bash
ssh -i <SSH_KEY> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS_IP> echo "VPS OK"
```

**If SSH fails — diagnose by error type:**

**"Connection refused" or "Connection timed out":**

> "Can't reach the VPS on port <SSH_PORT>. Possible causes:
>
> - The VPS isn't running or hasn't finished booting
> - The IP address is incorrect — double-check `VPS_IP` in `.env`
> - The VPS provider's firewall is blocking SSH — check the provider's dashboard"

**"Host key verification failed" (REMOTE HOST IDENTIFICATION HAS CHANGED):**

> "The SSH host key doesn't match a previously known key for this IP. If you
> reinstalled the VPS or reused the IP from a previous deployment, clear the
> stale entry:"

```bash
ssh-keygen -R <VPS_IP>
```

Then retry the SSH test.

**"Permission denied (publickey)":**

> "SSH key authentication failed. Possible causes:
>
> - The key at `<SSH_KEY>` wasn't added to the VPS during provisioning
> - The key file doesn't exist — check: `ls -la <SSH_KEY>`
> - The SSH agent doesn't have the key loaded — try: `ssh-add <SSH_KEY>`"

---

## 0.4 VPS Resource Check

After SSH is confirmed working, query the VPS hardware to verify gateway container resource limits match the host.

### Query VPS Resources

```bash
ssh -i <SSH_KEY> -p <SSH_PORT> <SSH_USER>@<VPS_IP> "nproc && free -b | awk '/^Mem:/{print \$2}'"
```

This returns two lines: CPU count (e.g., `6`) and total memory in bytes (e.g., `11811160064`).

### Compare Against Config

Read current per-claw resource limits from `stack.yml`: `defaults.resources.cpus` and `defaults.resources.memory`. Check for per-claw overrides under `claws.<name>.resources`.

### Expected Values

`defaults.resources.cpus` and `defaults.resources.memory` are **per-container** limits — each claw gets these resources. With multiple claws, divide the available VPS resources by the number of active claws.

1. Count active claws from § 0.2c (entries under `claws` in `stack.yml`).
2. Calculate system overhead: Vector (~128M) + system/kernel (~500M) = ~750M total.
3. Compute per-claw resources:
   - **CPUs per claw:** `floor(nproc / claw_count)`
   - **Memory per claw:** `floor((total_memory - 750M) / claw_count)`, rounded down to nearest 0.5G

### Action

**If values match** (per-claw CPUs and memory within expected range): Report that resource limits look correct and continue.

**If mismatch detected or not yet set:** Show the user a comparison:

```
VPS Resources:
  CPUs:   <nproc result>
  Memory: <total from free, human-readable>
  Active claws: <count> (<names>)

Current per-claw limits (from stack.yml defaults.resources):
  cpus:   <current value>
  memory: <current value>

Recommended per-claw limits (<count> claws):
  cpus:   <floor(nproc / claw_count)>
  memory: <floor((total - 750M) / claw_count), rounded to 0.5G>
  Total allocated: <cpus * count> CPUs, <memory * count> memory
```

Ask the user if they want to adjust the limits. They may choose:

- Accept the recommended values
- Enter custom values
- Keep the current values (skip)

If the user confirms changes, update `defaults.resources.cpus` and `defaults.resources.memory` in `stack.yml`. Per-claw overrides can be set under `claws.<name>.resources.cpus` and `claws.<name>.resources.memory`.

---

## 0.5 Cloudflare Access Verification

Verify the domain is protected by Cloudflare Access before deploying. Run from the local machine:

```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
```

### If 302/403 redirect (Location header contains `cloudflareaccess.com` or `access.`)

Cloudflare Access is protecting the domain. Continue to next step.

### If 200 (unprotected)

> "Your domain is accessible without Cloudflare Access. Anyone with the URL could
> reach OpenClaw after deployment. Configure Cloudflare Access first — see
> [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3: Create
> Access Application, Define Policy, Configure Identity Provider).
>
> Let me know when you've set it up."

Wait for user to confirm. Re-run the curl check to verify.

### If connection refused, timeout, or DNS error

> "Your domain isn't resolving or the tunnel route isn't configured yet. You need to:
>
> 1. Add public hostname routes in your Cloudflare Tunnel (see
>    [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) Step 4)
> 2. Configure Cloudflare Access (Steps 1-3 in the same doc)
>
> Let me know when you've completed these steps."

Wait for user. Re-check.

> **Multi-instance with CF_API_TOKEN:** When using automated tunnel setup with multiple claws,
> a single Cloudflare Access application with a wildcard domain (e.g., `openclaw*.example.com`)
> can protect all instance subdomains. This must still be configured manually in the CF Dashboard.

### Also verify the dashboard path

The dashboard is served on the same domain as the claw, at the `dashboard_path` (default: `/dashboard`):

```bash
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><DASHBOARD_BASE_PATH>/ 2>&1 | head -10
```

Same logic: expect 302/403. If not, guide user to fix.

### Opt-out

If the user cannot or does not want to set up Cloudflare Access right now, they can
explicitly say so. Warn them:

> "Deploying without Cloudflare Access means the gateway will be publicly accessible
> once the tunnel routes are active. You can add Access protection later, but the
> gateway will be exposed in the meantime."

Only proceed without Access if the user explicitly confirms.

---

## 0.6 Worker Placeholder Detection

Scan `AI_GATEWAY_URL` and `LOG_WORKER_URL` in `.env` for empty or angle-bracket placeholders (e.g., `<account>`).

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
  2. Build + sync deploy artifacts (npm run pre-deploy + sync-deploy.sh --fresh)
     + Seed workspace files: scripts/sync-workspaces.sh up --force
     Note: First sync won't show a deploy diff (git not yet initialized on VPS).
     After setup-infra.sh runs, subsequent syncs show diffs and auto-commit.
  3. Docker + Sysbox (03-docker.md → 03b-sysbox.md)
  4. OpenClaw deployment (04-vps1-openclaw.md)
  5. Backup + cron verification (06-backup.md)
  6. Reboot & verification (07-verification.md)
     + Pull back generated files: scripts/sync-workspaces.sh down --all
  7. Post-deploy: AI proxy (08a) → device pairing (08b) → deployment report (08c)
```

Domain and Cloudflare Access have been verified.

> **Note:** AI proxy provider credentials are configured during post-deploy (step 7, `08a-configure-llm-proxy.md`) via the self-service `/config` UI, not during worker deployment (step 1). Worker deployment sets up the infrastructure (`ADMIN_AUTH_TOKEN`, KV namespace, and the first gateway user).

Ask the user to confirm before proceeding with the deployment.

### Automation directive

After the user confirms, launch **01-workers and 02-base-setup as parallel subagents** (two Task tool calls in a single message). These have no shared dependencies — workers run locally via wrangler while base setup runs on the VPS via SSH. After both subagents return, run `npm run pre-deploy` + `scripts/sync-deploy.sh --fresh` + `scripts/sync-workspaces.sh up --force` in the main context (sync needs the openclaw user from 02 and worker URLs from 01). Then execute playbooks 03, 03b, then 04 through 07 **continuously without pausing between steps**. Do not ask for confirmation between playbooks. Only stop if:

- A command fails and the error requires user input to resolve
- A playbook step explicitly says to wait for user input (e.g., a blocking error with multiple resolution paths)
- **SSH verification (02-base-setup.md § 2.4 Step 3):** You MUST test SSH on port `<SSH_HARDENED_PORT>` from the local machine and confirm it works before proceeding. This is a mandatory stop point — do not skip it during automated deployment.
- **07-verification.md:** Run in the main context (not a subagent) so the user sees real-time progress and errors can be handled directly. By this point, all heavy steps have been offloaded to subagents and the context window has room. Report the summary table, then run `scripts/sync-workspaces.sh down --all` to pull back any files OpenClaw generated on first start, before proceeding to 08a-configure-llm-proxy.md.

Normal informational output (progress updates, version notes, check results) should be reported inline without pausing. The first user interaction after confirmation should be device pairing in `08b-pair-devices.md`.

### Context window management

A full deployment consumes significant context. To avoid mid-deploy compaction, **offload verbose steps to subagents** using the `Task` tool. Subagents run in their own context window — only their short summary returns to the main conversation.

**Delegate to subagents:** Steps that produce verbose output but only need pass/fail + key values back:

| Step | Why it's heavy | Return values | Log file | Scope |
|------|---------------|---------------|----------|-------|
| 01: Workers deployment | npm install + wrangler deploy output | Worker URLs, auth tokens, D1 database ID | `01-workers.md` | Full file |
| 02: System update + package install | apt output (hundreds of lines) | pass/fail | `02-base-setup.md` | Full file |
| 02: System hardening (2.5) | swap, fail2ban, kernel config output | pass/fail | `02-base-setup.md` | Full file |
| 03b: Sysbox runtime | dpkg install + AppArmor check | pass/fail | `03b-sysbox.md` | Full file |
| 04: Infrastructure setup (4.2) | directory creation + clone | pass/fail | `04-infra-config.md` | §4.2 |
| 04: Build + start (4.4) | Full Docker build log | pass/fail | `04-build-start.md` | §4.4 |

> **Scoping:** Tell subagents which sections to read (e.g., "Read §4.2 of playbooks/04-vps1-openclaw.md"). This prevents subagents from loading troubleshooting, updating, and verification sections they don't need.

> **Parallel launch:** 01 and 02 subagents should be launched together in a single message (multiple Task tool calls). Both must return their values before step 04 can begin — 04 needs worker URLs/tokens from 01 and requires Docker (step 03, which depends on 02).

**Keep in main context:** Steps that generate credentials (user creation in 02), SSH hardening port transition (02), **03-docker.md** (short — use `2>&1 | tail -5` for apt output), device pairing (04/08), **06-backup.md** (short — uses `SOURCE:` pattern, no verbose output), user-facing interactions (08), **07-verification.md** (all checks — runs after heavy steps are done, gives user real-time progress and direct error handling), and the **sandbox build wait** (04: §4.4 — use background task + progress polling pattern for user feedback, ~100 tokens per poll).

**Critical: avoid reading playbooks before delegating.** Do NOT read a playbook into main context and then pass its contents to a subagent — this doubles the context cost. Instead, tell the subagent to read the playbook section itself:

```
Read playbooks/04-vps1-openclaw.md §4.2 and execute the infrastructure setup.
SSH: ssh -i <key> -p <port> <user>@<ip>
Log: Write detailed execution log (all commands, full output, errors, recovery steps)
  to .deploy-logs/<timestamp>/04-infra-config.md
Return: pass/fail.
```

**Deployment in subagents:** `npm run pre-deploy` builds all deployment artifacts locally into `.deploy/`. The `.deploy/` directory is then pushed to the VPS. Config values are resolved at build time — the subagent just needs SSH access and the pre-built artifacts.

**Deploy logs:** At the start of deployment (before launching subagents), create `.deploy-logs/YYYYMMDD-HHMMSS/`. The `.deploy-logs/` directory is gitignored. At the end of deployment, tell the user where the logs are.

*Subagent steps:* Every subagent prompt **must** include a `Log:` line with the file path (see template above). The subagent writes its full execution log there before returning a short summary. Log file names are in the "Log file" column of the delegation table.

*Main-context steps:* After completing each main-context playbook step, append a log file to the same directory. Record all commands run, their output, and any errors or recovery steps. Main-context log files:

| Step | Log file |
|------|----------|
| 03: Docker installation | `03-docker.md` |
| 06: Backup configuration | `06-backup.md` |
| 07: Verification | `07-verification.md` |
| 08: Post-deploy report | `08-deploy-report.md` |

**Additional techniques:**

- Batch related SSH commands into single calls (e.g., all file deployments in one SSH session)
- Use `2>&1 | tail -5` for build commands where only the final status matters
- After a subagent completes successfully, its verbose output stays out of main context automatically
- Run independent subagents in parallel when possible (e.g., 06-backup can overlap with sandbox build wait)
