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
curl -sI --connect-timeout 10 https://<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>/ 2>&1 | head -5
```

**Expected:** 302 or 403 with `Location` header pointing to Cloudflare Access.

**If unprotected (200) or failing (timeout/DNS error):** See `00-fresh-deploy-setup.md` § 0.5 for the full Cloudflare Access verification and troubleshooting procedure.

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

Verify deployed gateway resource limits match VPS hardware. See `00-fresh-deploy-setup.md` § 0.4 for the full resource check procedure and expected values.

```bash
# On VPS: query hardware and deployed limits in one command
nproc && free -b | awk '/^Mem:/{print $2}' && \
sudo docker inspect openclaw-gateway --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'
```

Compare: CPUs should equal `nproc`, memory should be total minus 500M–1GB. NanoCpus = CPUs × 1e9.

**If match:** Report correctly sized and continue.

**If mismatch during fresh deploy:** Auto-apply recommended values (CPUs = nproc, memory = total - 750M) without prompting.

**If mismatch outside fresh deploy:** Show comparison and ask user. If confirmed, update local `deploy/docker-compose.override.yml`, then:

```bash
# NOTE: scp uses -P (uppercase) for port, unlike ssh's -p (lowercase)
scp -i <SSH_KEY_PATH> -P <SSH_PORT> deploy/docker-compose.override.yml <SSH_USER>@<VPS1_IP>:/home/openclaw/openclaw/docker-compose.override.yml
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "sudo chown openclaw:openclaw /home/openclaw/openclaw/docker-compose.override.yml && sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'"
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
ss -tlnp | grep 222

# Services and cron jobs
sudo systemctl status sysbox
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 5 vector
cat /etc/cron.d/openclaw-backup
cat /etc/cron.d/openclaw-alerts
```

**Expected:** SSH on port 222 only (22 removed), fail2ban active, cloudflared active, all containers running, cron jobs present.

### Port Binding & External Reachability

```bash
# On VPS: verify gateway ports bind to localhost only (Docker bypasses UFW)
sudo ss -tlnp | grep -E '187(89|90)'
# Expected: 127.0.0.1:18789 and 127.0.0.1:18790 (NOT 0.0.0.0)

# Full port audit — only 222 should be on 0.0.0.0 or [::]
sudo ss -tlnp

# Verify pids_limit set (prevents fork bombs)
sudo docker inspect openclaw-gateway --format '{{.HostConfig.PidsLimit}}'
# Expected: 512
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

- **State integrity: missing transcripts** — clear with: `sudo docker exec --user node openclaw-gateway bash -c 'echo {} > /home/node/.openclaw/agents/main/sessions/sessions.json'`
- **Sandbox: base image missing** — restart gateway to retry build, then run sandbox verification in `04-vps1-openclaw.md`.

### Checklist

- [ ] SSH port 222 only, key-only auth, AllowUsers adminclaw
- [ ] UFW enabled (SSH only), port 443 closed
- [ ] Fail2ban running, cloudflared active
- [ ] Gateway + Vector + Sysbox running
- [ ] Backup + host alerter cron jobs configured
- [ ] Container ports localhost-only, pids_limit set, resource limits match VPS
- [ ] AI Gateway + Log Receiver Workers responding
- [ ] Security audit: 0 critical/warnings; Doctor: lan warning only

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

# Restart Vector
# Restart Vector (use `up -d vector` instead if .env values changed)
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
