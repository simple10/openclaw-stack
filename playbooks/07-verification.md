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
ssh -i <SSH_KEY_PATH> -p 222 -o ConnectTimeout=10 adminclaw@<VPS1_IP> "echo 'VPS-1 online'"
```

**If VPS doesn't come back after 3-4 minutes:**

> "The VPS hasn't come back online after reboot. This is usually just slow boot.
> Try again in another minute. If it still doesn't respond after 5 minutes:
>
> - Check the VPS status in the OVH dashboard — it may be stuck in reboot
> - Use the provider's console/VNC to check boot progress
> - As a last resort, use the provider's dashboard to force a hard reboot"

---

## 7.1 Verify OpenClaw (VPS-1)

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

## 7.2 Verify Vector (Log Shipping)

```bash
# Check Vector is running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps vector'

# Check Vector logs for errors
sudo docker logs --tail 20 vector

# Check checkpoint data exists
sudo ls -la /home/openclaw/openclaw/data/vector/
```

**Expected:** Vector running, no errors in logs, checkpoint files present.

---

## 7.3 Verify Cloudflare Workers

### Log Receiver Worker

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

> **Note:** The health check passing confirms the worker is deployed and reachable. It does NOT verify that provider API keys (e.g., `ANTHROPIC_API_KEY`) are configured — that is tested during post-deploy (`08-post-deploy.md` § 8.5). On a fresh deploy, the worker is healthy but won't proxy LLM requests until keys are added.

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
# Should get 302/403 redirect to Cloudflare Access login
curl -sI --connect-timeout 10 https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ 2>&1 | head -10
```

**Expected:** 302 or 403 response with `Location` header pointing to Cloudflare Access.

```bash
# Also verify browser VNC route
curl -sI --connect-timeout 10 https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/ 2>&1 | head -10
```

**Expected:** 302 or 403 redirect to Cloudflare Access login.

**If either returns 200 (unprotected):**

> "Your domain is publicly accessible without authentication. Anyone with the URL
> can reach the gateway. Configure Cloudflare Access to protect it — see
> [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md) (Steps 1-3)."

**If connection fails (timeout, DNS error, connection refused):**

> "Domain routing isn't working. The tunnel may not be forwarding traffic to the
> configured hostnames."

Debug steps:
```bash
# Check DNS resolution
dig <OPENCLAW_DOMAIN>
# Expected: CNAME to <tunnel-id>.cfargotunnel.com

# Check tunnel status on VPS
sudo systemctl status cloudflared
sudo journalctl -u cloudflared --no-pager | tail -20
```

---

## 7.5 Verify Host Alerter

```bash
# Test the alerter script manually (should not send alerts if everything is healthy)
sudo /home/openclaw/scripts/host-alert.sh
echo $?  # Should be 0

# Check cron job is installed
cat /etc/cron.d/openclaw-alerts
```

**Expected:** Script exits 0 with no errors, cron entry exists.

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

**Expected:** Config file exists with mode 644. Dry run shows no errors. After forced rotation, `.1` files appear alongside the originals. Log writers (`debug.log`, `commands.log`) continue appending to the truncated files.

---

## 7.5b Verify CLI Pairing

```bash
# Verify CLI is paired and can communicate with the gateway
openclaw devices list

# Expected: command succeeds and shows at least one paired device (the CLI itself)
```

**Expected:** Command completes without "pairing required" errors. At least one device should be listed as paired.

**If it fails with "pairing required":**

Re-run the auto-pairing step from `04-vps1-openclaw.md` section 4.9:

```bash
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
sudo docker exec --user node openclaw-gateway \
  openclaw devices list --url ws://localhost:18789 --token "$GATEWAY_TOKEN"
```

---

## 7.5c Verify Resource Limits

Verify that the deployed gateway container resource limits match the actual VPS hardware.

### Query VPS Resources

```bash
# On VPS: get CPU count and total memory in bytes
nproc && free -b | awk '/^Mem:/{print $2}'
```

This returns two lines: CPU count (e.g., `6`) and total memory in bytes (e.g., `11811160064`).

### Read Deployed Limits

```bash
# On VPS: read gateway resource limits from the deployed override
sudo docker inspect openclaw-gateway --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
```

NanoCpus is CPUs × 1e9 (e.g., `6000000000` = 6 CPUs). Memory is in bytes (e.g., `11811160064`).

### Compare

- **CPUs:** `limits.cpus` should equal the VPS CPU count from `nproc`
- **Memory:** `limits.memory` should be total VPS memory minus 500M–1GB
  - Vector uses ~128M, system/kernel needs ~500M
  - Acceptable range: `total - 1G` to `total - 500M`
- **Reservations:** `reservations.cpus` must not exceed `limits.cpus`

**If values match:** Report that resource limits are correctly sized and continue.

**If mismatch detected:** Show the user a comparison:

```
VPS Resources:
  CPUs:   <nproc result>
  Memory: <total from free, human-readable>

Deployed gateway limits (docker-compose.override.yml):
  CPUs:   <current cpus value>
  Memory: <current memory value>

Recommended gateway limits:
  CPUs:   <nproc result>
  Memory: <total - 750M, rounded to nearest 0.5G>
```

Ask the user if they want to adjust the limits. If confirmed, update the **local** `deploy/docker-compose.override.yml`, then re-deploy the file to the VPS and restart the gateway:

```bash
# After updating the local file, copy to VPS and restart
scp -i <SSH_KEY_PATH> -P <SSH_PORT> deploy/docker-compose.override.yml <SSH_USER>@<VPS1_IP>:/home/openclaw/openclaw/docker-compose.override.yml
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "sudo chown openclaw:openclaw /home/openclaw/openclaw/docker-compose.override.yml && sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'"
```

---

## 7.6 Security Checklist

### VPS-1

- [ ] SSH on port 222 only (port 22 removed from UFW)
- [ ] SSH key-only authentication (password disabled)
- [ ] Only `adminclaw` user can SSH (AllowUsers directive)
- [ ] UFW enabled with minimal rules (SSH only)
- [ ] Fail2ban running
- [ ] Cloudflare Tunnel running (cloudflared service active)
- [ ] Port 443 closed

```bash
# Verify on VPS-1
sudo ufw status
sudo systemctl status fail2ban
sudo systemctl status cloudflared
ss -tlnp | grep 222
```

### VPS-1 Services

- [ ] OpenClaw gateway running
- [ ] Sysbox runtime available
- [ ] Vector shipping logs
- [ ] Backup cron job configured
- [ ] Host alerter cron job configured
- [ ] Container ports bound to localhost only (not 0.0.0.0)
- [ ] Gateway resource limits match VPS hardware (CPUs = nproc, memory = total - 500M–1G)
- [ ] Gateway pids_limit set

```bash
sudo systemctl status sysbox
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 5 vector
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-alerts

# Verify gateway and bridge ports bind to localhost only (not 0.0.0.0)
# Docker bypasses UFW, so 0.0.0.0 binding exposes ports to the internet
sudo ss -tlnp | grep -E '187(89|90)'
# Expected: 127.0.0.1:18789 and 127.0.0.1:18790 (NOT 0.0.0.0)

# Verify gateway has pids_limit set (prevents fork bombs)
sudo docker inspect openclaw-gateway --format '{{.HostConfig.PidsLimit}}'
# Expected: 512
```

### Cloudflare Workers

- [ ] AI Gateway Worker responding
- [ ] Log Receiver Worker responding
- [ ] Logs appearing in Cloudflare Workers dashboard

---

## 7.7 End-to-End Test

> **Note:** Steps 1-3 below require authenticating through Cloudflare Access, which Claude cannot do via curl. These are user-driven steps. For automated browser E2E testing, see [`docs/TESTING.md`](../docs/TESTING.md) (Phase 2) where the user authenticates via Chrome DevTools.

1. **User: Access OpenClaw** via configured domain (authenticate through Cloudflare Access)
2. **User: Send a test message** via webchat
3. **User: Verify LLM response** comes back (confirms AI Gateway Worker is routing to a provider). This may fail until provider API keys are configured in the worker — see `08-post-deploy.md` § 8.5 for the configuration flow.
4. **(CF AI Gateway mode only)** Check Cloudflare AI Gateway dashboard for the request (Dashboard -> AI -> AI Gateway)
5. **Check Cloudflare Workers logs** for container log entries (Workers & Pages -> log-receiver -> Logs)

---

## 7.8 Security Verification

Confirm gateway ports aren't externally reachable and the built-in security audit passes.

### External Port Reachability (run from LOCAL machine)

Attempt to connect to gateway ports directly via the VPS public IP. Both should fail/timeout, confirming they're only bound to localhost.

```bash
# Run from LOCAL machine (not on VPS)
nc -zv -w 5 <VPS1_IP> 18789 2>&1 || echo "Port 18789 not reachable (expected)"
nc -zv -w 5 <VPS1_IP> 18790 2>&1 || echo "Port 18790 not reachable (expected)"
```

**Expected:** Both connections fail with timeout or connection refused. If either succeeds, the Docker daemon.json localhost binding is misconfigured — see `playbooks/03-docker.md` for the fix.

### Full Listening Port Audit (run on VPS)

Verify the only externally-bound port is SSH (222). All other listening ports should be on `127.0.0.1` only.

```bash
# On VPS-1: list all listening ports — only 222 should be on 0.0.0.0 or [::]
sudo ss -tlnp
```

**Expected:** Only port 222 (sshd) is bound to `0.0.0.0` or `[::]`. All other ports (18789, 18790, dockerd, etc.) should show `127.0.0.1` only. Any unexpected `0.0.0.0` binding is a security issue.

### OpenClaw Security Audit (run on VPS)

Run OpenClaw's built-in security scanner. This does NOT need device pairing — it performs local HTTP probes inside the container.

```bash
openclaw security audit --deep
```

**Expected:** 0 critical, 0 warnings. 1 info finding is normal. If the audit reports ECONNREFUSED on an unexpected port, check that `OPENCLAW_GATEWAY_PORT` in the container's `.env` is set to `18789` (port only, not `IP:port`).

### OpenClaw Doctor (run on VPS)

Run OpenClaw's diagnostic checker inside the container.

```bash
openclaw doctor --deep
```

**Expected:** Only finding should be the Security warning about `lan` binding. No State integrity or Sandbox warnings.

**Expected warning (safe to ignore):**

- **Security: Gateway bound to "lan" (0.0.0.0)** — required for Docker deployments for Cloudflare Tunnel to reach the OpenClaw Gateway. See [REQUIREMENTS.md § 3.7](../REQUIREMENTS.md#37-openclawjson-configuration) for rationale.

**If you see other warnings:**

- **State integrity: missing transcripts** — stale session entries from heartbeat. Clear with: `sudo docker exec --user node openclaw-gateway bash -c 'echo {} > /home/node/.openclaw/agents/main/sessions/sessions.json'`
- **Sandbox: base image missing** — the common sandbox build failed. The entrypoint uses a `BASE_IMAGE` override to work around the upstream `USER sandbox` bug (builds a rooted intermediate, passes it to the upstream script). Restart the gateway to retry, then run the sandbox verification in `04-vps1-openclaw.md` to confirm images were built.

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

# Restart Vector
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart vector'

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

1. VPS-1 accessible via SSH on port 222
2. OpenClaw gateway responding on localhost (internal health check)
3. Vector running and shipping logs
4. Cloudflare Workers responding to health checks
5. Container logs appearing in Cloudflare Workers dashboard
6. Cloudflare Tunnel running and domain protected by Cloudflare Access (302/403 on unauthenticated curl)
7. Backup cron job configured on VPS-1
8. Host alerter cron job configured on VPS-1
9. Gateway ports (18789, 18790) not reachable from external network
10. Security audit passes with no critical or warning findings

> **Note:** Full end-to-end verification (user authenticating through Cloudflare Access, sending messages) is covered in `08-post-deploy.md` (device pairing) and [`docs/TESTING.md`](../docs/TESTING.md) (browser automation via Chrome DevTools).
