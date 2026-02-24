# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:

- Sysbox runtime for secure container-in-container
- Docker networks for OpenClaw
- Directory structure and permissions
- OpenClaw repository and configuration
- Docker Compose with security hardening
- Vector for log shipping to Cloudflare
- Host alerter for Telegram notifications
- Maintenance checker for OS update monitoring

## Prerequisites

- [02-base-setup.md](02-base-setup.md) completed on VPS-1
- [03-docker.md](03-docker.md) completed on VPS-1
- SSH access as `adminclaw` on port `<SSH_PORT>`

## Variables

From `../openclaw-config.env`:

- `VPS1_IP` - Required, public IP of VPS-1
- `AI_GATEWAY_WORKER_URL` - Required, AI Gateway Worker URL
- `AI_GATEWAY_AUTH_TOKEN` - Required, AI Gateway auth token
- `LOG_WORKER_URL` - Optional, Log Receiver Worker URL (for Vector log shipping)
- `LOG_WORKER_TOKEN` - Optional, Log Receiver auth token (for Vector log shipping)
- `YOUR_TELEGRAM_ID` - Required, numeric Telegram user ID (for `tools.elevated` access gating)
- `OPENCLAW_TELEGRAM_BOT_TOKEN` - Required, Telegram bot token for OpenClaw channel (see `docs/TELEGRAM.md`)
- `HOSTALERT_TELEGRAM_BOT_TOKEN` - Optional (for host alerter; can reuse `OPENCLAW_TELEGRAM_BOT_TOKEN`)
- `HOSTALERT_TELEGRAM_CHAT_ID` - Optional (for host alerter)
- `HOSTALERT_DAILY_REPORT_TIME` - Optional, daily health report time (default: `9:30 AM PST`)
- `OPENCLAW_DOMAIN_PATH` - URL subpath for the gateway UI (default: `/_openclaw`)
- `OPENCLAW_DASHBOARD_DOMAIN_PATH` - Base path for the dashboard server (e.g., `/dashboard`), empty if using a separate subdomain

---

## 4.1 Install Sysbox Runtime

Sysbox enables running Docker-in-Docker securely for OpenClaw sandboxes.

### Version check (fresh deployments only)

Before installing, fetch the latest release from GitHub:

```
https://github.com/nestybox/sysbox/releases
```

Compare the latest release tag against `SYSBOX_VERSION` below.

- **If a newer version exists:** Note the newer version in the output but proceed with the pinned version. Do not pause to ask — the pinned version has a verified checksum. The user can update later.
- **If the pinned version is already the latest:** Proceed directly.

<!-- Pinned version — update both values together -->
`SYSBOX_VERSION=0.6.7`
`SYSBOX_SHA256=b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e`

### Install

```bash
#!/bin/bash
SYSBOX_VERSION="0.6.7"
SYSBOX_SHA256="b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e"
SYSBOX_DEB="sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"

# Download
wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"

# Verify download integrity
echo "${SYSBOX_SHA256}  ${SYSBOX_DEB}" | sha256sum -c -

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i "${SYSBOX_DEB}"

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
sudo docker info | grep -i "sysbox"

# Cleanup
rm "${SYSBOX_DEB}"
```

**If sha256sum fails:**

> "The Sysbox download didn't match the expected checksum. This could mean a
> corrupted download or a version mismatch. Delete the file and re-download:"
>
> `rm ${SYSBOX_DEB} && wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"`

**If `dpkg -i` fails with dependency errors:**

> "Sysbox has unmet dependencies. Fix with:"
>
> `sudo apt --fix-broken install -y`

### AppArmor fusermount3 compatibility

Ubuntu 25.04+ ships a `fusermount3` AppArmor profile in enforce mode that blocks sysbox-fs from creating FUSE mounts (used for container `/proc` and `/sys` virtualization). This causes containers to fail with `rpc error: code = DeadlineExceeded` during sysbox pre-registration.

**Only needed when the profile is loaded and enforcing.** Run this check after installing Sysbox:

```bash
#!/bin/bash
# Check if fusermount3 AppArmor profile is blocking sysbox-fs
if sudo aa-status 2>/dev/null | grep -q 'fusermount3'; then
  echo "fusermount3 AppArmor profile is enforcing — disabling for sysbox-fs compatibility"

  # Disable the profile (persists across reboots)
  sudo ln -sf /etc/apparmor.d/fusermount3 /etc/apparmor.d/disable/
  sudo apparmor_parser -R /etc/apparmor.d/fusermount3 2>/dev/null || true

  # Restart sysbox services to pick up the change
  sudo systemctl restart sysbox-fs sysbox-mgr sysbox

  echo "fusermount3 profile disabled, sysbox restarted"
else
  echo "fusermount3 AppArmor profile not enforcing — no action needed"
fi
```

**Security note:** The fusermount3 profile restricts which processes can invoke FUSE mounts. Sysbox legitimately needs FUSE for filesystem virtualization. On a single-purpose VPS with key-only SSH + Cloudflare Access, disabling this profile has negligible security impact. This is not needed on Ubuntu 24.04 where the profile is absent or in complain mode.

---

## 4.2 Infrastructure Setup

> **SCP + single script.** Copies `deploy/` to VPS staging, then runs `setup-infra.sh` which creates networks, directories, clones the repo, and generates the `.env` file. Returns the generated `GATEWAY_TOKEN` which must be saved locally before proceeding.

### Step 1: SCP deploy directory to VPS

**Run from LOCAL machine:**

```bash
# Create staging directory on VPS
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} "mkdir -p /tmp/deploy-staging"

# Bulk-copy entire deploy/ directory (includes scripts/, used by both 4.2 and 4.3)
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r deploy/* ${SSH_USER}@${VPS1_IP}:/tmp/deploy-staging/
```

### Step 2: Run setup-infra.sh

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env \
    AI_GATEWAY_WORKER_URL='${AI_GATEWAY_WORKER_URL}' \
    AI_GATEWAY_AUTH_TOKEN='${AI_GATEWAY_AUTH_TOKEN}' \
    OPENCLAW_TELEGRAM_BOT_TOKEN='${OPENCLAW_TELEGRAM_BOT_TOKEN}' \
    HOSTALERT_TELEGRAM_BOT_TOKEN='${HOSTALERT_TELEGRAM_BOT_TOKEN}' \
    HOSTALERT_TELEGRAM_CHAT_ID='${HOSTALERT_TELEGRAM_CHAT_ID}' \
    OPENCLAW_DASHBOARD_DOMAIN_PATH='${OPENCLAW_DASHBOARD_DOMAIN_PATH}' \
    OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
    GATEWAY_CPUS='${GATEWAY_CPUS}' \
    GATEWAY_MEMORY='${GATEWAY_MEMORY}' \
  bash /tmp/deploy-staging/scripts/setup-infra.sh"
```

Capture the `OPENCLAW_GENERATED_TOKEN=<hex>` line from stdout (all other output goes to stderr).

**If git clone fails with "fatal: unable to access":**

> "Can't reach GitHub from the VPS. Check network connectivity:"
>
> `curl -sI https://github.com` — if this times out, the VPS may have
> DNS or outbound connectivity issues.

**If git clone fails with "already exists and is not an empty directory":**

> "The openclaw directory already exists. This VPS may have a previous
> installation. Use `00-analysis-mode.md` to analyze it first, or
> remove it to start fresh:"
>
> `sudo rm -rf /home/openclaw/openclaw`

**Record gateway token locally:** Immediately after the script runs, use the `Edit` tool to update the `GATEWAY_TOKEN` and `GATEWAY_URL` values in the `# DEPLOYED:` section of `openclaw-config.env`. Replace the existing `# DEPLOYED: GATEWAY_TOKEN=` and `# DEPLOYED: GATEWAY_URL=` lines with the generated token and composed URL (`https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat?token=<TOKEN>`). Do NOT use `sed` — it creates backup files on macOS.

> These are comments — `source openclaw-config.env` won't export them. They're a safety net in case the session ends before the deployment report (§ 8.5).

---

## 4.3 Deploy Configuration

> **Single script.** Runs `deploy-config.sh` from the staging directory (already on VPS from §4.2 step 1). Copies all files into place, substitutes template variables, sets permissions, creates crons, and deploys plugins. The staging directory is cleaned up at the end.

### File manifest

| Source | Destination | Type | Notes |
|--------|------------|------|-------|
| `deploy/docker-compose.override.yml` | `/home/openclaw/openclaw/docker-compose.override.yml` | static | Security hardening + monitoring |
| `deploy/vector/docker-compose.yml` | `/home/openclaw/vector/docker-compose.yml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `deploy/vector/vector.yaml` | `/home/openclaw/vector/vector.yaml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `deploy/openclaw.json` | `/home/openclaw/.openclaw/openclaw.json` | template | See template variables below |
| `deploy/models.json` | `/home/openclaw/.openclaw/agents/*/agent/models.json` | template | Deployed per-agent (main, code, skills) |
| `deploy/build-openclaw.sh` | `/home/openclaw/scripts/build-openclaw.sh` | static | |
| `deploy/entrypoint-gateway.sh` | `/home/openclaw/openclaw/scripts/entrypoint-gateway.sh` | static | |
| `deploy/host-alert.sh` | `/home/openclaw/scripts/host-alert.sh` | static | |
| `deploy/host-maintenance-check.sh` | `/home/openclaw/scripts/host-maintenance-check.sh` | static | |
| `deploy/logrotate-openclaw` | `/etc/logrotate.d/openclaw` | static | |
| `deploy/plugins/*` | `/home/openclaw/openclaw/deploy/plugins/` | static | Owned by uid 1000 |
| `deploy/sandbox-toolkit.yaml` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/parse-toolkit.mjs` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/rebuild-sandboxes.sh` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/dashboard/*` | `/home/openclaw/openclaw/deploy/dashboard/` | static | Bind-mounted into container |

### Template variables

These are substituted server-side via `sed` after copying from staging:

| Variable | Source | Used in |
|----------|--------|---------|
| `GATEWAY_TOKEN` | Read from `.env` on VPS | `openclaw.json` |
| `OPENCLAW_DOMAIN_PATH` | `openclaw-config.env` | `openclaw.json` |
| `YOUR_TELEGRAM_ID` | `openclaw-config.env` | `openclaw.json` |
| `OPENCLAW_INSTANCE_ID` | `openclaw-config.env` | `openclaw.json` |
| `VPS_HOSTNAME` | `openclaw-config.env` | `openclaw.json` |
| `ENABLE_EVENTS_LOGGING` | `openclaw-config.env` | `openclaw.json` |
| `ENABLE_LLEMTRY_LOGGING` | `openclaw-config.env` | `openclaw.json` |
| `EVENTS_URL` | Derived: `LOG_WORKER_URL` with `/logs` → `/events` | `openclaw.json` |
| `LLEMTRY_URL` | Derived: `LOG_WORKER_URL` with `/logs` → `/llemtry` | `openclaw.json` |
| `LOG_WORKER_TOKEN` | `openclaw-config.env` | `openclaw.json` |
| `AI_GATEWAY_WORKER_URL` | `openclaw-config.env` | `models.json` |

### Step 1: Query server timezone

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} "timedatectl show -p Timezone --value"
```

Use the returned timezone to compute `CRON_MINUTE`, `CRON_HOUR`, `CRON_MAINTENANCE_MINUTE`, and `CRON_MAINTENANCE_HOUR` from `HOSTALERT_DAILY_REPORT_TIME` (see cron generation rules below).

### Step 2: Run deploy-config.sh

> **Important:** `OPENCLAW_DOMAIN_PATH` may be empty (serves UI at root). The script handles empty values correctly. ALL `{{VAR}}` placeholders are substituted by the script — it exits with error if any remain.

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env \
    OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
    YOUR_TELEGRAM_ID='${YOUR_TELEGRAM_ID}' \
    OPENCLAW_INSTANCE_ID='${OPENCLAW_INSTANCE_ID}' \
    VPS_HOSTNAME='${VPS_HOSTNAME}' \
    ENABLE_EVENTS_LOGGING='${ENABLE_EVENTS_LOGGING}' \
    ENABLE_LLEMTRY_LOGGING='${ENABLE_LLEMTRY_LOGGING}' \
    LOG_WORKER_TOKEN='${LOG_WORKER_TOKEN}' \
    LOG_WORKER_URL='${LOG_WORKER_URL}' \
    AI_GATEWAY_WORKER_URL='${AI_GATEWAY_WORKER_URL}' \
    ENABLE_VECTOR_LOG_SHIPPING='${ENABLE_VECTOR_LOG_SHIPPING}' \
    VPS1_IP='${VPS1_IP}' \
    CRON_MINUTE='${CRON_MINUTE}' \
    CRON_HOUR='${CRON_HOUR}' \
    CRON_MAINTENANCE_MINUTE='${CRON_MAINTENANCE_MINUTE}' \
    CRON_MAINTENANCE_HOUR='${CRON_MAINTENANCE_HOUR}' \
    HOSTALERT_TELEGRAM_BOT_TOKEN='${HOSTALERT_TELEGRAM_BOT_TOKEN}' \
    HOSTALERT_TELEGRAM_CHAT_ID='${HOSTALERT_TELEGRAM_CHAT_ID}' \
  bash /tmp/deploy-staging/scripts/deploy-config.sh"
```

Expect `DEPLOY_CONFIG_OK` on stdout when successful. All progress output goes to stderr.

**Cron generation rules:**

- **Cron runs in the server's local timezone**, not necessarily UTC. Before converting `HOSTALERT_DAILY_REPORT_TIME` to cron fields, check the server timezone: `timedatectl show -p Timezone --value` (or `cat /etc/timezone` as fallback). Convert the user's specified time to the server's local timezone, then write the cron minute/hour fields in that timezone. Include the server timezone and original user time in the cron comment for clarity.
- If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to `9:30 AM PST` — still convert to the server's local timezone.
- Only include the daily report cron line (`--report`) if both `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` are set in `openclaw-config.env`. If Telegram is not configured, write only the alerter line (the script exits silently without Telegram credentials, but there's no point scheduling the report).

**Maintenance cron generation rules:**

- Schedule 30 minutes before the daily report time. If the daily report runs at `9:00 AM`, the maintenance checker runs at `8:30 AM` (same timezone conversion rules as the report cron).
- If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to 30 minutes before `9:00 AM UTC` (i.e., `8:30 AM UTC`).
- The maintenance cron **always** runs, even without Telegram — OpenClaw agents read the JSON independently.

**Current plugins:**

- **coordinator** — auto-discovers agent skills from `agents.list[].skills` arrays in `openclaw.json`, writes a routing table to `AGENTS.md` in the workspace, and injects delegation instructions into agent system prompts via `before_agent_start` hook.
- **telemetry** — unified event shipping to the Log Receiver Worker (LLM spans, session events, tool usage). Configured via `plugins.entries.telemetry.config` in `openclaw.json`.

To add a new skill to an agent, add it to the agent's `skills` array in `openclaw.json` under `agents.list[]`. The coordinator plugin reads these automatically and updates the routing table — no plugin config changes needed. Restart the gateway after updating `openclaw.json`.

---

## 4.4 Build, Start, and Verify

```bash
#!/bin/bash
# Build image with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Start gateway
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# Start Vector (separate compose project — skip if disabled)
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
fi

# Check status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 20 openclaw-main-claw
```

**If build fails:**

> "The Docker image build failed. Common causes:"
>
> - **Disk space:** `df -h` — need at least 10GB free
> - **Network:** build downloads npm packages — check `curl -sI https://registry.npmjs.org`
> - **Patch conflict:** the build script patches the Dockerfile — if upstream changed
>   significantly, the patch may fail. Check the build script output for "FAILED" messages.

**If `docker compose up -d` fails:**

> "Container failed to start. Check the error with:"
>
> `sudo docker logs openclaw-main-claw`
>
> Common issues:
>
> - **Port already in use:** another process on port 18789 — `sudo ss -tlnp | grep 18789`
> - **Sysbox not available:** `sudo systemctl status sysbox` — must be active
> - **Invalid .env:** missing required variables — `cat /home/openclaw/openclaw/.env`

### Wait for full startup

On first boot, the entrypoint builds 3 sandbox images inside nested Docker (~15-25 min).
The gateway HTTP endpoint responds during this time, but WebSocket connections (needed for
device pairing) fail until the entrypoint finishes and drops to the node user.

**Wait for the entrypoint to complete with progress feedback:**

Use a background task + polling pattern to give the user visual feedback without flooding the context window:

1. **Start the wait in the background** using the Bash tool with `run_in_background: true`:

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds — looks for privilege drop message
timeout 900 bash -c 'until sudo docker logs openclaw-main-claw 2>&1 | grep -q "Executing as node"; do sleep 10; done'
# Then wait for gateway health endpoint
timeout 120 bash -c 'until curl -sf http://localhost:18789<OPENCLAW_DOMAIN_PATH>/ > /dev/null 2>&1; do sleep 3; done'
echo "READY"
```

2. **Poll for progress every 30 seconds** from the main context. Each poll is a lightweight SSH command:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker logs openclaw-main-claw 2>&1 | grep '\[entrypoint\]' | tail -1"
```

Print the result as a status update to the user (e.g., `[entrypoint] Building toolkit sandbox image...`). Continue polling until the background task completes.

3. **Check background task completion** between polls using `TaskOutput` with `block: false`. When the background task returns `READY`, proceed to the next step.

> **Note:** Check for the "Executing as node" log line, not the health endpoint — health responds before sandbox builds complete.

### Fix .openclaw ownership

The gateway creates subdirectories (`identity/`, `devices/`) during startup as root
(before gosu drops to node). Fix ownership so the container can write to them:

```bash
sudo docker exec openclaw-main-claw chown -R 1000:1000 /home/node/.openclaw
```

### Verify CLI access

The `openclaw` host wrapper and `docker exec` commands bypass WebSocket device pairing —
they execute directly inside the container, so no CLI pairing step is needed.

```bash
sudo /usr/local/bin/openclaw devices list
```

**Expected:** Command runs without pairing errors. On a fresh gateway with no browser
connections yet, the output will show an empty device list — that's normal.

### Sandbox Image Verification

Run after gateway startup to verify all sandbox images were built correctly. With the persistent `/var/lib/docker` bind mount, images survive restarts — the entrypoint only rebuilds missing images. On first boot, wait for logs to show build completion before checking.

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds (look for privilege drop message)
echo "Waiting for entrypoint to finish..."
timeout 600 bash -c 'until sudo docker logs openclaw-main-claw 2>&1 | grep -q "Executing as node"; do sleep 5; done'

echo "=== Checking sandbox images ==="
FAILED=0

# 1. Check all 3 images exist (tools are in toolkit image via sandbox-toolkit.yaml)
for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-toolkit:bookworm-slim \
           openclaw-sandbox-browser:bookworm-slim; do
  if sudo docker exec openclaw-main-claw docker image inspect "$img" > /dev/null 2>&1; then
    echo "  $img: EXISTS"
  else
    echo "  $img: MISSING"
    FAILED=1
  fi
done

# 2. Security check: verify USER is 1000 (not root) on toolkit image
for img in openclaw-sandbox-toolkit:bookworm-slim; do
  USER=$(sudo docker exec openclaw-main-claw docker image inspect "$img" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null)
  if [ "$USER" = "1000" ]; then
    echo "  $img USER: 1000 (OK)"
  else
    echo "  $img USER: $USER (EXPECTED 1000)"
    FAILED=1
  fi
done

# 3. Test key binaries in toolkit sandbox (all tools from sandbox-toolkit.yaml)
for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert claude gifgrep; do
  if sudo docker exec openclaw-main-claw docker run --rm openclaw-sandbox-toolkit:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  toolkit/$bin: OK"
  else
    echo "  toolkit/$bin: MISSING"
    FAILED=1
  fi
done

# 5. Check no intermediate images left
if sudo docker exec openclaw-main-claw docker images | grep -q base-root; then
  echo "  WARNING: intermediate base-root image not cleaned up"
fi

# 6. Check image age (staleness)
echo ""
echo "=== Image age ==="
for img in openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
  BUILD_DATE=$(sudo docker exec openclaw-main-claw docker image inspect "$img" \
    --format '{{index .Config.Labels "openclaw.build-date"}}' 2>/dev/null)
  if [ -n "$BUILD_DATE" ] && [ "$BUILD_DATE" != "<no value>" ]; then
    AGE_DAYS=$(( ( $(date +%s) - $(date -d "$BUILD_DATE" +%s 2>/dev/null || echo 0) ) / 86400 ))
    if [ "$AGE_DAYS" -gt 30 ]; then
      echo "  $img: ${AGE_DAYS} days old — consider running scripts/update-sandboxes.sh"
    else
      echo "  $img: ${AGE_DAYS} days old (OK)"
    fi
  else
    echo "  $img: no build-date label (pre-label image)"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "SANDBOX VERIFICATION FAILED — check entrypoint logs:"
  echo "  sudo docker logs openclaw-main-claw 2>&1 | grep '\\[entrypoint\\]'"
fi
```

**Expected:** All 3 images exist (base, toolkit, browser), USER is 1000 on toolkit, all binaries present including custom tools from `sandbox-toolkit.yaml` (claude, gifgrep). Images should have `openclaw.build-date` labels and be less than 30 days old. If verification fails, check entrypoint logs for ERROR messages.

> **Next:** Proceed to section 4.5 to register OpenClaw cron jobs. The gateway must be running first — `openclaw cron add` communicates with the gateway scheduler.

---

## 4.5 Deploy OpenClaw Cron Jobs

After the gateway is running and healthy, register the cron jobs defined in `deploy/openclaw-crons.jsonc`.

### Automated Registration

Run the registration script on the VPS (it was copied during the `scp` in section 4.2 Step 1):

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env HOSTALERT_TELEGRAM_CHAT_ID='${HOSTALERT_TELEGRAM_CHAT_ID}' \
  bash /tmp/deploy-staging/scripts/register-cron-jobs.sh"
```

The script is idempotent — it skips registration if the job already exists.

### Manual Registration (alternative)

### Daily VPS Health Check

This job runs the main agent daily to read the health and maintenance JSON files written by the host cron scripts (§4.3). If everything is healthy, the agent responds with `HEARTBEAT_OK` and no notification is sent. If issues are found, the agent sends a concise alert.

```bash
#!/bin/bash
# SOURCE: deploy/openclaw-crons.jsonc — "Daily VPS Health Check"
# Schedule uses HOSTALERT_DAILY_REPORT_TIME converted to cron format in the configured timezone.
# Default: 30 9 * * * America/Los_Angeles (9:30 AM PST)

# Read the message from the reference file
# The message is a multi-line string — pass it via --message flag
openclaw cron add \
  --name "Daily VPS Health Check" \
  --cron "<CRON_EXPR>" \
  --tz "<CRON_TZ>" \
  --session isolated \
  --wake next-heartbeat \
  --agent main \
  --announce \
  --best-effort-deliver \
  <DELIVERY_FLAGS> \
  --message "Read the VPS health report files and analyze them:

1. Read host-status/health.json (resource metrics)
2. Read host-status/maintenance.json (OS maintenance)

Analyze for issues that need human attention:

Health (health.json):
- disk_pct approaching or exceeding disk_threshold
- memory_pct approaching or exceeding memory_threshold
- load_avg significantly above cpu_count
- docker_ok or gateway_ok is false
- crashed is non-empty (containers restarting)
- backup_ok is false or backup_age_hours > 36
- timestamp older than 30 minutes (monitoring may be broken)

Maintenance (maintenance.json):
- security_updates > 0 (pending security patches)
- reboot_required is true
- failed_services is not \"none\"
- uptime_days > 90 (consider scheduled reboot)
- timestamp older than 26 hours (checker may not be running)

If everything looks healthy, respond with exactly: HEARTBEAT_OK

If any issues are found, send a concise alert with:
- What's wrong (use emoji indicators: 🔴 critical, ⚠️ warning)
- Why it matters (one line per issue)
- Recommended action
Keep it brief — this goes to Telegram."
```

**Placeholder rules:**

- `<CRON_EXPR>` — cron expression derived from `HOSTALERT_DAILY_REPORT_TIME`. Same conversion rules as §4.3. Default: `30 9 * * *`.
- `<CRON_TZ>` — IANA timezone for the cron expression. Derive from the timezone specified in `HOSTALERT_DAILY_REPORT_TIME` (e.g., "PST" → `America/Los_Angeles`). Default: `America/Los_Angeles`.
- `<DELIVERY_FLAGS>` — conditional based on Telegram configuration:
  - **If `HOSTALERT_TELEGRAM_CHAT_ID` is set:** `--channel telegram --to <HOSTALERT_TELEGRAM_CHAT_ID>`
  - **If not set:** omit both `--channel` and `--to`. The CLI defaults to `channel: "last"` (delivers to wherever the user last interacted).

**Verify:**

```bash
openclaw cron list
```

**Expected:** Shows "Daily VPS Health Check" with status `ok` and the correct schedule.

---

## Verification

```bash
# Check containers are running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'

# Check gateway logs
sudo docker logs --tail 50 openclaw-main-claw

# Test internal endpoint (must include basePath if controlUi.basePath is set)
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/ | head -5

# Check Vector is running (separate compose project)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose ps'

# Check Vector logs
sudo docker logs --tail 10 vector
```

---

## Troubleshooting

### Sysbox Not Found

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Reinstall if needed
sudo dpkg -i sysbox-ce_*.deb
```

### Container Won't Start

```bash
# Check logs for config errors
sudo docker logs openclaw-main-claw

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Permission Denied on .openclaw

The gateway creates subdirectories (`identity/`, `devices/`, `memory/`) during startup
as root (before gosu drops to node). The entrypoint's ownership fix (1d) runs before
these dirs exist, so they end up root-owned.

```bash
# Fix ownership on host
sudo chown -R 1000:1000 /home/openclaw/.openclaw

# Or fix inside the container
sudo docker exec openclaw-main-claw chown -R 1000:1000 /home/node/.openclaw
```

### Vector Not Shipping Logs

```bash
# Check Vector logs for config errors
sudo docker logs vector 2>&1 | head -20

# Verify vector.yaml is mounted correctly
sudo docker exec vector ls -la /etc/vector/

# Test the Worker endpoint is reachable from within the container
sudo docker exec vector wget -q -O- <LOG_WORKER_URL_WITHOUT_PATH>/health

# Restart Vector after fixing (use `up -d` instead if .env values changed)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose restart'
```

### CLI Commands Failing

The `openclaw` host wrapper uses `docker exec`, which bypasses WebSocket device pairing.
If CLI commands fail, check:

1. The gateway container is running: `sudo docker ps | grep openclaw-main-claw`
2. The `.openclaw` directory has correct ownership: `sudo docker exec openclaw-main-claw chown -R 1000:1000 /home/node/.openclaw`

### Network Issues

```bash
# Verify network exists
docker network ls | grep openclaw

# Recreate if needed
docker network rm openclaw-gateway-net
docker network create --driver bridge --subnet 172.30.0.0/24 openclaw-gateway-net
```

---

## Updating OpenClaw

The `openclaw update` CLI command does **not** work inside Docker — the `.git` directory is excluded by `.dockerignore`, so the update tool reports `not-git-install`. Instead, update by rebuilding from the host git repo using the build script.

The build script auto-patches the Dockerfile and restores the git working tree after building, so `git pull` always works cleanly.

```bash
#!/bin/bash
# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git tag -f pre-update'
docker tag openclaw:local "openclaw:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git pull origin main'
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 5. Verify new version
openclaw --version
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-' | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "openclaw:rollback-$(date +%Y%m%d)" openclaw:local

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 4. Verify
openclaw --version
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/
```

> If the rollback date tag doesn't match today, list available rollback images with:
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-'`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
- See [REQUIREMENTS.md § 3.1](../REQUIREMENTS.md#31-gateway-container) for gateway container rationale
