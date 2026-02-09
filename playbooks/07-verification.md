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
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS1_IP> "echo 'VPS-1 online'"
```

---

## 7.1 Verify OpenClaw (VPS-1)

```bash
# Check containers are running
cd /home/openclaw/openclaw
sudo -u openclaw docker compose ps

# Check gateway logs for errors
sudo docker logs --tail 50 openclaw-gateway

# Test internal endpoint
curl -s http://localhost:18789/ | head -5

# Test health endpoint
curl -s http://localhost:18789/health
```

**Expected:** All containers running, health endpoint returns OK.

---

## 7.2 Verify Vector (Log Shipping)

```bash
# Check Vector is running
sudo -u openclaw docker compose ps vector

# Check Vector logs for errors
sudo docker logs --tail 20 vector

# Check checkpoint data exists
ls -la /home/openclaw/openclaw/data/vector/
```

**Expected:** Vector running, no errors in logs, checkpoint files present.

---

## 7.3 Verify Cloudflare Workers

### Log Receiver Worker

```bash
# Health check (no auth required)
curl -s https://<LOG_WORKER_URL>/health

# Test log ingestion (replace with your actual URL and token)
curl -X POST https://<LOG_WORKER_URL>/logs \
  -H "Authorization: Bearer <LOG_WORKER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"container_name":"test","message":"verification test","stream":"stdout","timestamp":"2026-01-01T00:00:00Z"}'
```

**Expected:** Health returns `{"status":"ok"}`, log ingestion returns `{"status":"ok","count":1}`.

### AI Gateway Worker

```bash
# Health check
curl -s https://<AI_GATEWAY_WORKER_URL>/health
```

**Expected:** Returns `{"status":"ok"}`.

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

> **Note:** External access via the domain (`curl https://<OPENCLAW_DOMAIN>`) is tested in `08-post-deploy.md` after the user configures Cloudflare Access and the published hostname route.

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
- [ ] Gateway pids_limit set

```bash
sudo systemctl status sysbox
sudo -u openclaw docker compose ps
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

1. **Access OpenClaw** via configured domain
2. **Send a test message** via webchat
3. **Verify LLM response** comes back (confirms AI Gateway Worker routing)
4. **Check Cloudflare AI Gateway dashboard** for the request (Workers & Pages -> AI Gateway)
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
- **Sandbox: base image missing** — the common sandbox build failed (known upstream bug). Restart the gateway — the entrypoint has a fallback that rebuilds with `USER root`. See `extras/sandbox-and-browser.md` troubleshooting.

---

## Troubleshooting Quick Reference

### Container Issues

```bash
sudo -u openclaw docker compose ps
sudo -u openclaw docker compose logs -f <service>
docker system df
free -h
```

### Vector Issues

```bash
# Check Vector logs
sudo docker logs --tail 50 vector

# Restart Vector
sudo -u openclaw docker compose restart vector

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
2. OpenClaw gateway responding on VPS-1
3. Vector running and shipping logs
4. Cloudflare Workers responding to health checks
5. Container logs appearing in Cloudflare Workers dashboard
6. External access working via configured networking option
7. Backup cron job configured on VPS-1
8. Host alerter cron job configured on VPS-1
9. LLM requests visible in Cloudflare AI Gateway analytics
10. Gateway ports (18789, 18790) not reachable from external network
11. Security audit passes with no critical or warning findings
