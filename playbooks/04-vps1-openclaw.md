# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:

- Docker networks for OpenClaw
- Directory structure and permissions
- OpenClaw repository and configuration
- Docker Compose with security hardening
- Vector for log shipping to Cloudflare
- Host alerter for Telegram notifications
- Maintenance checker for OS update monitoring

## Prerequisites

- [03-docker.md](03-docker.md) completed on VPS-1
- [03b-sysbox.md](03b-sysbox.md) completed on VPS-1
- SSH access as `adminclaw` on port `<SSH_PORT>`

## Variables

From `../openclaw-config.env`:

- `INSTALL_DIR` - Base installation directory on VPS (default: `/home/openclaw`)
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

## 4.2 Infrastructure Setup

> **SCP + single script.** Copies `deploy/` to VPS staging, then runs `setup-infra.sh` which creates networks, directories, clones the repo, and generates the `.env` file. Returns the generated `GATEWAY_TOKEN` which must be saved locally before proceeding.

### Step 1: SCP deploy directory to VPS

**Run from LOCAL machine:**

```bash
# Create staging directory on VPS (under INSTALL_DIR, not world-writable /tmp)
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} "sudo mkdir -p ${INSTALL_DIR}/.deploy-staging && sudo chown ${SSH_USER}:${SSH_USER} ${INSTALL_DIR}/.deploy-staging"

# Bulk-copy entire deploy/ directory (includes scripts/, used by both 4.2 and 4.3)
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r deploy/* ${SSH_USER}@${VPS1_IP}:${INSTALL_DIR}/.deploy-staging/

# Copy claw configurations (openclaws/ is at repo root, separate from deploy/)
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r openclaws ${SSH_USER}@${VPS1_IP}:${INSTALL_DIR}/.deploy-staging/openclaws

# Also copy openclaw-config.env (needed by openclaw-multi.sh generate in §4.3 Step 3)
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} openclaw-config.env ${SSH_USER}@${VPS1_IP}:/tmp/openclaw-config.env
```

### Step 2: Run setup-infra.sh

Discover claw names from `openclaws/` (exclude `_`-prefixed template dirs):

```bash
# Discover claw instance names from local repo
INSTANCE_NAMES=$(ls -d openclaws/*/ 2>/dev/null | xargs -I{} basename {} | grep -v '^_' | tr '\n' ' ')
INSTANCE_NAMES="${INSTANCE_NAMES:-main-claw}"
echo "Instances: $INSTANCE_NAMES"
```

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env \
    INSTALL_DIR='${INSTALL_DIR}' \
    INSTANCE_NAMES='${INSTANCE_NAMES}' \
    AI_GATEWAY_WORKER_URL='${AI_GATEWAY_WORKER_URL}' \
    AI_GATEWAY_AUTH_TOKEN='${AI_GATEWAY_AUTH_TOKEN}' \
    OPENCLAW_TELEGRAM_BOT_TOKEN='${OPENCLAW_TELEGRAM_BOT_TOKEN}' \
    HOSTALERT_TELEGRAM_BOT_TOKEN='${HOSTALERT_TELEGRAM_BOT_TOKEN}' \
    HOSTALERT_TELEGRAM_CHAT_ID='${HOSTALERT_TELEGRAM_CHAT_ID}' \
    OPENCLAW_DASHBOARD_DOMAIN_PATH='${OPENCLAW_DASHBOARD_DOMAIN_PATH}' \
    OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
    GATEWAY_CPUS='${GATEWAY_CPUS}' \
    GATEWAY_MEMORY='${GATEWAY_MEMORY}' \
  bash ${INSTALL_DIR}/.deploy-staging/scripts/setup-infra.sh"
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
> `sudo rm -rf <INSTALL_DIR>/openclaw`

**Record gateway token locally:** Immediately after the script runs, use the `Edit` tool to update the `GATEWAY_TOKEN` and `GATEWAY_URL` values in the `# DEPLOYED:` section of `openclaw-config.env`. Replace the existing `# DEPLOYED: GATEWAY_TOKEN=` and `# DEPLOYED: GATEWAY_URL=` lines with the generated token and composed URL (`https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat?token=<TOKEN>`). Do NOT use `sed` — it creates backup files on macOS.

> These are comments — `source openclaw-config.env` won't export them. They're a safety net in case the session ends before the deployment report (`08c-deploy-report.md`).

---

## 4.3 Deploy Configuration

> **Single script.** Runs `deploy-config.sh` from the staging directory (already on VPS from §4.2 step 1). Copies all files into place, substitutes template variables, sets permissions, creates crons, and deploys plugins. The staging directory is cleaned up at the end.

### File manifest

| Source | Destination | Type | Notes |
|--------|------------|------|-------|
| (generated by `openclaw-multi.sh`) | `<INSTALL_DIR>/openclaw/docker-compose.override.yml` | generated | Per-claw service definitions |
| `deploy/vector/docker-compose.yml` | `<INSTALL_DIR>/vector/docker-compose.yml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `deploy/vector/vector.yaml` | `<INSTALL_DIR>/vector/vector.yaml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `openclaws/_defaults/openclaw.json` | `<INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json` | template | Per-claw (overlaid with claw-specific overrides if present) |
| `openclaws/_defaults/models.json` | `<INSTALL_DIR>/instances/<name>/.openclaw/agents/*/agent/models.json` | template | Per-claw, per-agent (main, code, skills) |
| `deploy/build-openclaw.sh` | `<INSTALL_DIR>/scripts/build-openclaw.sh` | static | |
| `deploy/entrypoint-gateway.sh` | `<INSTALL_DIR>/openclaw/scripts/entrypoint-gateway.sh` | static | |
| `deploy/host-alert.sh` | `<INSTALL_DIR>/scripts/host-alert.sh` | static | |
| `deploy/host-maintenance-check.sh` | `<INSTALL_DIR>/scripts/host-maintenance-check.sh` | static | |
| `deploy/logrotate-openclaw` | `/etc/logrotate.d/openclaw` | static | |
| `deploy/plugins/*` | `<INSTALL_DIR>/openclaw/deploy/plugins/` | static | Owned by uid 1000 |
| `deploy/sandbox-toolkit.yaml` | `<INSTALL_DIR>/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/parse-toolkit.mjs` | `<INSTALL_DIR>/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/rebuild-sandboxes.sh` | `<INSTALL_DIR>/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/dashboard/*` | `<INSTALL_DIR>/openclaw/deploy/dashboard/` | static | Bind-mounted into container |

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
| `OPENCLAW_DOMAIN` | `openclaw-config.env` (or per-claw `config.env`) | Used to derive `ALLOWED_ORIGIN` |
| `ALLOWED_ORIGIN` | Derived: `https://${OPENCLAW_DOMAIN}` | `openclaw.json` |
| `AI_GATEWAY_WORKER_URL` | `openclaw-config.env` | `models.json` |

> **`controlUi.allowedOrigins` is required.** When the gateway binds to `lan` (non-loopback), which is always the case for Docker/Tunnel deployments, `controlUi.allowedOrigins` must be set in `openclaw.json`. Without it, the gateway crashes on startup with a security check error. The `deploy-config.sh` script handles this automatically by deriving `ALLOWED_ORIGIN` from `OPENCLAW_DOMAIN` (or from the per-claw `config.env` override). If a claw's `OPENCLAW_DOMAIN` is empty, the origin will be `https://` which will fail — every claw must have a domain configured.

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
    INSTALL_DIR='${INSTALL_DIR}' \
    OPENCLAW_DOMAIN='${OPENCLAW_DOMAIN}' \
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
  bash ${INSTALL_DIR}/.deploy-staging/scripts/deploy-config.sh"
```

Expect `DEPLOY_CONFIG_OK` on stdout when successful. All progress output goes to stderr.

### Step 3: Generate Docker Compose override

`deploy-config.sh` deploys per-claw configs but does NOT generate `docker-compose.override.yml`. Run `openclaw-multi.sh generate` to create it from the discovered claws:

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "bash ${INSTALL_DIR}/.deploy-staging/scripts/openclaw-multi.sh generate"
```

This reads `openclaws/*/` from staging, assigns ports, and writes `docker-compose.override.yml` + per-instance `.env` variables. The existing shared `.env` (created by `setup-infra.sh`) is preserved.

> **Multi-claw:** If multiple claws exist (e.g., `main-claw/` and `personal-claw/`), each gets its own service in the override file with auto-assigned ports.

**Cleanup:** `openclaw-config.env` contains secrets (`AI_GATEWAY_AUTH_TOKEN`). The staging directory cleanup at the end of `deploy-config.sh` handles `deploy/*`, but `/tmp/openclaw-config.env` is separate:

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "rm -f /tmp/openclaw-config.env"
```

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

### Step 1: Start claws

Builds the Docker image and starts containers. Multi-claw deployments start only the first claw for sandbox builds; single-claw starts everything.

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env INSTALL_DIR='${INSTALL_DIR}' \
    ENABLE_VECTOR_LOG_SHIPPING='${ENABLE_VECTOR_LOG_SHIPPING}' \
  bash ${INSTALL_DIR}/.deploy-staging/scripts/start-claws.sh"
```

Captures `FIRST_CLAW=openclaw-<name>`, `CLAW_COUNT=N`, and `START_CLAWS_OK` from stdout.

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
> `sudo docker logs <FIRST_CLAW>`
>
> Common issues:
>
> - **Port already in use:** `sudo ss -tlnp | grep 18789` (first claw defaults to 18789; others get 18790+)
> - **Sysbox not available:** `sudo systemctl status sysbox` — must be active
> - **Invalid .env:** missing required variables — `cat <INSTALL_DIR>/openclaw/.env`

### Step 2: Wait for sandbox builds (~15-25 min first boot)

On first boot, the entrypoint builds 3 sandbox images inside nested Docker (~15-25 min).
The gateway HTTP endpoint responds during this time, but WebSocket connections (needed for
device pairing) fail until the entrypoint finishes and drops to the node user.

Use a background task + polling pattern to give the user visual feedback without flooding the context window. Use `FIRST_CLAW` from Step 1.

1. **Start the wait in the background** using the Bash tool with `run_in_background: true`:

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds — looks for privilege drop message
timeout 900 bash -c "until sudo docker logs ${FIRST_CLAW} 2>&1 | grep -q 'Executing as node'; do sleep 10; done"
echo "READY"
```

2. **Poll for progress every 30 seconds** from the main context. Each poll is a lightweight SSH command:

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "sudo docker logs ${FIRST_CLAW} 2>&1 | grep '\[entrypoint\]' | tail -1"
```

Print the result as a status update to the user (e.g., `[entrypoint] Building toolkit sandbox image...`). Continue polling until the background task completes.

3. **Check background task completion** between polls using `TaskOutput` with `block: false`. When the background task returns `READY`, proceed to the next step.

> **Note:** Check for the "Executing as node" log line, not the health endpoint — health responds before sandbox builds complete.

### Step 3: Sync images + start remaining claws (multi-claw only)

If `CLAW_COUNT > 1`, sync sandbox images from the first claw to the others before starting them. This avoids redundant ~15-25 min builds in each additional claw.

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "bash ${INSTALL_DIR}/.deploy-staging/scripts/openclaw-multi.sh sync-images --source <first-claw-name>"
```

Then start all remaining claws (entrypoints detect the pre-placed tar and load in ~30 seconds instead of building):

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose up -d'"
```

> **Single-claw:** Skip this step — there are no other claws to sync to.

### Step 4: Verify deployment

Runs all verification checks across every running claw: sandbox images, binaries, permissions, health endpoints. Discovers containers and ports dynamically.

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
  bash ${INSTALL_DIR}/.deploy-staging/scripts/verify-deployment.sh"
```

Expects `VERIFY_DEPLOYMENT_OK` on stdout. Detailed per-claw results go to stderr.

**Expected:** All 3 sandbox images exist per claw (base, toolkit, browser), USER is 1000 on toolkit, all binaries present including custom tools from `sandbox-toolkit.yaml` (claude, gifgrep). Images should have `openclaw.build-date` labels and be less than 30 days old. If verification fails, check entrypoint logs for ERROR messages.

### Verify CLI access

The `openclaw` host wrapper and `docker exec` commands bypass WebSocket device pairing —
they execute directly inside the container, so no CLI pairing step is needed.

```bash
sudo /usr/local/bin/openclaw devices list
```

**Expected:** Command runs without pairing errors. On a fresh gateway with no browser
connections yet, the output will show an empty device list — that's normal.

> **Next:** Proceed to section 4.5 to register OpenClaw cron jobs. The gateway must be running first — `openclaw cron add` communicates with the gateway scheduler.

---

## 4.5 Deploy OpenClaw Cron Jobs

After the gateway is running and healthy, register the cron jobs defined in `deploy/openclaw-crons.jsonc`.

### Automated Registration

Run the registration script on the VPS (it was copied during the `scp` in section 4.2 Step 1):

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env HOSTALERT_TELEGRAM_CHAT_ID='${HOSTALERT_TELEGRAM_CHAT_ID}' \
  bash ${INSTALL_DIR}/.deploy-staging/scripts/register-cron-jobs.sh"
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

Run the verification script to check all claws (sandbox images, binaries, permissions, health):

```bash
env OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
  bash ${INSTALL_DIR}/.deploy-staging/scripts/verify-deployment.sh
```

Or for quick manual checks:

```bash
# Check containers are running
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose ps'

# Check gateway logs for each claw
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' | sort); do
  echo "=== $CLAW ==="
  sudo docker logs --tail 50 "$CLAW"
done

# Test internal endpoint — use the assigned port for the claw being tested
# First claw defaults to 18789; check actual ports: docker compose ps
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  GW_PORT=$(sudo docker port "$CLAW" 2>/dev/null | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}${OPENCLAW_DOMAIN_PATH}/" | head -5
done

# Check Vector is running (separate compose project)
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/vector && docker compose ps'
sudo docker logs --tail 10 vector
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs for config errors (replace <name> with actual claw name)
sudo docker logs openclaw-<name>

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Gateway Crashes: "non-loopback Control UI requires allowedOrigins"

When the gateway binds to `lan` (which all Docker/Tunnel deployments do via `--bind lan`), it requires `controlUi.allowedOrigins` to be set in `openclaw.json`. If missing or empty, the gateway exits immediately with a security check error.

**Cause:** `OPENCLAW_DOMAIN` was not passed to `deploy-config.sh`, so `{{ALLOWED_ORIGIN}}` was substituted as `https://` (empty domain).

**Fix:** Ensure `OPENCLAW_DOMAIN` is set in `openclaw-config.env` (or overridden per-claw in `config.env`), then re-run the deploy-config step from § 4.3 Step 2. Restart the claw container after updating the config.

```bash
# Verify the deployed config has a valid allowedOrigins
sudo grep -A2 'allowedOrigins' <INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json
# Should show: "allowedOrigins": ["https://your-domain.example.com"]
```

### Permission Denied on .openclaw

The gateway creates subdirectories (`identity/`, `devices/`, `memory/`) during startup
as root (before gosu drops to node). The entrypoint's ownership fix (1d) runs before
these dirs exist, so they end up root-owned.

```bash
# Fix ownership on host (per-claw instances)
for inst_dir in <INSTALL_DIR>/instances/*/; do
  sudo chown -R 1000:1000 "${inst_dir}.openclaw"
done

# Or fix inside each container
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  sudo docker exec "$CLAW" chown -R 1000:1000 /home/node/.openclaw
done
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
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/vector && docker compose restart'
```

### Config Overwritten After Manual Edit

The OpenClaw gateway rewrites `openclaw.json` on startup. It strips JSONC comments, converts to plain JSON, and adds `meta` fields (file hash, timestamps). This means:

- **Manual edits to deployed `openclaw.json` may be partially overwritten** — the gateway preserves config values but reformats the file and removes comments.
- **File size changes are expected** — the rewritten file is typically smaller (comments removed) or larger (meta fields added) than the deployed version.
- **The gateway creates a `.bak` backup** before rewriting, so the previous version is recoverable.

To make persistent config changes, update the template in `openclaws/_defaults/openclaw.json` (or a per-claw override) and re-run `deploy-config.sh`, then restart the container.

### CLI Commands Failing

The `openclaw` host wrapper uses `docker exec`, which bypasses WebSocket device pairing.
If CLI commands fail, check:

1. The gateway container is running: `sudo docker ps --filter 'name=^openclaw-'`
2. The `.openclaw` directory has correct ownership: `sudo docker exec openclaw-<name> chown -R 1000:1000 /home/node/.openclaw`

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
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git tag -f pre-update'
docker tag openclaw:local "openclaw:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git pull origin main'
sudo -u openclaw <INSTALL_DIR>/scripts/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose up -d'

# 5. Verify new version
openclaw --version
# Verify each claw is responding
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  GW_PORT=$(sudo docker port "$CLAW" | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}${OPENCLAW_DOMAIN_PATH}/" | head -3
done

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-' | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "openclaw:rollback-$(date +%Y%m%d)" openclaw:local

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose up -d'

# 4. Verify
openclaw --version
# Verify each claw is responding
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  GW_PORT=$(sudo docker port "$CLAW" | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}${OPENCLAW_DOMAIN_PATH}/" | head -3
done
```

> If the rollback date tag doesn't match today, list available rollback images with:
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-'`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. `read_only: true` breaks because Sysbox auto-mounts (for `/var/lib/docker`, `/proc`, `/sys`) inherit the flag, giving dockerd a read-only filesystem. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
