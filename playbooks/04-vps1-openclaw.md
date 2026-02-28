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

Config values are read from `.env` and `stack.yml` (resolved by `bun run pre-deploy` into `.deploy/`):

- `VPS_IP` (`.env`) - Public IP of VPS-1
- `AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN` (`.env`) - AI Gateway Worker URL and auth token
- `LOG_WORKER_URL`, `LOG_WORKER_TOKEN` (`.env`) - Log Receiver Worker (for Vector log shipping)
- `ADMIN_TELEGRAM_ID` (`.env`) - Numeric Telegram user ID (for `tools.elevated` access gating)
- `HOSTALERT_TELEGRAM_BOT_TOKEN`, `HOSTALERT_TELEGRAM_CHAT_ID` (`.env`) - Host alerter Telegram config
- `defaults.domain`, `defaults.domain_path` (`stack.yml`) - Gateway domain and URL subpath
- `defaults.install_dir` (`stack.yml`) - Base installation directory on VPS (default: `/home/openclaw`)
- Per-claw overrides in `stack.yml` under `claws.<name>`

---

## 4.2 Infrastructure Setup

> **Pre-deploy + SCP + single script.** Run `bun run pre-deploy` locally to build `.deploy/` artifacts, SCP them to the VPS staging area, then run `setup-infra.sh` which creates networks, directories, clones the repo, and generates the `.env` file. Returns the generated `GATEWAY_TOKEN` which must be saved locally before proceeding.

### Step 0: Build deployment artifacts locally

```bash
bun run pre-deploy
```

This builds `.deploy/` from `.env` + `stack.yml` + `docker-compose.yml.hbs`, resolving all templates and generating the final `docker-compose.yml`, per-claw `openclaw.json` files, and `stack.json`.

### Step 1: SCP deploy directory to VPS

**Run from LOCAL machine:**

```bash
# Create staging directory on VPS (under INSTALL_DIR, not world-writable /tmp)
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} "sudo mkdir -p ${INSTALL_DIR}/.deploy-staging && sudo chown ${SSH_USER}:${SSH_USER} ${INSTALL_DIR}/.deploy-staging"

# Copy pre-built deployment artifacts
scp -P ${SSH_PORT} -i ${SSH_KEY} -r .deploy/* ${SSH_USER}@${VPS_IP}:${INSTALL_DIR}/.deploy-staging/

# Copy deploy scripts (entrypoint, build script, etc.)
scp -P ${SSH_PORT} -i ${SSH_KEY} -r deploy/* ${SSH_USER}@${VPS_IP}:${INSTALL_DIR}/.deploy-staging/
```

### Step 2: Run setup-infra.sh

Discover claw names from the pre-built `.deploy/stack.json`:

```bash
# Discover claw instance names from pre-built stack config
INSTANCE_NAMES=$(bun -e "const s = require('./.deploy/stack.json'); console.log(Object.keys(s.claws).join(' '))")
echo "Instances: $INSTANCE_NAMES"
```

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "env \
    INSTALL_DIR='${INSTALL_DIR}' \
    INSTANCE_NAMES='${INSTANCE_NAMES}' \
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

**Record gateway token locally:** Note the generated `OPENCLAW_GENERATED_TOKEN` from stdout. This will be needed for the deployment report (`08c-deploy-report.md`). The token is also written to `.deploy/` artifacts during pre-deploy.

---

## 4.3 Deploy Configuration

> **Pre-built artifacts.** All configuration is resolved locally by `bun run pre-deploy` (run in §4.2 Step 0). The `.deploy/` directory contains the final `docker-compose.yml`, per-claw `openclaw.json` files (with `$VAR` placeholders for runtime `envsubst`), and deploy scripts. This step copies artifacts from staging into their final locations.

### File manifest

| Source (from staging) | Destination | Notes |
|--------|------------|-------|
| `.deploy/docker-compose.yml` | `<INSTALL_DIR>/deploy/docker-compose.yml` | Pre-generated from `.hbs` template |
| `.deploy/claws/<name>/openclaw.json` | `<INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json` | Per-claw config (runtime `$VAR` resolved by entrypoint) |
| `deploy/build-openclaw.sh` | `<INSTALL_DIR>/scripts/build-openclaw.sh` | |
| `deploy/entrypoint-gateway.sh` | `<INSTALL_DIR>/deploy/scripts/entrypoint-gateway.sh` | |
| `deploy/host-alert.sh` | `<INSTALL_DIR>/scripts/host-alert.sh` | |
| `deploy/host-maintenance-check.sh` | `<INSTALL_DIR>/scripts/host-maintenance-check.sh` | |
| `deploy/logrotate-openclaw` | `/etc/logrotate.d/openclaw` | |
| `deploy/plugins/*` | `<INSTALL_DIR>/deploy/plugins/` | Owned by uid 1000 |
| `deploy/sandbox-toolkit.yaml` | `<INSTALL_DIR>/deploy/` | Bind-mounted into container |
| `deploy/parse-toolkit.mjs` | `<INSTALL_DIR>/deploy/` | Bind-mounted into container |
| `deploy/rebuild-sandboxes.sh` | `<INSTALL_DIR>/deploy/` | Bind-mounted into container |
| `deploy/dashboard/*` | `<INSTALL_DIR>/deploy/dashboard/` | Bind-mounted into container |

### Template resolution

Template variables in `openclaw.jsonc` use `$VAR` syntax and are resolved at container startup by `envsubst` in `entrypoint-gateway.sh`. The docker-compose.yml passes environment variables from `stack.yml` (resolved at build time by `pre-deploy.ts`) into containers, where the entrypoint substitutes them into `openclaw.json`.

> **`controlUi.allowedOrigins` is required.** When the gateway binds to `lan` (non-loopback), which is always the case for Docker/Tunnel deployments, `controlUi.allowedOrigins` must be set in `openclaw.json`. Without it, the gateway crashes on startup with a security check error. This is handled automatically — `pre-deploy.ts` derives `ALLOWED_ORIGIN` from the claw's `domain` in `stack.yml`. Every claw must have a domain configured.

### Step 1: Copy artifacts into place

The staging directory (from §4.2 Step 1) already has all pre-built artifacts. Copy them to final locations:

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo -u openclaw bash -c '
    # Copy docker-compose.yml
    cp ${INSTALL_DIR}/.deploy-staging/docker-compose.yml ${INSTALL_DIR}/deploy/docker-compose.yml

    # Copy per-claw openclaw.json files
    for claw_dir in ${INSTALL_DIR}/.deploy-staging/claws/*/; do
      CLAW_NAME=\$(basename \"\$claw_dir\")
      mkdir -p ${INSTALL_DIR}/instances/\${CLAW_NAME}/.openclaw
      cp \"\${claw_dir}openclaw.json\" ${INSTALL_DIR}/instances/\${CLAW_NAME}/.openclaw/openclaw.json
    done

    # Copy deploy scripts and static files
    cp -r ${INSTALL_DIR}/.deploy-staging/deploy/* ${INSTALL_DIR}/deploy/ 2>/dev/null || true
  '"
```

**Cron generation rules:**

- **Cron runs in the server's local timezone**, not necessarily UTC. Before converting `HOSTALERT_DAILY_REPORT_TIME` to cron fields, check the server timezone: `timedatectl show -p Timezone --value` (or `cat /etc/timezone` as fallback). Convert the user's specified time to the server's local timezone, then write the cron minute/hour fields in that timezone. Include the server timezone and original user time in the cron comment for clarity.
- If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to `9:30 AM PST` — still convert to the server's local timezone.
- Only include the daily report cron line (`--report`) if both `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` are set in `.env`. If Telegram is not configured, write only the alerter line (the script exits silently without Telegram credentials, but there's no point scheduling the report).

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
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "bash ${INSTALL_DIR}/.deploy-staging/scripts/sync-sandbox-images.sh --source <first-claw-name>"
```

Then start all remaining claws (entrypoints detect the pre-placed tar and load in ~30 seconds instead of building):

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose up -d'"
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
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose ps'

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

# Check Vector is running (part of main compose when stack.logging.vector: true)
sudo docker logs --tail 10 vector
```

---

## 4.6 Clean Up Staging

Staging contains deploy artifacts and scripts. Remove it now that all steps are complete.

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "sudo rm -rf ${INSTALL_DIR}/.deploy-staging"
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

**Cause:** The claw's `domain` was empty in `stack.yml` when `bun run pre-deploy` ran, so `ALLOWED_ORIGIN` resolved to `https://` (empty domain).

**Fix:** Ensure `domain` is set in `stack.yml` (either in `defaults` or per-claw under `claws.<name>`), then re-run `bun run pre-deploy` and redeploy the updated `openclaw.json`. Restart the claw container after updating the config.

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
sudo docker exec vector wget -q -O- <LOG_WORKER_URL>/health

# Restart Vector after fixing (use `up -d` instead if .env values changed)
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose restart vector'
```

### Config Overwritten After Manual Edit

The OpenClaw gateway rewrites `openclaw.json` on startup. It strips JSONC comments, converts to plain JSON, and adds `meta` fields (file hash, timestamps). This means:

- **Manual edits to deployed `openclaw.json` may be partially overwritten** — the gateway preserves config values but reformats the file and removes comments.
- **File size changes are expected** — the rewritten file is typically smaller (comments removed) or larger (meta fields added) than the deployed version.
- **The gateway creates a `.bak` backup** before rewriting, so the previous version is recoverable.

To make persistent config changes, update `openclaw/default/openclaw.jsonc` (or per-claw overrides in `stack.yml`), re-run `bun run pre-deploy`, push the updated artifacts, then restart the container.

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

The `openclaw update` CLI command works inside Docker when `ALLOW_OPENCLAW_UPDATES=true` is set for the claw (updates persist across restart but not compose recreate). For permanent host-level updates, rebuild from the host git repo using the build script.

The build script auto-patches the Dockerfile and restores the git working tree after building, so `git pull` always works cleanly. The image is tagged with the stack's project name (e.g., `openclaw-openclaw:local`) to avoid conflicts when multiple stacks share a VPS.

```bash
#!/bin/bash
# Image name is stack-scoped: openclaw-<project>:local
# Read OPENCLAW_IMAGE from the deploy .env
OPENCLAW_IMAGE=$(grep '^OPENCLAW_IMAGE=' <INSTALL_DIR>/deploy/.env | cut -d= -f2)

# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git tag -f pre-update'
docker tag "${OPENCLAW_IMAGE}" "${OPENCLAW_IMAGE%:*}:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git pull origin main'
sudo -u openclaw <INSTALL_DIR>/scripts/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose up -d'

# 5. Verify new version
openclaw --version
# Verify each claw is responding
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  GW_PORT=$(sudo docker port "$CLAW" | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}${OPENCLAW_DOMAIN_PATH}/" | head -3
done

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep "${OPENCLAW_IMAGE%:*}:rollback-" | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
OPENCLAW_IMAGE=$(grep '^OPENCLAW_IMAGE=' <INSTALL_DIR>/deploy/.env | cut -d= -f2)

# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "${OPENCLAW_IMAGE%:*}:rollback-$(date +%Y%m%d)" "${OPENCLAW_IMAGE}"

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose up -d'

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
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep "${OPENCLAW_IMAGE%:*}:rollback-"`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. `read_only: true` breaks because Sysbox auto-mounts (for `/var/lib/docker`, `/proc`, `/sys`) inherit the flag, giving dockerd a read-only filesystem. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
