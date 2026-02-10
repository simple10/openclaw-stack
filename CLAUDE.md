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
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `maintenance.md` | Token rotation schedules and procedures |
| `08-post-deploy.md` | First access & device pairing |

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.
- **Use the `openclaw` CLI wrapper for OpenClaw commands.** VPS host: `openclaw <subcommand>` (wrapper at `/usr/local/bin/openclaw`). Inside container: `openclaw <subcommand>` (symlink). For explicit docker exec, always use `--user node`: `sudo docker exec --user node openclaw-gateway openclaw <subcommand>`.
- **Single source of truth for deployed files.** Files deployed to the VPS live in `deploy/`. Playbooks reference them via `# SOURCE: deploy/<file>` comments with a `# <<< deploy/<file> >>>` sentinel in the heredoc body. When executing a playbook step with this pattern, read the referenced file from the local repo and use its contents in place of the sentinel. Template files are marked `(template)` and use `{{VAR}}` placeholders — substitute values from `openclaw-config.env` or as documented in the `# VARS:` comment. Never duplicate file contents inline in playbooks.

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

# Cloudflare Tunnel (token from CF Dashboard)
CF_TUNNEL_TOKEN=

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

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me"). Also start when the user explicitly requests deployment or mentions VPS work. This is the default entry point.

### Step 0: Check Configuration File

If any of these configuration check steps fail, instruct the user how to fix it and wait for them
to provide missing config values in the chat or in openclaw-config.env before continuing.
When values are provided in chat, update the appropriate var in `openclaw-config.env` then rerun
these configuration checks in order, starting with #1.

1. Check `openclaw-config.env` exists. If missing, tell user to `cp openclaw-config.example.env openclaw-config.env` and fill in values. Give the user the option to copy the example env for them.

2. Validate required fields: `VPS1_IP`, `SSH_KEY_PATH` (must exist on local system), `SSH_USER`, `OPENCLAW_DOMAIN`, `AI_GATEWAY_WORKER_URL`, `AI_GATEWAY_AUTH_TOKEN`, `LOG_WORKER_URL`, `LOG_WORKER_TOKEN`. Report all missing fields.

3. Check `CF_TUNNEL_TOKEN`. If empty, tell user to follow the steps in [docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) to create a tunnel in Cloudflare Dashboard, then copy the tunnel token into the
chat session or update openclaw-config.env.

4. Scan worker fields for angle-bracket placeholders (e.g., `<account>`). If found, deploy workers via `playbooks/01-workers.md` and update config with real values.

5. Test SSH: `ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p <SSH_PORT> <SSH_USER>@<VPS1_IP> echo "VPS1 OK"`. If fails, tell user to `ssh-add <SSH_KEY_PATH>` and verify connectivity.

### Step 1: Deployment Type

Ask: **New deployment** (fresh VPS) or **Existing deployment** (already configured)?

- **New deployment:** Confirm VPS IP, domain, and proceed with core playbooks (02-04, 06-07, workers auto-deployed in step 0).
- **Existing deployment:** Ask: **Analyze** (`00-analysis-mode.md`), **Test** (`07-verification.md`), or **Modify** (describe custom changes). If "something else," use plan mode.

---

## Execution Order

### Full Deployment

```
1. Validate openclaw-config.env (including placeholder detection + auto worker deployment)
2. Execute 02-base-setup.md on VPS-1
3. Execute 03-docker.md on VPS-1
4. Execute 04-vps1-openclaw.md on VPS-1
5. Execute 06-backup.md on VPS-1
6. Reboot VPS-1
7. Execute 07-verification.md
8. Execute 08-post-deploy.md
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

---

## Security Model

See [REQUIREMENTS.md § 2.2](REQUIREMENTS.md#22-two-user-security-model) for the two-user security model (`adminclaw` for admin, `openclaw` for runtime).

---

## Troubleshooting Index

Each playbook contains detailed troubleshooting sections. Common issues:

| Issue | Playbook Section |
|-------|------------------|
| SSH lockout | `02-base-setup.md` -> Troubleshooting |
| Container won't start | `04-vps1-openclaw.md` -> Troubleshooting |
| Tunnel not starting | `07-verification.md` -> Tunnel Issues |
| Backup permission denied | `06-backup.md` -> Troubleshooting |
| Worker deployment fails | `01-workers.md` -> Troubleshooting |
| Vector not shipping logs | `04-vps1-openclaw.md` -> Troubleshooting |

---

For detailed architecture, configuration, and gotchas, see [REQUIREMENTS.md](REQUIREMENTS.md).

---

## Security Checklist

See [07-verification.md § 7.6](playbooks/07-verification.md) for the full security checklist.
