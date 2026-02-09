# OpenClaw Single-VPS Testing Guide

This document provides comprehensive testing instructions for verifying an existing OpenClaw single-VPS deployment. It combines SSH-based verification (delegated to the verification playbook) with browser UI tests via Chrome DevTools MCP.

## For Claude Code Agents

When asked to test the OpenClaw deployment, follow both phases below. Read `openclaw-config.env` first for connection details and variable values used throughout.

```bash
# Read configuration file
cat ../openclaw-config.env
```

Extract these values for use in all tests below:

- `VPS1_IP` - OpenClaw VPS
- `SSH_KEY_PATH` - SSH key location
- `SSH_USER` - SSH username (should be `adminclaw`)
- `SSH_PORT` - SSH port (should be `222`)
- `OPENCLAW_DOMAIN` - Domain for browser tests
- `OPENCLAW_DOMAIN_PATH` - URL subpath (may be empty)
- `AI_GATEWAY_WORKER_URL` - AI Gateway Worker URL
- `LOG_WORKER_URL` - Log Receiver Worker URL (includes `/logs` path)

---

## Phase 1: Verification Playbook (SSH-based checks)

Execute **all** verification steps from [`playbooks/07-verification.md`](../playbooks/07-verification.md) via SSH. This is the source of truth for all non-browser verification. Run each section in order:

| Section | What it checks |
|---------|---------------|
| **7.1** | OpenClaw containers running, gateway health endpoint |
| **7.2** | Vector running, shipping logs, checkpoint data |
| **7.3** | Cloudflare Workers health (AI Gateway + Log Receiver) |
| **7.4** | Cloudflare Tunnel running, external access works, direct IP blocked |
| **7.5** | Host alerter script and cron job |
| **7.6** | Security checklist — SSH hardening, UFW, fail2ban, Sysbox, localhost-only port bindings, backup/alerter crons |
| **7.7** | End-to-end LLM test — send message, verify AI Gateway routing, check Cloudflare dashboards |
| **7.8** | Security verification — external port reachability, full listening port audit, OpenClaw security audit |

**Important**: Section 7.8 includes tests that run on the **local machine** (not the VPS):

```bash
# Run from LOCAL machine — confirm gateway ports aren't externally reachable
nc -zv -w 5 <VPS1_IP> 18789 2>&1 || echo "Port 18789 not reachable (expected)"
nc -zv -w 5 <VPS1_IP> 18790 2>&1 || echo "Port 18790 not reachable (expected)"
```

Both connections should fail. If either succeeds, Docker daemon.json localhost binding is misconfigured — see `playbooks/03-docker.md`.

---

## Phase 2: Browser UI Tests (Chrome DevTools MCP)

These tests verify the actual user experience through browser automation. They require the Chrome DevTools MCP server.

### 2.1 Test OpenClaw Interface

Services use obscured paths to avoid bot scanners.

```
# Navigate to OpenClaw page
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/")

# Take a snapshot to verify the page loaded
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Page loads without SSL errors
- Shows OpenClaw interface or token/pairing prompt
- No console errors related to connection failures

### 2.2 Verify SSL and HTTPS-Only Access

```
# Check for SSL/TLS errors in console
mcp__chrome-devtools__list_console_messages(types=["error"])
```

**Success criteria**: No SSL certificate errors.

### 2.3 Verify 404 on Unknown Paths

```
# Try random path - should return 404
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN>/random-path")
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**: Random paths return 404 (not proxied to backend).

---

## Complete Test Summary

After running all tests, compile results:

| Category | Test | Source | Status |
|----------|------|--------|--------|
| **Infrastructure** | SSH access (port 222) | 7.1 | |
| | UFW firewall rules | 7.6 | |
| | Fail2ban running | 7.6 | |
| **Services** | Docker containers running | 7.1 | |
| | Cloudflare Tunnel active | 7.4 | |
| | Gateway health endpoint | 7.1 | |
| | Sysbox runtime available | 7.6 | |
| **Logging** | Vector running and shipping | 7.2 | |
| **Workers** | AI Gateway healthy | 7.3 | |
| | Log Receiver healthy | 7.3 | |
| **Monitoring** | Host alerter cron | 7.5 | |
| | Backup cron | 7.6 | |
| **Security** | Ports bound to localhost only | 7.6, 7.8 | |
| | External port reachability blocked | 7.8 | |
| | Security audit passes | 7.8 | |
| **End-to-End** | LLM request via AI Gateway | 7.7 | |
| | Logs in Cloudflare dashboard | 7.7 | |
| **Browser UI** | OpenClaw loads | Phase 2.1 | |
| | Valid SSL | Phase 2.2 | |
| | 404 on unknown paths | Phase 2.3 | |

---

## Quick Test Command

For a rapid health check, run this single command (note: SSH uses port 222):

```bash
echo "=== VPS-1 Health ===" && \
ssh -p 222 adminclaw@<VPS1_IP> "sudo -u openclaw docker ps --format '{{.Names}}: {{.Status}}' && echo && curl -s http://localhost:18789/health && echo && sudo systemctl is-active cloudflared"
```

---

## Troubleshooting Common Issues

### SSL Certificate Errors in Browser

1. Check Cloudflare SSL mode is "Full (strict)"
2. Verify tunnel is running: `sudo systemctl status cloudflared`
3. Check DNS routes through tunnel: `dig <OPENCLAW_DOMAIN>`

### Gateway Not Healthy

1. Check container logs: `sudo -u openclaw docker compose logs --tail 50 openclaw-gateway`
2. Check container is running: `sudo -u openclaw docker compose ps`
3. Verify localhost access: `curl -s http://localhost:18789/health`

### No Logs in Cloudflare

1. Check Vector logs: `sudo -u openclaw docker compose logs vector`
2. Verify LOG_WORKER_URL includes `/logs` path
3. Check Log Receiver Worker health: `curl -s https://<LOG_WORKER_URL>/health`

### Container Permission Errors

1. Check container user matches volume ownership
2. Verify `.openclaw` is owned by uid 1000: `ls -la /home/openclaw/.openclaw/`
3. Review `read_only` settings if files can't be written
