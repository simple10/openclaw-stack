# CLAUDE.md — OpenClaw Single-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw on a single OVHCloud VPS instance, with Cloudflare Workers handling observability and LLM proxying.

| Component | Role | Services |
|-----------|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox, Vector (log shipper) |
| **AI Gateway Worker** | LLM Proxy | Cloudflare AI Gateway analytics, API key isolation |
| **Log Receiver Worker** | Log Ingestion | Accepts container logs from Vector, Cloudflare real-time logs |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description |
|----------|-------------|
| `00-analysis-mode.md` | Analyze existing deployment |
| `01-workers.md` | Cloudflare Workers deployment (AI Gateway + Log Receiver) |
| `02-base-setup.md` | Users, SSH, UFW, fail2ban, kernel |
| `03-docker.md` | Docker installation and hardening |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, Vector |
| `05-cloudflare-tunnel.md` | Cloudflare Tunnel setup |
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `98-post-deploy.md` | First access & device pairing |
| `99-new-feature-planning.md` | Process for planning new features |
| `99-new-feature-implementation.md` | Process for implementing planned features |

Optional features are in `playbooks/extras/`:

| Playbook | Description |
|----------|-------------|
| `extras/sandbox-and-browser.md` | Rich sandbox, browser, gateway packages, Claude Code CLI |

See `extras/README.md` for details.

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.

---

## Configuration

IMPORTANT: Read configuration from `openclaw-config.env`:

```bash
# Example config - use the actual values from openclaw-config.env

# Required
VPS1_IP=X.X.X.X                             # VPS-1 public IP
SSH_KEY_PATH=~/.ssh/ovh_openclaw_ed25519    # SSH private key path
SSH_USER=adminclaw                          # SSH user (initially ubuntu then changed to adminclaw during hardening)
SSH_PORT=222                                # SSH port (initially 22 then changed to 222 during hardening)
OPENCLAW_DOMAIN=openclaw.example.com
AI_GATEWAY_WORKER_URL=https://ai-gateway-proxy.<account>.workers.dev
AI_GATEWAY_AUTH_TOKEN=<worker-auth-token>
LOG_WORKER_URL=https://log-receiver.<account>.workers.dev/logs
LOG_WORKER_TOKEN=<generated-token>

# URL subpaths (no trailing slash; empty string "" to serve at root)
OPENCLAW_DOMAIN_PATH=/_openclaw

# Alerting
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Optional
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
```

SSH_USER and SSH_PORT are changed in the hardening steps during deployment.

---

## Setup Question Flow

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me", or any message that doesn't clearly ask for something else like editing a specific file). Also start this flow when the user explicitly requests deployment or mentions VPS work. The Setup Question Flow is the default entry point for this project.

### Step 0: Check Configuration File

Before presenting any options, check if `openclaw-config.env` exists:

```bash
ls openclaw-config.env 2>/dev/null
```

**If missing:** Stop and prompt the user:

> "No `openclaw-config.env` found. Please create this file with your configuration:
>
> ```bash
> cp openclaw-config.example.env openclaw-config.env
> # Then fill in the required values
> ```
>
> Once created, let me know and we'll continue."

**If exists:** Validate required fields:

Required fields to check in openclaw-config.env:

- `VPS1_IP` - Must be a valid IP
- `SSH_KEY_PATH` - Must exist on local system
- `SSH_USER` - Must be set (typically `ubuntu` for fresh OVH VPS)
- `OPENCLAW_DOMAIN` - Must be set
- `AI_GATEWAY_WORKER_URL` - Must be set (AI Gateway Worker URL)
- `AI_GATEWAY_AUTH_TOKEN` - Must be set (AI Gateway auth token)
- `LOG_WORKER_URL` - Must be set (Log Receiver Worker URL)
- `LOG_WORKER_TOKEN` - Must be set (Log Receiver auth token)

If any required field is missing, report all missing fields and ask user to update the file.

**If all required fields are present:** Check for placeholder values in `AI_GATEWAY_WORKER_URL`, `AI_GATEWAY_AUTH_TOKEN`, `LOG_WORKER_URL`, and `LOG_WORKER_TOKEN`. Scan for angle-bracket placeholders (e.g., `<account>`, `<worker-auth-token>`, `<generated-token>`).

**If placeholders detected:** Stop and prompt:

> "Worker configuration contains placeholder values. Workers must be deployed first to get real URLs and auth tokens.
>
> Deploying workers now using `playbooks/01-workers.md`..."

Then execute the `01-workers.md` playbook to deploy both workers. After deployment, update `openclaw-config.env` with the real Worker URLs and auth tokens, then re-validate.

If all fields are present and contain real values (no placeholders), test SSH access to VPS-1:

```bash
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
```

**If SSH fails:** Stop and help troubleshoot:

> "Cannot connect to VPS. Please add your ssh key and make sure you can SSH in:
>
> "Add your ssh key:"
> ssh-add <SSH_KEY_PATH>
>
> "Test SSH:"
> ssh -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"
>
> "Once SSH works, return here and say 'continue'

**If SSH succeeds:** Proceed to Step 1.

### Step 1: Deployment Type Selection

Present the main options:

> "What would you like to do?"
>
> 1. **New deployment** - Fresh VPS, run full setup
> 2. **Existing deployment** - VPS already has some configuration

---

### Path A: New Deployment

#### A1. Playbook Selection

Present playbook selection:

> "Select playbooks to run:"
>
> **Core deployment** (selected by default):
>
> - [x] Base deployment (02, 03, 04, 05, 06-07)
>   - Includes: base-setup, docker, openclaw, cloudflare-tunnel, backup, verification
>   - Note: Workers (01) are deployed automatically during config validation
>
> **Optional features** (from `playbooks/extras/`):
>
> - [ ] Sandbox & Browser (`extras/sandbox-and-browser.md`) — Rich sandbox, browser, gateway packages, Claude Code CLI

#### A2. Confirmation

Show summary and confirm:

> "Ready to deploy:
>
> - VPS-1: `<VPS1_IP>` (OpenClaw)
> - Domain: `<OPENCLAW_DOMAIN>`
> - Networking: Cloudflare Tunnel
> - Playbooks: Base deployment
>
> Proceed?"

---

### Path B: Existing Deployment

#### B1. Check for State Files

```bash
ls .state/*.md 2>/dev/null
```

**If no state files exist:**

> "No state files found. I recommend analyzing your current setup first to understand what's already configured.
>
> Run analysis mode now?"
>
> - **Yes** - Execute `00-analysis-mode.md`
> - **No** - Skip analysis and proceed to options

#### B2. Existing Deployment Options

Present options for existing deployments:

> "What would you like to do?"
>
> 1. **Re-analyze** - Verify current state matches state files
> 2. **Test** - Run verification checks (`07-verification.md`)
> 3. **Modify** - Add features or make changes

#### B3. Modify Sub-flow

When user selects "Modify":

> "What modifications do you want to make?"
>
> **Available extras** (from `playbooks/extras/`):
>
> - [ ] Sandbox & Browser (`extras/sandbox-and-browser.md`) — Rich sandbox, browser, gateway packages, Claude Code CLI
>
> **Other options:**
>
> - **Something else** - Describe what you need

If user selects "Something else," trigger `99-new-feature-planning.md` workflow.

#### B4. Confirmation

After action selection, show summary:

> "Ready to execute:
>
> - VPS-1: `<VPS1_IP>`
> - Action: [selected action]
>
> Proceed?"

---

## Execution Order

### Full Deployment

```
1. Validate openclaw-config.env (including placeholder detection + auto worker deployment)
2. Execute 02-base-setup.md on VPS-1
3. Execute 03-docker.md on VPS-1
4. Execute 04-vps1-openclaw.md on VPS-1
5. Execute 05-cloudflare-tunnel.md on VPS-1
6. Execute 06-backup.md on VPS-1
7. Reboot VPS-1
8. Execute 07-verification.md
9. Execute 98-post-deploy.md
```

All steps are sequential on a single VPS. Workers deployment (01-workers) runs from the local machine using `wrangler` and is triggered automatically during config validation if needed.

---

## Quick Reference

### SSH Access

```bash
# After base setup, SSH as adminclaw (not ubuntu)
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS1-IP>

# Run commands as openclaw
sudo -u openclaw <command>

# Interactive shell as openclaw
sudo su - openclaw
```

### Service Management

```bash
# OpenClaw Gateway
cd /home/openclaw/openclaw
sudo -u openclaw docker compose up -d      # Start
sudo -u openclaw docker compose down       # Stop
sudo -u openclaw docker compose logs -f    # Logs
sudo -u openclaw docker compose ps         # Status

# Vector logs (log shipper)
sudo -u openclaw docker compose logs vector        # View Vector logs
sudo -u openclaw docker compose logs -f vector     # Follow Vector logs
sudo -u openclaw docker compose restart vector     # Restart Vector
```

### Firewall

```bash
sudo ufw status    # View rules
sudo ufw allow <port>  # Add rule
sudo ufw reload    # Reload
```

### Workers (from local machine)

```bash
# Log Receiver Worker
cd workers/log-receiver
npm run deploy                    # Deploy
curl https://<log-worker>/health  # Health check

# AI Gateway Worker
cd workers/ai-gateway
npm run deploy                    # Deploy
curl https://<ai-gateway>/health  # Health check
```

---

## Security Model

Two-user security model on VPS-1:

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key only (port 222) | Passwordless | System administration |
| `openclaw` | None | None | Application runtime |

Security benefits:

- If `openclaw` is compromised, attacker cannot escalate to root
- `adminclaw` is not a well-known username
- Clear separation: admin tasks vs application runtime

---

## Troubleshooting Index

Each playbook contains detailed troubleshooting sections. Common issues:

| Issue | Playbook Section |
|-------|------------------|
| SSH lockout | `02-base-setup.md` -> Troubleshooting |
| Container won't start | `04-vps1-openclaw.md` -> Troubleshooting |
| Tunnel not starting | `05-cloudflare-tunnel.md` -> Troubleshooting |
| Backup permission denied | `06-backup.md` -> Troubleshooting |
| Worker deployment fails | `01-workers.md` -> Troubleshooting |
| Vector not shipping logs | `04-vps1-openclaw.md` -> Troubleshooting |

---

For detailed architecture, configuration, and gotchas, see [REQUIREMENTS.md](REQUIREMENTS.md).

---

## Security Checklist

### VPS-1 (OpenClaw)

- [ ] SSH hardened (port 222, key-only, AllowUsers adminclaw)
- [ ] UFW enabled with minimal rules (SSH only)
- [ ] Fail2ban running
- [ ] Automatic security updates enabled
- [ ] Kernel hardening applied
- [ ] Sysbox runtime installed
- [ ] OpenClaw gateway running
- [ ] Vector shipping logs to Worker
- [ ] Backup cron job configured
- [ ] Host alerter cron job configured

### Networking (Cloudflare Tunnel)

- [ ] Port 443 closed
- [ ] Tunnel running on VPS-1
- [ ] DNS routes through tunnel
- [ ] Cloudflare Access configured

### Workers

- [ ] Log Receiver Worker deployed and healthy
- [ ] AI Gateway Worker deployed and healthy
- [ ] Worker auth tokens set as secrets
- [ ] Cloudflare Health Check configured
