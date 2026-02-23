# 07 - Verification & Testing

Comprehensive verification procedures after deployment.

## Overview

This playbook verifies:

- OpenClaw gateway functionality
- Vector log shipping
- Cloudflare Workers health
- End-to-end connectivity
- Security (port exposure, listening services, built-in audit)

## Prerequisites

- All previous playbooks completed
- Cloudflare Tunnel installed (02-base-setup.md section 2.9)
- Workers deployed (01-workers.md)
- VPS-1 rebooted after configuration

## Pre-Verification: Reboot VPS-1

Before running verification tests, reboot VPS-1 to ensure all configuration changes take effect cleanly (especially kernel parameters, SSH config, and systemd services).

```bash
sudo reboot
```

Wait 1-2 minutes for VPS-1 to come back online, then verify SSH access:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> -o ConnectTimeout=10 adminclaw@<VPS1_IP> "echo 'VPS-1 online'"
```

**If VPS doesn't come back after 3-4 minutes:**

> "The VPS hasn't come back online after reboot. This is usually just slow boot.
> Try again in another minute. If it still doesn't respond after 5 minutes:
>
> - Check the VPS status in the host provider dashboard — it may be stuck in reboot
> - Use the provider's console/KVM to check boot progress
> - As a last resort, use the provider's dashboard to force a hard reboot"

---

## 7.1 Verify OpenClaw (VPS-1)

> **Batch:** Steps 7.1-7.2 run on VPS via SSH; step 7.3 runs locally. Execute VPS checks in one SSH session and worker checks in parallel from the local machine.

```bash
# Check containers are running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'

# Check gateway logs for errors
sudo docker logs --tail 50 openclaw-gateway

# Test internal endpoint (must include basePath if controlUi.basePath is set)
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/ | head -5
```

**Expected:** All containers running, endpoint returns the Control UI HTML.

**If containers are not running after reboot:**

> "Containers didn't auto-start after reboot. Start them manually:"

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
```

> If they fail to start, check `sudo docker logs openclaw-gateway` for errors.

---

## 7.1a Verify Sandbox Toolkit

Verify all tool binaries from `deploy/sandbox-toolkit.yaml` are installed and operational in the sandbox image. The bin list is read dynamically from the toolkit config via `parse-toolkit.mjs`, so this test stays in sync as tools are added or removed.

> **Why docker exec into the gateway first?** Sandbox containers run as nested Docker inside the gateway container (Sysbox). To inspect them, you must first enter the gateway, then exec into the sandbox.

```bash
# Get the list of all tool binaries from sandbox-toolkit.yaml
BINS=$(sudo docker exec --user node openclaw-gateway \
  node /app/deploy/parse-toolkit.mjs /app/deploy/sandbox-toolkit.yaml \
  | jq -r '.allBins[]')
echo "Bins to test: $BINS"

# Find a running sandbox-toolkit container (code or skills agent)
SANDBOX=$(sudo docker exec --user node openclaw-gateway \
  docker ps --filter "ancestor=openclaw-sandbox-toolkit:bookworm-slim" --format '{{.Names}}' | head -1)

# If no sandbox is running, trigger one via the openclaw CLI.
# This creates the container with correct env (PATH, etc.) from openclaw.json.
if [ -z "$SANDBOX" ]; then
  echo "No sandbox running — triggering skills agent sandbox..."
  sudo docker exec --user node openclaw-gateway \
    openclaw agent --agent skills --message ping --timeout 60 >/dev/null 2>&1 &
  AGENT_PID=$!

  # Wait for the sandbox container to appear
  for i in $(seq 1 20); do
    sleep 3
    SANDBOX=$(sudo docker exec --user node openclaw-gateway \
      docker ps --filter "ancestor=openclaw-sandbox-toolkit:bookworm-slim" --format '{{.Names}}' | head -1)
    [ -n "$SANDBOX" ] && break
    echo "  waiting... ($((i*3))s)"
  done
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true

  if [ -z "$SANDBOX" ]; then
    echo "FAILED — sandbox did not appear after 60s. Check gateway logs."
    exit 1
  fi
fi

echo "Testing sandbox: $SANDBOX"

# Test each binary inside the sandbox — use `which` to verify it's on PATH
PASS=0; FAIL=0; TOTAL=0
for bin in $BINS; do
  TOTAL=$((TOTAL+1))
  if sudo docker exec --user node openclaw-gateway \
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

- Rebuild the sandbox image: `sudo docker exec --user node openclaw-gateway /app/deploy/rebuild-sandboxes.sh --force`
- Then recreate containers: `sudo docker exec --user node openclaw-gateway openclaw sandbox recreate --all --force`

---

## 7.2 Verify Vector (Log Shipping)

> **Skip this section** if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.

```bash
# Check Vector is running (separate compose project)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose ps'

# Check Vector logs for errors
sudo docker logs --tail 20 vector

# Check checkpoint data exists
sudo ls -la /home/openclaw/vector/data/
```

**Expected:** Vector running, no errors in logs, checkpoint files present.

---

## 7.3 Verify Cloudflare Workers

### Log Receiver Worker

> **Skip** Log Receiver verification if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.

```bash
# Health check (no auth required)
# NOTE: LOG_WORKER_URL contains /logs suffix — strip it for the base URL health check
curl -s https://<LOG_WORKER_BASE_URL>/health

# Test log ingestion (use the full LOG_WORKER_URL which includes /logs)
curl -X POST https://<LOG_WORKER_URL> \
  -H "Authorization: Bearer <LOG_WORKER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"container_name":"test","message":"verification test","stream":"stdout","timestamp":"2026-01-01T00:00:00Z"}'
```

**Expected:** Health returns `{"status":"ok"}`, log ingestion returns `{"status":"ok","count":1}`.

**If health check fails:**

> "The Log Receiver Worker isn't responding. Check that the worker is deployed
> and the URL is correct in `openclaw-config.env`. You can verify the worker
> status in the Cloudflare Dashboard under Workers & Pages."

### AI Gateway Worker

```bash
# Health check
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** Returns `{"status":"ok"}`.

> **Note:** The health check passing confirms the worker is deployed and reachable. It does NOT verify that provider API keys (e.g., `ANTHROPIC_API_KEY`) are configured — that is tested during post-deploy (`08-post-deploy.md` § 8.1). On a fresh deploy, the worker is healthy but won't proxy LLM requests until keys are added.

**If either worker health check fails:**

> "A Cloudflare Worker isn't responding. Check that it's deployed and the URL
> is correct in `openclaw-config.env`. Verify the worker status in the
> Cloudflare Dashboard under Workers & Pages. If not deployed, run
> `01-workers.md` to deploy it."

### Verify Logs in Cloudflare Dashboard

1. Go to **Cloudflare Dashboard** -> **Workers & Pages** -> **log-receiver** -> **Logs**
2. Check for the test log entry sent above
3. Check for container logs flowing from Vector

---

## 7.4 Verify Cloudflare Tunnel

```bash
# Check tunnel service is running
sudo systemctl status cloudflared

# Check tunnel logs for errors
sudo journalctl -u cloudflared --no-pager | tail -20

# Verify port 443 is closed
sudo ufw status | grep 443 || echo "Port 443 not in UFW (correct)"

# Verify direct IP access fails
curl -sk --connect-timeout 5 https://<VPS1_IP>/ || echo "Direct access blocked (expected)"
```

**Expected:** cloudflared active, no auth errors in logs, port 443 closed, direct IP blocked.

### Verify domain routing (run from LOCAL machine)

```bash
# Both should return 302/403 (Cloudflare Access redirect)
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -5
curl -sI --connect-timeout 10 https://<OPENCLAW_DASHBOARD_DOMAIN><OPENCLAW_DASHBOARD_DOMAIN_PATH>/ 2>&1 | head -5
```

**Expected:** 302 or 403 with `Location` header pointing to Cloudflare Access.

**If unprotected (200) or failing (timeout/DNS error):** See `00-fresh-deploy-setup.md` § 0.5 for the full Cloudflare Access verification and troubleshooting procedure.

---

## 7.5 Verify Host Alerter & Maintenance Checker

```bash
# Test the alerter script manually (should not send alerts if everything is healthy)
sudo /home/openclaw/scripts/host-alert.sh
echo $?  # Should be 0

# Verify health.json was written (even without Telegram)
cat /home/openclaw/.openclaw/workspace/host-status/health.json

# Test the maintenance checker
sudo /home/openclaw/scripts/host-maintenance-check.sh
echo $?  # Should be 0

# Verify maintenance.json was written
cat /home/openclaw/.openclaw/workspace/host-status/maintenance.json

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
TELEGRAM_TOKEN=$(sudo grep -oP 'HOSTALERT_TELEGRAM_BOT_TOKEN=\K.+' /home/openclaw/openclaw/.env)
TELEGRAM_CHAT=$(sudo grep -oP 'HOSTALERT_TELEGRAM_CHAT_ID=\K.+' /home/openclaw/openclaw/.env)

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
sudo ls -la /home/openclaw/.openclaw/logs/
```

**Expected:** Config file exists with mode 644. Dry run shows no errors. After forced rotation, `.1` files appear alongside the originals. Log writers (`telemetry.log`, `backup.log`) continue appending to the truncated files.

---

## 7.5b Verify CLI Pairing

```bash
# Verify CLI is paired and can communicate with the gateway
openclaw devices list

# Expected: command succeeds and shows at least one paired device (the CLI itself)
```

**Expected:** Command completes without "pairing required" errors. At least one device should be listed as paired.

**If it fails with "pairing required":**

Re-run the CLI pairing step from `08-post-deploy.md` § 8.3:

```bash
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token "$GATEWAY_TOKEN"
```

---

## 7.5c Verify Resource Limits

Verify deployed gateway resource limits match VPS hardware. Resource limits are configured via `GATEWAY_CPUS` and `GATEWAY_MEMORY` in `openclaw-config.env` (see § 0.4).

```bash
# On VPS: query hardware and deployed limits in one command
nproc && free -b | awk '/^Mem:/{print $2}' && \
sudo docker inspect openclaw-gateway --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
```

Compare: CPUs should equal `nproc`, memory should be total minus 500M–1GB. NanoCpus = CPUs × 1e9.

**If match:** Report correctly sized and continue.

**If mismatch during fresh deploy:** Resource limits were already reviewed in `00-fresh-deploy-setup.md` § 0.4. Auto-apply only if the gap is significant (CPUs differ or memory off by >2GB); otherwise report and continue.

**If mismatch outside fresh deploy:** Show comparison and ask user. If confirmed, update `GATEWAY_CPUS` and `GATEWAY_MEMORY` in `openclaw-config.env`, then redeploy the `.env` to the VPS and recreate the container:

```bash
# Update the .env on VPS with new resource limits
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo -u openclaw bash -c \"grep -q '^GATEWAY_CPUS=' /home/openclaw/openclaw/.env && \
    sed -i 's/^GATEWAY_CPUS=.*/GATEWAY_CPUS=<NEW_CPUS>/' /home/openclaw/openclaw/.env || \
    echo 'GATEWAY_CPUS=<NEW_CPUS>' >> /home/openclaw/openclaw/.env; \
    grep -q '^GATEWAY_MEMORY=' /home/openclaw/openclaw/.env && \
    sed -i 's/^GATEWAY_MEMORY=.*/GATEWAY_MEMORY=<NEW_MEMORY>/' /home/openclaw/openclaw/.env || \
    echo 'GATEWAY_MEMORY=<NEW_MEMORY>' >> /home/openclaw/openclaw/.env\""

# Recreate container to pick up new limits (up -d re-reads .env)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'"
```

---

## 7.6 Security Verification

Comprehensive security check: system hardening, port exposure, and built-in audit.

### System Hardening (on VPS)

```bash
# SSH, firewall, intrusion prevention, tunnel
sudo ufw status
sudo systemctl status fail2ban
sudo systemctl status cloudflared
ss -tlnp | grep <SSH_PORT>

# Services and cron jobs
sudo systemctl status sysbox
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 5 vector
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-alerts
```

**Expected:** SSH on port `<SSH_PORT>` only (22 removed), fail2ban active, cloudflared active, all containers running, cron jobs present.

### Port Binding & External Reachability

```bash
# On VPS: verify gateway ports bind to localhost only (Docker bypasses UFW)
sudo ss -tlnp | grep -E '187(89|90)'
# Expected: 127.0.0.1:18789 and 127.0.0.1:18790 (NOT 0.0.0.0)

# Full port audit — only <SSH_PORT> should be on 0.0.0.0 or [::]
sudo ss -tlnp

# Verify pids_limit set (prevents fork bombs)
sudo docker inspect openclaw-gateway --format '{{.HostConfig.PidsLimit}}'
# Expected: 1024
```

```bash
# From LOCAL machine: confirm gateway ports aren't externally reachable
nc -zv -w 5 <VPS1_IP> 18789 2>&1 || echo "Port 18789 not reachable (expected)"
nc -zv -w 5 <VPS1_IP> 18790 2>&1 || echo "Port 18790 not reachable (expected)"
```

**Expected:** Both connections fail. If either succeeds, Docker daemon.json localhost binding is misconfigured — see `03-docker.md`.

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

- **State integrity: session store dir missing** — session dirs are pre-created during `04-vps1-openclaw.md` § 4.3 (Deploy Configuration). If missing, recreate: `sudo mkdir -p /home/openclaw/.openclaw/agents/main/sessions && echo '{}' | sudo tee /home/openclaw/.openclaw/agents/main/sessions/sessions.json > /dev/null && sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/main`
- **Sandbox: base image missing** — restart gateway to retry build, then run sandbox verification in `04-vps1-openclaw.md`.

### Checklist

- [ ] SSH port `<SSH_PORT>` only, key-only auth, AllowUsers adminclaw
- [ ] UFW enabled (SSH only), port 443 closed
- [ ] Fail2ban running, cloudflared active
- [ ] Gateway + Sysbox running (+ Vector if `ENABLE_VECTOR_LOG_SHIPPING=true`)
- [ ] Backup + host alerter + maintenance checker cron jobs configured
- [ ] Host status JSON files written and readable from agent sandbox
- [ ] Sandbox toolkit: all binaries from `sandbox-toolkit.yaml` operational in sandbox container
- [ ] Container ports localhost-only, pids_limit set, resource limits match VPS
- [ ] AI Gateway Worker responding (+ Log Receiver if `ENABLE_VECTOR_LOG_SHIPPING=true`)
- [ ] Security audit: 0 critical/warnings; Doctor: lan warning only

---

## 7.6a Telemetry (unified plugin)

> Skip this section if `ENABLE_LLEMTRY_LOGGING` is not `true` in `openclaw-config.env`.

**1. Events endpoint (D1 storage):**

```bash
# Derive events URL from LOG_WORKER_URL
EVENTS_URL="${LOG_WORKER_URL/\/logs/\/events}"
curl -s -X POST "$EVENTS_URL" \
  -H "Authorization: Bearer $LOG_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instance":{"id":"test"},"events":[]}' | jq .
# Expected: {"status":"ok","count":0}
```

**2. Llemtry endpoint (Langfuse):**

```bash
LLEMTRY_URL="${LOG_WORKER_URL/\/logs/\/llemtry}"
curl -s -X POST "$LLEMTRY_URL" \
  -H "Authorization: Bearer $LOG_WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resource":{"serviceName":"test"},"spans":[]}' | jq .
# Expected: {"status":"ok","count":0}
```

**3. Plugin startup validation** (on VPS):

```bash
sudo docker logs openclaw-gateway 2>&1 | grep -i '\[telemetry\]'
# Expected: "[telemetry] Plugin registered — outputs: [file:telemetry.log, events:/events, llemtry]"
# If misconfigured: "[telemetry] events.enabled is true but events.url or events.authToken is missing..."
```

**4. End-to-end** (after sending a message to an agent):

```bash
# Check local telemetry log on VPS
sudo tail -5 /home/openclaw/.openclaw/logs/telemetry.log | jq .

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
3. **User: Verify LLM response** comes back (confirms AI Gateway Worker is routing to a provider). May fail until provider API keys are configured — see `08-post-deploy.md` § 8.1.
4. **(CF AI Gateway mode only)** Check Cloudflare AI Gateway dashboard for the request
5. **Check Cloudflare Workers logs** for container log entries (Workers & Pages -> log-receiver -> Logs)

---

## Troubleshooting Quick Reference

### Container Issues

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f <service>'
docker system df
free -h
```

### Vector Issues

```bash
# Check Vector logs
sudo docker logs --tail 50 vector

# Restart Vector (use `up -d` instead if .env values changed)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose restart'

# Check if Worker endpoint is reachable (strip /logs suffix for base URL)
curl -s https://<LOG_WORKER_BASE_URL>/health
```

### Networking Issues

```bash
ss -tlnp                          # List listening ports
curl -v http://localhost:PORT/    # Test local connectivity
sudo ufw status                   # Check firewall rules
```

### Tunnel Issues

```bash
# Check tunnel service and logs
sudo systemctl status cloudflared
sudo journalctl -u cloudflared --no-pager | tail -30

# Check if DNS resolves to tunnel
dig <OPENCLAW_DOMAIN>
# Should show CNAME to <tunnel-id>.cfargotunnel.com

# Token issues — reinstall service
sudo cloudflared service uninstall
sudo cloudflared service install ${CF_TUNNEL_TOKEN}
sudo systemctl start cloudflared
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
2. OpenClaw gateway responding on localhost (internal health check)
3. Vector running and shipping logs (if `ENABLE_VECTOR_LOG_SHIPPING=true`)
4. Cloudflare Workers responding to health checks
5. Container logs appearing in Cloudflare Workers dashboard (if `ENABLE_VECTOR_LOG_SHIPPING=true`)
6. Cloudflare Tunnel running and domain protected by Cloudflare Access (302/403 on unauthenticated curl)
7. Backup cron job configured on VPS-1
8. Host alerter and maintenance checker cron jobs configured on VPS-1
9. Gateway ports (18789, 18790) not reachable from external network
10. Security audit passes with no critical or warning findings
11. All sandbox toolkit binaries operational in sandbox container (7.1a)

> **Note:** Full end-to-end verification (user authenticating through Cloudflare Access, sending messages) is covered in `08-post-deploy.md` (device pairing) and [`docs/TESTING.md`](../docs/TESTING.md) (browser automation via Chrome DevTools).
