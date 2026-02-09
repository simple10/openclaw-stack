# 07 - Verification & Testing

Comprehensive verification procedures after deployment.

## Overview

This playbook verifies:

- OpenClaw gateway functionality
- Vector log shipping
- Cloudflare Workers health
- End-to-end connectivity

## Prerequisites

- All previous playbooks completed
- 05-cloudflare-tunnel.md completed
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

## 7.4 Verify External Access (Cloudflare Tunnel)

```bash
# On VPS-1, verify tunnel is running
sudo systemctl status cloudflared

# Test external access (from any machine)
curl -s https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ | head -5

# Verify direct IP access is blocked
curl -sk --connect-timeout 5 https://<VPS1_IP>/ || echo "Direct access blocked (expected)"
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

## 7.6 Security Checklist

### VPS-1

- [ ] SSH on port 222 only (port 22 removed from UFW)
- [ ] SSH key-only authentication (password disabled)
- [ ] Only `adminclaw` user can SSH (AllowUsers directive)
- [ ] UFW enabled with minimal rules (SSH only)
- [ ] Fail2ban running
- [ ] No WireGuard interface present

```bash
# Verify on VPS-1
sudo ufw status
sudo systemctl status fail2ban
ss -tlnp | grep 222
ip link show wg0 2>&1 | grep -q "does not exist" && echo "No WireGuard (correct)"
```

### VPS-1 Services

- [ ] OpenClaw gateway running
- [ ] Sysbox runtime available
- [ ] Vector shipping logs
- [ ] Backup cron job configured
- [ ] Host alerter cron job configured
- [ ] Container ports bound to localhost only (not 0.0.0.0)

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
