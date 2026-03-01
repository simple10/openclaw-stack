# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:

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

Config values are read from `.env` and `stack.yml` (resolved by `npm run pre-deploy` into `.deploy/`):

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

> **Setup script.** Deploy artifacts were already built and synced to the VPS (step 2 in the deployment plan — `npm run pre-deploy` + `scripts/sync-deploy.sh --fresh`). This step runs `setup-infra.sh` which creates directories and clones the repo.

### Step 1: Run setup-infra.sh

Discover claw names from the pre-built `.deploy/stack.json`:

```bash
# Discover claw instance names from pre-built stack config
INSTANCE_NAMES=$(node -e "const s = require('./.deploy/stack.json'); console.log(Object.keys(s.claws).join(' '))")
echo "Instances: $INSTANCE_NAMES"
```

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "env \
    INSTANCE_NAMES='${INSTANCE_NAMES}' \
  bash ${INSTALL_DIR}/setup/setup-infra.sh"
```

Expects `SETUP_INFRA_OK` on stdout (all other output goes to stderr).

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

**Note:** Gateway tokens are configured in `stack.yml` and resolved by `npm run pre-deploy`. No token capture is needed from this step.

---

## 4.3 Deploy Configuration

> **Pre-built artifacts.** All configuration is resolved locally by `npm run pre-deploy` (step 2 in the deployment plan). The `.deploy/` directory mirrors the VPS `<INSTALL_DIR>/` layout and is synced directly via `scripts/sync-deploy.sh`. Files are placed at their final locations — no staging or manual copying needed.

### File manifest

| `.deploy/` path | VPS destination | Notes |
|--------|------------|-------|
| `docker-compose.yml` | `<INSTALL_DIR>/docker-compose.yml` | Pre-generated from `.hbs` template |
| `instances/<name>/.openclaw/openclaw.json` | `<INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json` | Per-claw config (runtime `$VAR` resolved by entrypoint) |
| `host/build-openclaw.sh` | `<INSTALL_DIR>/host/build-openclaw.sh` | |
| `openclaw-stack/entrypoint.sh` | `<INSTALL_DIR>/openclaw-stack/entrypoint.sh` | |
| `host/host-alert.sh` | `<INSTALL_DIR>/host/host-alert.sh` | |
| `host/host-maintenance-check.sh` | `<INSTALL_DIR>/host/host-maintenance-check.sh` | |
| `host/openclaw-wrapper.sh` | `/usr/local/bin/openclaw` | Installed by `setup-infra.sh` |
| `host/logrotate-openclaw` | `/etc/logrotate.d/openclaw` | |
| `openclaw-stack/plugins/*` | `<INSTALL_DIR>/openclaw-stack/plugins/` | Owned by uid 1000 |
| `openclaw-stack/sandbox-toolkit.yaml` | `<INSTALL_DIR>/openclaw-stack/` | Bind-mounted into container |
| `openclaw-stack/parse-toolkit.mjs` | `<INSTALL_DIR>/openclaw-stack/` | Bind-mounted into container |
| `openclaw-stack/rebuild-sandboxes.sh` | `<INSTALL_DIR>/openclaw-stack/` | Bind-mounted into container |
| `openclaw-stack/dashboard/*` | `<INSTALL_DIR>/openclaw-stack/dashboard/` | Bind-mounted into container |

### Template resolution

Template variables in `openclaw.jsonc` use `$VAR` syntax and are resolved at container startup by `envsubst` in the entrypoint script. The docker-compose.yml passes environment variables from `stack.yml` (resolved at build time by `pre-deploy.ts`) into containers, where the entrypoint substitutes them into `openclaw.json`.

> **`controlUi.allowedOrigins` is required.** When the gateway binds to `lan` (non-loopback), which is always the case for Docker/Tunnel deployments, `controlUi.allowedOrigins` must be set in `openclaw.json`. Without it, the gateway crashes on startup with a security check error. This is handled automatically — `pre-deploy.ts` derives `ALLOWED_ORIGIN` from the claw's `domain` in `stack.yml`. Every claw must have a domain configured.

All artifacts were placed at their final locations by `scripts/sync-deploy.sh` in §4.2 Step 1 — no manual copying needed.

Host cron jobs (backup, session-prune, alerts, maintenance) and logrotate are installed by `register-cron-jobs.sh` in §4.5.

**Current plugins:**

- **coordinator** — auto-discovers agent skills from `agents.list[].skills` arrays in `openclaw.json`, writes a routing table to `AGENTS.md` in the workspace, and injects delegation instructions into agent system prompts via `before_agent_start` hook.
- **telemetry** — unified event shipping to the Log Receiver Worker (LLM spans, session events, tool usage). Configured via `plugins.entries.telemetry.config` in `openclaw.json`.

To add a new skill to an agent, add it to the agent's `skills` array in `openclaw.json` under `agents.list[]`. The coordinator plugin reads these automatically and updates the routing table — no plugin config changes needed. Restart the gateway after updating `openclaw.json`.

---

## 4.4 Build, Start, and Verify

### Step 0: Configure git identity for openclaw user

The build script creates patch branches and commits — git requires a user identity:

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo -u openclaw git config --global user.email 'openclaw@localhost' && \
   sudo -u openclaw git config --global user.name 'openclaw'"
```

### Step 1: Start claws

Builds the Docker image and starts containers. Multi-claw deployments start only the first claw for sandbox builds; single-claw starts everything.

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "bash ${INSTALL_DIR}/host/start-claws.sh"
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
> - **Invalid config:** check docker-compose.yml and openclaw.json — `cat <INSTALL_DIR>/docker-compose.yml`

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
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo docker logs ${FIRST_CLAW} 2>&1 | grep '\[entrypoint\]' | tail -1"
```

Print the result as a status update to the user (e.g., `[entrypoint] Building toolkit sandbox image...`). Continue polling until the background task completes.

3. **Check background task completion** between polls using `TaskOutput` with `block: false`. When the background task returns `READY`, proceed to the next step.

> **Note:** Check for the "Executing as node" log line, not the health endpoint — health responds before sandbox builds complete.

### Step 3: Sync images + start remaining claws (multi-claw only)

If `CLAW_COUNT > 1`, start all remaining claws after the first claw finishes sandbox builds. Each additional claw builds its own sandbox images (~15-25 min each) since sandbox images live inside each claw's nested Docker (Sysbox isolation).

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'"
```

> **Single-claw:** Skip this step — all services were already started in Step 1.

### Step 4: Verify deployment

Runs all verification checks across every running claw: sandbox images, binaries, permissions, health endpoints. Discovers containers and ports dynamically.

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "bash ${INSTALL_DIR}/setup/verify-deployment.sh"
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

## 4.5 Deploy Cron Jobs, Logrotate, and OpenClaw CLI Crons

Install all host-level scheduled tasks and logrotate config. The script handles:
- **Static crons:** backup (`cron-openclaw-backup`), session-prune (`cron-openclaw-session-prune`) → `/etc/cron.d/`
- **Dynamic crons:** alerts (15-min health check + daily report), maintenance (30 min before report) → `/etc/cron.d/`
- **Logrotate:** `logrotate-openclaw` → `/etc/logrotate.d/openclaw`
- **OpenClaw CLI crons:** Daily VPS Health Check registered on each claw via `openclaw cron add`

Schedule and timezone are pre-resolved from `host.host_alerter.daily_report` in `stack.yml` by `npm run pre-deploy`.

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo bash ${INSTALL_DIR}/host/register-cron-jobs.sh"
```

The script is idempotent — it overwrites `/etc/cron.d/` files and skips CLI cron registration on any claw where the job already exists. If containers aren't running yet, host crons and logrotate are still installed and CLI cron registration is deferred with a message to re-run later.

**Verify:**

```bash
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "cat /etc/cron.d/openclaw-* && cat /etc/logrotate.d/openclaw && openclaw cron list"
```

**Expected:** All four cron files in `/etc/cron.d/`, logrotate config in `/etc/logrotate.d/`, and "Daily VPS Health Check" with status `ok` on each claw.

---

## Verification

Run the verification script to check all claws (sandbox images, binaries, permissions, health):

```bash
env OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
  bash ${INSTALL_DIR}/setup/verify-deployment.sh
```

Or for quick manual checks:

```bash
# Check containers are running
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps'

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
# Container name is <project>-vector (e.g., muxxibot-vector)
sudo docker ps --format '{{.Names}}' | grep vector
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

**Cause:** The claw's `domain` was empty in `stack.yml` when `npm run pre-deploy` ran, so `ALLOWED_ORIGIN` resolved to `https://` (empty domain).

**Fix:** Ensure `domain` is set in `stack.yml` (either in `defaults` or per-claw under `claws.<name>`), then re-run `npm run pre-deploy` and redeploy the updated `openclaw.json`. Restart the claw container after updating the config.

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
# Check Vector logs for config errors (container name is <project>-vector)
VECTOR=$(sudo docker ps --format '{{.Names}}' | grep 'vector$')
sudo docker logs "$VECTOR" 2>&1 | head -20

# Verify vector.yaml is mounted correctly
sudo docker exec "$VECTOR" ls -la /etc/vector/

# Test the Worker endpoint is reachable from within the container
sudo docker exec "$VECTOR" wget -q -O- <LOG_WORKER_URL>/health

# Restart Vector after fixing (use `up -d` instead if .env values changed)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose restart vector'
```

### Config Overwritten After Manual Edit

The OpenClaw gateway rewrites `openclaw.json` on startup. It strips JSONC comments, converts to plain JSON, and adds `meta` fields (file hash, timestamps). This means:

- **Manual edits to deployed `openclaw.json` may be partially overwritten** — the gateway preserves config values but reformats the file and removes comments.
- **File size changes are expected** — the rewritten file is typically smaller (comments removed) or larger (meta fields added) than the deployed version.
- **The gateway creates a `.bak` backup** before rewriting, so the previous version is recoverable.

To make persistent config changes, update the openclaw config template (see `defaults.openclaw_json` in `stack.yml` for its path), re-run `npm run pre-deploy`, push the updated artifacts, then restart the container.

### CLI Commands Failing

The `openclaw` host wrapper uses `docker exec`, which bypasses WebSocket device pairing.
If CLI commands fail, check:

1. The gateway container is running: `sudo docker ps --filter 'name=^openclaw-'`
2. The `.openclaw` directory has correct ownership: `sudo docker exec openclaw-<name> chown -R 1000:1000 /home/node/.openclaw`

### Network Issues

```bash
# Verify network exists (created by docker compose)
docker network ls | grep openclaw-net

# Recreate by restarting compose (compose manages the network)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose down && docker compose up -d'
```

---

## Updating OpenClaw

The `openclaw update` CLI command works inside Docker when `ALLOW_OPENCLAW_UPDATES=true` is set for the claw (updates persist across restart but not compose recreate). For permanent host-level updates, rebuild from the host git repo using the build script.

The build script auto-patches the Dockerfile and restores the git working tree after building, so `git pull` always works cleanly. The image is tagged with the stack's project name (e.g., `openclaw-openclaw:local`) to avoid conflicts when multiple stacks share a VPS.

```bash
#!/bin/bash
# Image name is stack-scoped: openclaw-<project>:local
# Source stack config for STACK__STACK__IMAGE
source <INSTALL_DIR>/host/source-config.sh

# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git tag -f pre-update'
docker tag "${STACK__STACK__IMAGE}" "${STACK__STACK__IMAGE%:*}:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git pull origin main'
sudo -u openclaw <INSTALL_DIR>/host/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'

# 5. Verify new version
openclaw --version
# Verify each claw is responding
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  GW_PORT=$(sudo docker port "$CLAW" | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}${OPENCLAW_DOMAIN_PATH}/" | head -3
done

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep "${STACK__STACK__IMAGE%:*}:rollback-" | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
source <INSTALL_DIR>/host/source-config.sh

# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "${STACK__STACK__IMAGE%:*}:rollback-$(date +%Y%m%d)" "${STACK__STACK__IMAGE}"

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'

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
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep "${STACK__STACK__IMAGE%:*}:rollback-"`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. `read_only: true` breaks because Sysbox auto-mounts (for `/var/lib/docker`, `/proc`, `/sys`) inherit the flag, giving dockerd a read-only filesystem. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
