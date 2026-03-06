# 07 - Verification & Testing

Comprehensive verification procedures after deployment.

## Overview

This playbook verifies:

- OpenClaw container health
- Vector log shipping
- Cloudflare Workers health
- End-to-end connectivity
- Security (port exposure, listening services, built-in audit)

## Verification Tiers

| Tier | Purpose | Sections | When to run |
|------|---------|----------|-------------|
| **Tier 1: Critical** | Smoke test — deployment is functional | 7.1, 7.2, 7.2a, 7.3, 7.4, 7.6 | Every deployment, after reboots, after maintenance |
| **Tier 2: Extended** | Full validation — comprehensive checks | 7.1a, 7.5, 7.5a–c, 7.6a, 7.7 | Fresh deploys, major updates, periodic audits |

> **Quick smoke test:** Run Tier 1 only (~5 min). If all pass, the deployment is operational. Run Tier 2 for full confidence on fresh deploys or after significant changes.

## Prerequisites

- All previous playbooks completed
- Cloudflare Tunnel installed (02-base-setup.md section 2.6)
- Workers deployed (01-workers.md)
- VPS-1 rebooted after configuration

> **SSH auth convention:** Commands below may show `ssh -i <SSH_KEY> ...`. If you use an SSH agent, omit `-i <SSH_KEY>` and use your normal SSH config or add `-o IdentityAgent=<SSH_IDENTITY_AGENT>`.

## Pre-Verification: Reboot VPS-1

Before running verification tests, reboot VPS-1 to ensure all configuration changes take effect cleanly (especially kernel parameters, SSH config, and systemd services).

```bash
sudo reboot
```

Wait 1-2 minutes for VPS-1 to come back online, then verify SSH access:

```bash
ssh -i <SSH_KEY> -p <SSH_PORT> -o ConnectTimeout=10 adminclaw@<VPS_IP> "echo 'VPS-1 online'"
```

**If VPS doesn't come back after 3-4 minutes:**

> "The VPS hasn't come back online after reboot. This is usually just slow boot.
> Try again in another minute. If it still doesn't respond after 5 minutes:
>
> - Check the VPS status in the host provider dashboard — it may be stuck in reboot
> - Use the provider's console/KVM to check boot progress
> - As a last resort, use the provider's dashboard to force a hard reboot"

---

# Tier 1: Critical Smoke Test

## 7.1 Verify OpenClaw (VPS-1)

> **Batch:** Steps 7.1-7.2 run on VPS via SSH; step 7.3 runs locally. Execute VPS checks in one SSH session and worker checks in parallel from the local machine.

```bash
# Discover all running claw containers for per-claw checks
CLAWS=$(sudo docker ps --format '{{.Names}}' --filter 'name=-openclaw-' | sort)
echo "Claw containers: $CLAWS"

# Check containers are running
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps'

# Check claw logs for errors
for CLAW in $CLAWS; do
  echo "=== $CLAW ==="
  sudo docker logs --tail 50 "$CLAW"
done

# Test each claw's health endpoint
for CLAW in $CLAWS; do
  GW_PORT=$(sudo docker port "$CLAW" 18789/tcp 2>/dev/null | grep -oP ':\K\d+')
  echo "$CLAW (port $GW_PORT):"
  curl -s "http://localhost:${GW_PORT}<OPENCLAW_DOMAIN_PATH>/" | head -5
done
```

**Expected:** All containers running, each endpoint returns the Control UI HTML.

**If containers are not running after reboot:**

This is expected on the first reboot after deployment. Docker Compose services use `restart: unless-stopped`, but the Sysbox runtime (required for these containers) starts as a separate systemd service. On boot, Docker may attempt to restart containers before Sysbox is fully ready, causing them to fail with a runtime error. Docker does not retry after this initial failure.

> "Containers didn't auto-start after reboot. This is a known first-reboot issue — Sysbox wasn't ready when Docker tried to restart the containers. Start them manually:"

```bash
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
```

> Subsequent reboots typically work because Sysbox starts faster on warm boots. If containers consistently fail to start after reboot, check that Sysbox is enabled: `sudo systemctl is-enabled sysbox`.

> If they fail to start even manually, check logs: `for CLAW in $CLAWS; do sudo docker logs "$CLAW"; done`

---

## 7.2 Verify Vector (Log Shipping)

> **Skip this section** if `stack.logging.vector` is `false`.

```bash
# Check Vector is running (part of main compose project)
sudo docker ps --filter 'name=vector'

# Check Vector logs for errors (container name is <project>-vector)
sudo docker logs --tail 20 $(sudo docker ps --format '{{.Names}}' | grep 'vector$')

# Check checkpoint data exists
sudo ls -la <INSTALL_DIR>/vector/data/
```

**Expected:** Vector running, no errors in logs, checkpoint files present.

---

## 7.2a Verify Egress Proxy

> **Skip this section** if `stack.egress_proxy` is not configured in `stack.yml`.

```bash
# Check egress proxy is running (container name is <project>-egress-proxy)
sudo docker ps --filter 'name=egress-proxy'

# Check egress proxy logs
sudo docker logs --tail 10 $(sudo docker ps --format '{{.Names}}' | grep 'egress-proxy$')

# Health check (internal — from VPS)
PROXY_CONTAINER=$(sudo docker ps --format '{{.Names}}' | grep 'egress-proxy$')
sudo docker exec "$PROXY_CONTAINER" wget -q -O- http://localhost:8787/health
```

**Expected:** Container running, logs show startup message, health returns `{"status":"ok"}`.

**If external verification is needed** (from local machine, requires tunnel route configured):

```bash
curl -s https://<EGRESS_PROXY_HOSTNAME>/health
# Expected: {"status":"ok"}
```

---

## 7.3 Verify Cloudflare Workers

### Log Receiver Worker

> **Skip** Log Receiver verification if `stack.logging.vector` is `false`.

```bash
# Health check (no auth required)
curl -s https://<LOG_WORKER_URL>/health

# Test log ingestion
curl -X POST https://<LOG_WORKER_URL>/logs \
  -H "Authorization: Bearer <LOG_WORKER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"container_name":"test","message":"verification test","stream":"stdout","timestamp":"2026-01-01T00:00:00Z"}'
```

**Expected:** Health returns `{"status":"ok"}`, log ingestion returns `{"status":"ok","count":1}`.

**If health check fails:**

> "The Log Receiver Worker isn't responding. Check that the worker is deployed
> and `LOG_WORKER_URL` is correct in `.env`. You can verify the worker
> status in the Cloudflare Dashboard under Workers & Pages."

### AI Gateway Worker

```bash
# Health check
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** Returns `{"status":"ok"}`.

> **Note:** The health check passing confirms the worker is deployed and reachable. It does NOT verify that provider credentials are configured — those are managed via the self-service config UI (`/config`). On a fresh deploy, the worker is healthy but won't proxy LLM requests until credentials are added via `08a-configure-llm-proxy.md`.

**If either worker health check fails:**

> "A Cloudflare Worker isn't responding. Check that it's deployed and the URL
> is correct in `.env`. Verify the worker status in the
> Cloudflare Dashboard under Workers & Pages. If not deployed, run
> `01-workers.md` to deploy it."

### Verify Logs in Cloudflare Dashboard

1. Go to **Cloudflare Dashboard** -> **Workers & Pages** -> **log-receiver** -> **Logs**
2. Check for the test log entry sent above
3. Check for container logs flowing from Vector

---

## 7.4 Verify Cloudflare Tunnel

```bash
# Check cloudflared container is running
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps cloudflared'

# Check tunnel logs for errors
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose logs --tail 20 cloudflared'

# Verify port 443 is closed
sudo ufw status | grep 443 || echo "Port 443 not in UFW (correct)"

# Verify direct IP access fails
curl -sk --connect-timeout 5 https://<VPS_IP>/ || echo "Direct access blocked (expected)"
```

**Expected:** cloudflared container running, no auth errors in logs, port 443 closed, direct IP blocked.

### Verify domain routing (run from LOCAL machine)

```bash
# Both should return 302/403 (Cloudflare Access redirect)
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -5
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><DASHBOARD_BASE_PATH>/ 2>&1 | head -5
```

**Expected:** 302 or 403 with `Location` header pointing to Cloudflare Access.

**If unprotected (200) or failing (timeout/DNS error):** See `00-fresh-deploy-setup.md` § 0.5 for the full Cloudflare Access verification and troubleshooting procedure.

---

## 7.6 Security Verification

Comprehensive security check: system hardening, port exposure, and built-in audit.

### System Hardening (on VPS)

```bash
# SSH, firewall, intrusion prevention
sudo ufw status
sudo systemctl status fail2ban
ss -tlnp | grep <SSH_PORT>

# Services and cron jobs
sudo systemctl status sysbox
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps'
sudo docker logs --tail 5 $(sudo docker ps --format '{{.Names}}' | grep 'vector$')
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-alerts
```

**Expected:** SSH on port `<SSH_PORT>` only (22 removed), fail2ban active, all containers running (including cloudflared), cron jobs present.

### Port Binding & External Reachability

```bash
# On VPS: verify claw ports bind to localhost only (Docker bypasses UFW)
for CLAW in $CLAWS; do
  PORT=$(sudo docker port "$CLAW" 2>/dev/null | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
  BIND=$(sudo ss -tlnp | grep ":${PORT} " | awk '{print $4}')
  echo "$CLAW (port $PORT): $BIND"
done
# Expected: 127.0.0.1:<port> for each claw (NOT 0.0.0.0)

# Full port audit — only <SSH_PORT> should be on 0.0.0.0 or [::]
sudo ss -tlnp

# Verify pids_limit set (prevents fork bombs)
for CLAW in $CLAWS; do
  echo "$CLAW: $(sudo docker inspect "$CLAW" --format '{{.HostConfig.PidsLimit}}')"
done
# Expected: 1024 for each claw
```

```bash
# From LOCAL machine: confirm claw ports aren't externally reachable
for CLAW in $CLAWS; do
  PORT=$(ssh -i <SSH_KEY> -p <SSH_PORT> <SSH_USER>@<VPS_IP> \
    "sudo docker port $CLAW 2>/dev/null | grep -oP '0\.0\.0\.0:\K\d+' | head -1")
  nc -zv -w 5 <VPS_IP> $PORT 2>&1 || echo "Port $PORT not reachable (expected)"
done
```

**Expected:** All connections fail. If any succeed, Docker daemon.json localhost binding is misconfigured — see `03-docker.md`.

### OpenClaw Security Audit & Doctor (on VPS)

```bash
# Security scanner (no device pairing needed — local HTTP probes)
openclaw security audit --deep

# Diagnostic checker
openclaw doctor --deep
```

**Security audit expected:** 0 critical, 0 warnings. 1 info finding is normal. If ECONNREFUSED on unexpected port, check `OPENCLAW_GATEWAY_PORT` in `.env` is `18789` (port only, not `IP:port`).

**Doctor expected:** Only the `lan` binding warning (safe — required for Docker/Tunnel). No State integrity or Sandbox warnings.

**If you see other doctor warnings:**

- **State integrity: session store dir missing** — session dirs are pre-created during `04-vps1-openclaw.md` § 4.3 (Deploy Configuration). If missing, recreate per-instance: `for inst_dir in <INSTALL_DIR>/instances/*/; do sudo mkdir -p "${inst_dir}.openclaw/agents/main/sessions" && echo '{}' | sudo tee "${inst_dir}.openclaw/agents/main/sessions/sessions.json" > /dev/null && sudo chown -R 1000:1000 "${inst_dir}.openclaw"; done`
- **Sandbox: base image missing** — restart the claw container to retry build, then run sandbox verification in `04-vps1-openclaw.md`.

### Checklist

- [ ] SSH port `<SSH_PORT>` only, key-only auth, AllowUsers adminclaw
- [ ] UFW enabled (SSH only), port 443 closed
- [ ] Fail2ban running, cloudflared container running
- [ ] OpenClaw claws + Sysbox running (+ Vector if `stack.logging.vector=true`, + egress proxy if `stack.egress_proxy` configured)
- [ ] Backup + host alerter + maintenance checker cron jobs configured
- [ ] Host status JSON files written and readable from agent sandbox
- [ ] Sandbox toolkit: all binaries from `sandbox-toolkit.yaml` operational in sandbox container
- [ ] Container ports localhost-only, pids_limit set, resource limits match VPS
- [ ] AI Gateway Worker responding (+ Log Receiver if `stack.logging.vector=true`)
- [ ] Security audit: 0 critical/warnings; Doctor: lan warning only

---

# Tier 2: Extended Validation

## 7.1a Verify Sandbox Toolkit

Verify all tool binaries from the sandbox toolkit config are installed and operational in the sandbox image. The bin list is read dynamically from the toolkit config via `parse-toolkit.mjs`, so this test stays in sync as tools are added or removed.

> **Why docker exec into the claw container first?** Sandbox containers run as nested Docker inside the claw container (Sysbox). To inspect them, you must first enter the claw container, then exec into the sandbox.

```bash
FIRST_CLAW=$(echo "$CLAWS" | head -1)

# Get the list of all tool binaries from sandbox-toolkit.yaml
BINS=$(sudo docker exec --user node "$FIRST_CLAW" \
  node /app/openclaw-stack/parse-toolkit.mjs /app/openclaw-stack/sandbox-toolkit.yaml \
  | jq -r '.allBins[]')
echo "Bins to test: $BINS"

# Find a running sandbox-toolkit container (code or skills agent)
SANDBOX=$(sudo docker exec --user node "$FIRST_CLAW" \
  docker ps --filter "ancestor=openclaw-sandbox-toolkit:bookworm-slim" --format '{{.Names}}' | head -1)

# If no sandbox is running, trigger one via the openclaw CLI.
# This creates the container with correct env (PATH, etc.) from openclaw.json.
if [ -z "$SANDBOX" ]; then
  echo "No sandbox running — triggering skills agent sandbox..."
  sudo docker exec --user node "$FIRST_CLAW" \
    openclaw agent --agent skills --message ping --timeout 60 >/dev/null 2>&1 &
  AGENT_PID=$!

  # Wait for the sandbox container to appear
  for i in $(seq 1 20); do
    sleep 3
    SANDBOX=$(sudo docker exec --user node "$FIRST_CLAW" \
      docker ps --filter "ancestor=openclaw-sandbox-toolkit:bookworm-slim" --format '{{.Names}}' | head -1)
    [ -n "$SANDBOX" ] && break
    echo "  waiting... ($((i*3))s)"
  done
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true

  if [ -z "$SANDBOX" ]; then
    echo "FAILED — sandbox did not appear after 60s. Check claw container logs."
    exit 1
  fi
fi

echo "Testing sandbox: $SANDBOX (via $FIRST_CLAW)"

# Test each binary inside the sandbox — use `which` to verify it's on PATH
PASS=0; FAIL=0; TOTAL=0
for bin in $BINS; do
  TOTAL=$((TOTAL+1))
  if sudo docker exec --user node "$FIRST_CLAW" \
    docker exec "$SANDBOX" which "$bin" > /dev/null 2>&1; then
    echo "  ✓ $bin"
    PASS=$((PASS+1))
  else
    echo "  ✗ $bin — NOT FOUND"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ] && echo "All sandbox toolkit binaries operational" || echo "FAILED — some binaries missing"
```

**Expected:** All binaries found on PATH. `0 failed`.

**If tools are missing:**

- Rebuild the sandbox image: `sudo docker exec --user node $FIRST_CLAW /app/openclaw-stack/rebuild-sandboxes.sh --force`
- Then recreate containers: `sudo docker exec --user node $FIRST_CLAW openclaw sandbox recreate --all --force`

---

## 7.5 Verify Host Alerter & Maintenance Checker

```bash
# Test the alerter script manually (should not send alerts if everything is healthy)
sudo <INSTALL_DIR>/host/host-alert.sh
echo $?  # Should be 0

# Verify health.json was written (even without Telegram) — check first instance
FIRST_INST=$(ls -d <INSTALL_DIR>/instances/*/ | head -1)
cat "${FIRST_INST}.openclaw/workspace/.host-status/health.json"

# Test the maintenance checker
sudo <INSTALL_DIR>/host/host-maintenance-check.sh
echo $?  # Should be 0

# Verify maintenance.json was written
cat "${FIRST_INST}.openclaw/workspace/.host-status/maintenance.json"

# Check host cron jobs are installed
cat /etc/cron.d/openclaw-alerts
cat /etc/cron.d/openclaw-maintenance

# Check OpenClaw cron job is registered
openclaw cron list
```

**Expected:** Both scripts exit 0 with no errors. `health.json` and `maintenance.json` contain valid JSON with current timestamps. Workspace copies exist. Both host cron entries exist. `openclaw cron list` shows "Daily VPS Health Check" with status `ok`.

### Telegram Delivery Test

```bash
# Test Telegram delivery (if configured)
TELEGRAM_TOKEN=$(sudo grep -oP 'ENV__HOSTALERT_TELEGRAM_BOT_TOKEN=\K.+' <INSTALL_DIR>/stack.env)
TELEGRAM_CHAT=$(sudo grep -oP 'ENV__HOSTALERT_TELEGRAM_CHAT_ID=\K.+' <INSTALL_DIR>/stack.env)

if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
  RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT}" \
    -d "text=✅ OpenClaw host alerter verified on $(hostname)")
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "Telegram delivery: OK"
  else
    echo "Telegram delivery: FAILED"
    echo "$RESPONSE"
  fi
else
  echo "Telegram not configured — skipping delivery test"
fi
```

**Expected:** If Telegram is configured, a test message arrives in the chat and the script prints `Telegram delivery: OK`. If not configured, this check is skipped.

**If Telegram test fails:**

- `"chat not found"` — the chat ID is wrong. See `docs/TELEGRAM.md` for getting the correct ID.
- `"Unauthorized"` — the bot token is wrong. Create a new bot via @BotFather.
- `"bot was blocked by the user"` — unblock the bot in Telegram.

### Daily Report Cron

```bash
# Verify daily report cron entry (if Telegram configured)
grep 'host-alert.sh --report' /etc/cron.d/openclaw-alerts || echo "No daily report cron (Telegram not configured)"
```

**Expected:** If Telegram is configured, the daily report cron line should be present. If not configured, the line is absent (expected).

---

## 7.5a Verify Log Rotation

```bash
# Check config is installed
ls -la /etc/logrotate.d/openclaw

# Dry-run test — should show "rotating pattern" for each log file with no errors
sudo logrotate -d /etc/logrotate.d/openclaw

# Optional: force a rotation cycle to confirm .1 files appear
sudo logrotate -f /etc/logrotate.d/openclaw
for inst_dir in <INSTALL_DIR>/instances/*/; do
  echo "=== $(basename "$inst_dir") ==="
  sudo ls -la "${inst_dir}.openclaw/logs/" 2>/dev/null || echo "  (no logs yet)"
done
```

**Expected:** Config file exists with mode 644. Dry run shows no errors. After forced rotation, `.1` files appear alongside the originals. Log writers (`telemetry.log`, `backup.log`) continue appending to the truncated files.

---

## 7.5b Verify CLI Pairing

```bash
# Verify CLI is paired and can communicate with the claw
openclaw devices list

# Expected: command succeeds and shows at least one paired device (the CLI itself)
```

**Expected:** Command completes without "pairing required" errors. At least one device should be listed as paired.

**If it fails with "pairing required":**

Re-run the CLI pairing step from `08b-pair-devices.md`:

```bash
FIRST_CLAW=$(echo "$CLAWS" | head -1)
# Read token from the claw's env var (single source of truth)
GATEWAY_TOKEN=$(sudo docker exec --user node "$FIRST_CLAW" printenv OPENCLAW_GATEWAY_TOKEN)
# Discover the claw's gateway port
PORT=$(sudo docker port "$FIRST_CLAW" | grep -oP '0\.0\.0\.0:\K\d+' | head -1)
sudo docker exec --user node "$FIRST_CLAW" \
  openclaw devices list --url ws://localhost:${PORT} --token "$GATEWAY_TOKEN"
```

---

## 7.5c Verify Resource Limits

Verify deployed claw resource limits match VPS hardware. Read resource limits from `.deploy/stack.json` (the resolved config as actually deployed) — check `defaults.resources` and per-claw overrides under `claws.<name>.resources`.

```bash
# On VPS: query hardware and deployed limits
nproc && free -b | awk '/^Mem:/{print $2}'

# Check resource limits for each claw
for CLAW in $CLAWS; do
  echo "=== $CLAW ==="
  sudo docker inspect "$CLAW" --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
done
```

Compare per-claw limits against VPS hardware divided by claw count (see `00-fresh-deploy-setup.md` § 0.4). NanoCpus = CPUs × 1e9, Memory is in bytes.

**If match:** Report correctly sized and continue.

**If mismatch during fresh deploy:** Resource limits were already reviewed in `00-fresh-deploy-setup.md` § 0.4. Auto-apply only if the gap is significant (CPUs differ or memory off by >2GB); otherwise report and continue.

**If mismatch outside fresh deploy:** Show comparison and ask user. If confirmed, update `defaults.resources.cpus` and `defaults.resources.memory` in `stack.yml` (or per-claw overrides under `claws.<name>.resources`), then rebuild and redeploy:

```bash
# Locally: update stack.yml resource values, then rebuild artifacts
npm run pre-deploy

# Push updated artifacts to VPS (via .deploy/ git repo)
cd .deploy && git add -A && git commit -m "Update resource limits" && git push

# On VPS: pull and recreate containers with new limits
ssh -i <SSH_KEY> -p <SSH_PORT> <SSH_USER>@<VPS_IP> \
  "sudo -u openclaw bash -c 'cd <INSTALL_DIR> && git pull && docker compose up -d'"
```

---

## 7.6a Telemetry (unified plugin)

> Skip this section if `ENABLE_LLEMTRY_LOGGING` is not `true` in the deployed config.

**1. Events endpoint (D1 storage):**

```bash
EVENTS_URL="${LOG_WORKER_URL}/openclaw/events"
curl -s -X POST "$EVENTS_URL" \
  -H "Authorization: Bearer $LOG_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instance":{"id":"test"},"events":[]}' | jq .
# Expected: {"status":"ok","count":0}
```

**2. Llemtry endpoint (Langfuse):**

```bash
LLEMTRY_URL="${LOG_WORKER_URL}/llemtry"
curl -s -X POST "$LLEMTRY_URL" \
  -H "Authorization: Bearer $LOG_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resource":{"serviceName":"test"},"spans":[]}' | jq .
# Expected: {"status":"ok","count":0}
```

**3. Plugin startup validation** (on VPS):

```bash
FIRST_CLAW=$(echo "$CLAWS" | head -1)
sudo docker logs "$FIRST_CLAW" 2>&1 | grep -i '\[telemetry\]'
# Expected: "[telemetry] Plugin registered — outputs: [file:telemetry.log, events:/openclaw/events, llemtry]"
# If misconfigured: "[telemetry] events.enabled is true but events.url or events.authToken is missing..."
```

**4. End-to-end** (after sending a message to an agent):

```bash
# Check local telemetry log on VPS (first instance)
FIRST_INST=$(ls -d <INSTALL_DIR>/instances/*/ | head -1)
sudo tail -5 "${FIRST_INST}.openclaw/logs/telemetry.log" | jq .

# Check Log Worker logs for event and llemtry entries
npx wrangler tail --format json | jq 'select(.logs[].message | contains("[EVENTS]") or contains("[LLEMTRY]"))'

# Check D1 for stored events (D1_DATABASE_NAME from workers/log-receiver/wrangler.jsonc)
npx wrangler d1 execute <D1_DATABASE_NAME> --command="SELECT type, category, agent_id, session_id FROM events ORDER BY id DESC LIMIT 10"
```

- [ ] Events endpoint returns `{"status":"ok","count":0}` for empty batch
- [ ] Llemtry endpoint returns `{"status":"ok","count":0}` for empty batch
- [ ] Plugin logs confirm all outputs enabled (or correctly warns if misconfigured)
- [ ] After agent message: events visible in D1 and llemtry spans in Log Worker logs
- [ ] Local telemetry.log file being written

---

## 7.7 End-to-End Test

> **Note:** Steps 1-3 require authenticating through Cloudflare Access (user-driven). For automated browser E2E testing, see [`docs/TESTING.md`](../docs/TESTING.md) (Phase 2).

1. **User: Access OpenClaw** via configured domain (authenticate through Cloudflare Access)
2. **User: Send a test message** via webchat
3. **User: Verify LLM response** comes back (confirms AI Gateway Worker is routing to a provider). May fail until provider API keys are configured — see `08a-configure-llm-proxy.md`.
4. **(CF AI Gateway mode only)** Check Cloudflare AI Gateway dashboard for the request
5. **Check Cloudflare Workers logs** for container log entries (Workers & Pages -> log-receiver -> Logs)

---

## Troubleshooting Quick Reference

### Container Issues

```bash
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps'
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose logs -f <service>'
docker system df
free -h
```

### Vector Issues

```bash
# Check Vector logs (container name is <project>-vector)
sudo docker logs --tail 50 $(sudo docker ps --format '{{.Names}}' | grep 'vector$')

# Restart Vector (use `up -d vector` instead if .env values changed)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose restart vector'

# Check if Worker endpoint is reachable
curl -s https://<LOG_WORKER_URL>/health
```

### Networking Issues

```bash
ss -tlnp                          # List listening ports
curl -v http://localhost:PORT/    # Test local connectivity
sudo ufw status                   # Check firewall rules
```

### Tunnel Issues

```bash
# Check cloudflared container status and logs
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps cloudflared'
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose logs --tail 30 cloudflared'

# Check if DNS resolves to tunnel
dig <OPENCLAW_DOMAIN>
# Should show CNAME to <tunnel-id>.cfargotunnel.com

# Token issues — recreate the container (picks up new token from stack.env)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d cloudflared'
```

### Service Not Starting After Reboot

```bash
sudo systemctl status <service>
sudo systemctl enable <service>
sudo journalctl -u <service> -f
```

---

## Success Criteria

Deployment is complete when:

1. VPS-1 accessible via SSH on port `<SSH_PORT>`
2. OpenClaw claws responding on localhost (internal health check)
3. Vector running and shipping logs (if `stack.logging.vector=true`)
4. Cloudflare Workers responding to health checks
5. Container logs appearing in Cloudflare Workers dashboard (if `stack.logging.vector=true`)
6. Cloudflare Tunnel running and domain protected by Cloudflare Access (302/403 on unauthenticated curl)
7. Backup cron job configured on VPS-1
8. Host alerter and maintenance checker cron jobs configured on VPS-1
9. Claw ports not reachable from external network (bound to localhost only)
10. Security audit passes with no critical or warning findings
11. All sandbox toolkit binaries operational in sandbox container (7.1a)
12. Egress proxy running and healthy (if `stack.egress_proxy` configured)

> **Note:** Full end-to-end verification (user authenticating through Cloudflare Access, sending messages) is covered in `08b-pair-devices.md` (device pairing) and [`docs/TESTING.md`](../docs/TESTING.md) (browser automation via Chrome DevTools).
