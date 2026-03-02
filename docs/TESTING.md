# OpenClaw Single-VPS Testing Guide

This document provides comprehensive testing instructions for verifying an existing OpenClaw single-VPS deployment. It combines SSH-based verification (delegated to the verification playbook) with browser UI tests via Chrome DevTools MCP.

## For Claude Code Agents

When asked to test the OpenClaw deployment, follow both phases below. Source the config first for connection details and variable values used throughout.

```bash
# Load all config variables
source deploy/host/source-config.sh
```

This exports `ENV__*` vars (from `.env`) and `STACK__*` vars (from `stack.yml`). Key variables used in tests below:

- `ENV__VPS_IP` - OpenClaw VPS
- `ENV__SSH_KEY` - SSH key location
- `ENV__SSH_USER` - SSH username (should be `adminclaw`)
- `ENV__SSH_PORT` - SSH port (should be `222`)
- `STACK__STACK__INSTALL_DIR` - VPS install base (default: `/home/openclaw`)
- Per-claw domain/path: `STACK__CLAWS__<NAME>__DOMAIN`, `STACK__CLAWS__<NAME>__DASHBOARD_PATH`

---

## Phase 1: Verification Playbook (SSH-based checks)

Execute **all** verification steps from [`playbooks/07-verification.md`](../playbooks/07-verification.md) via SSH. This is the source of truth for all non-browser verification. Run each section in order:

| Section | What it checks |
|---------|---------------|
| **7.1** | OpenClaw containers running (all claws), gateway health endpoints |
| **7.2** | Vector running, shipping logs, checkpoint data |
| **7.3** | Cloudflare Workers health (AI Gateway + Log Receiver) |
| **7.4** | Cloudflare Tunnel running, external access works, direct IP blocked |
| **7.5** | Host alerter script and cron job |
| **7.5a** | Log rotation config installed and working |
| **7.5b** | CLI device paired and communicating with gateway |
| **7.5c** | Gateway resource limits match VPS hardware |
| **7.6** | Security verification — SSH hardening, UFW, fail2ban, port binding, external reachability, OpenClaw security audit + doctor |
| **7.7** | End-to-end LLM test — send message, verify AI Gateway routing, check Cloudflare dashboards |

**Important**: Section 7.6 includes tests that run on the **local machine** (not the VPS):

```bash
# Run from LOCAL machine — confirm gateway ports aren't externally reachable
# Check each claw's gateway port (discover ports from docker compose config)
nc -zv -w 5 <VPS_IP> 18789 2>&1 || echo "Port 18789 not reachable (expected)"
nc -zv -w 5 <VPS_IP> 18790 2>&1 || echo "Port 18790 not reachable (expected)"
```

All connections should fail. If any succeed, Docker daemon.json localhost binding is misconfigured — see `playbooks/03-docker.md`.

---

## Phase 2: Browser UI Tests (Chrome DevTools MCP)

These tests verify the actual user experience through browser automation. They require the Chrome DevTools MCP server.

**Important: Cloudflare Access gate.** All domain URLs are protected by Cloudflare Access. When navigating to a protected URL for the first time, the browser will show the Cloudflare Access login page. You must:

1. Navigate to the URL
2. Take a snapshot — if it shows a Cloudflare Access login page, **ask the user to authenticate** in the browser
3. Wait for the user to confirm they've logged in
4. Then proceed with the test

Do NOT retry or assume the page failed if you see a Cloudflare Access login page. This is expected behavior.

### 2.1 Authenticate Through Cloudflare Access

```
# Navigate to OpenClaw — will hit Cloudflare Access login first
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/")
mcp__chrome-devtools__take_snapshot()
```

If the snapshot shows a Cloudflare Access login page, tell the user:

> "The browser is showing the Cloudflare Access login page. Please authenticate in the browser, then let me know when you're through."

Wait for user confirmation, then take another snapshot to verify they've reached the OpenClaw page.

### 2.2 Test OpenClaw Interface

After authenticating through Cloudflare Access:

```
# Verify the page loaded
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**:

- Page loads without SSL errors
- Shows OpenClaw interface or token/pairing prompt
- No console errors related to connection failures

### 2.3 Verify SSL and HTTPS-Only Access

```
# Check for SSL/TLS errors in console
mcp__chrome-devtools__list_console_messages(types=["error"])
```

**Success criteria**: No SSL certificate errors.

### 2.4 Verify 404 on Unknown Paths

```
# Try random path — verify it doesn't expose unexpected content
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DOMAIN>/random-path-test-12345")
mcp__chrome-devtools__take_snapshot()
```

**Success criteria**: Random paths return one of: (a) the OpenClaw SPA (gateway catch-all — normal for SPAs), (b) 404, or (c) Cloudflare Access login. The key check is that no unexpected backend content or error details are leaked.

### 2.5 Test Dashboard Access (Optional)

If `OPENCLAW_DASHBOARD_DOMAIN` is configured:

```
# Navigate to dashboard — may hit Cloudflare Access login
mcp__chrome-devtools__navigate_page(url="https://<OPENCLAW_DASHBOARD_DOMAIN><OPENCLAW_DASHBOARD_DOMAIN_PATH>/")
mcp__chrome-devtools__take_snapshot()
```

If Cloudflare Access login appears, ask the user to authenticate (may be automatic if same Access app and already authenticated).

**Success criteria**:

- Page shows the dashboard index page ("OpenClaw Dashboard")
- Links include the correct base path (if subpath URL is used)

---

## Complete Test Summary

After running all tests, compile results:

| Category | Test | Source | Status |
|----------|------|--------|--------|
| **Infrastructure** | SSH access (port 222) | 7.1 | |
| | UFW firewall rules | 7.6 | |
| | Fail2ban running | 7.6 | |
| **Services** | Docker containers running (all claws) | 7.1 | |
| | Cloudflare Tunnel active | 7.4 | |
| | Gateway health endpoint per claw (localhost) | 7.1 | |
| | Sysbox runtime available | 7.6 | |
| **Logging** | Vector running and shipping | 7.2 | |
| **Workers** | AI Gateway healthy | 7.3 | |
| | Log Receiver healthy | 7.3 | |
| **Monitoring** | Host alerter cron | 7.5 | |
| | Log rotation | 7.5a | |
| | Backup cron | 7.6 | |
| **CLI** | CLI device paired (per claw) | 7.5b | |
| | Resource limits match VPS (per claw) | 7.5c | |
| **Security** | Ports bound to localhost only | 7.6 | |
| | External port reachability blocked | 7.6 | |
| | Security audit passes | 7.6 | |
| | Doctor check (lan warning only) | 7.6 | |
| **End-to-End** | LLM request via AI Gateway | 7.7 | |
| | Logs in Cloudflare dashboard | 7.7 | |
| **Browser UI** | Cloudflare Access gate works | Phase 2.1 | |
| | OpenClaw loads (after auth) | Phase 2.2 | |
| | Valid SSL | Phase 2.3 | |
| | 404 on unknown paths | Phase 2.4 | |
| | Browser VNC index page | Phase 2.5 | |

---

## Quick Test Command

For a rapid health check, run this single command. Source config first for variable values.

```bash
source deploy/host/source-config.sh
echo "=== VPS-1 Health ===" && \
ssh -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose ps --format \"{{.Name}}: {{.Status}}\"' && \
   echo && \
   echo '=== Claw Instances ===' && \
   ls -1 ${INSTALL_DIR}/instances/ 2>/dev/null && \
   echo && \
   sudo systemctl is-active cloudflared"
```

---

## Troubleshooting Common Issues

### SSL Certificate Errors in Browser

1. Check Cloudflare SSL mode is "Full (strict)"
2. Verify tunnel is running: `sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps cloudflared'`
3. Check DNS routes through tunnel: `dig <OPENCLAW_DOMAIN>`

### Gateway Not Healthy

1. Check container logs: `sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose logs --tail 50 openclaw-stack-openclaw-<name>'`
2. Check all containers running: `sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose ps'`
3. Verify localhost access per claw (ports start at 18789, increment per claw): `curl -s http://localhost:<port>/ | head -5`

### No Logs in Cloudflare

1. Check Vector logs: `sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose logs vector'`
2. Verify LOG_WORKER_URL is set (base URL, no path suffix)
3. Check Log Receiver Worker health: `curl -s https://<LOG_WORKER_URL>/health`

### Container Permission Errors

1. Check container user matches volume ownership
2. Verify per-instance `.openclaw` is owned by uid 1000: `sudo ls -la ${INSTALL_DIR}/instances/<name>/.openclaw/`
3. Review `read_only` settings if files can't be written
