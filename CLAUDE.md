# CLAUDE.md — OpenClaw Single-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw on a single OVHCloud VPS instance, with Cloudflare Workers handling observability and LLM API proxying.

| Component | Role | Services |
|-----------|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox, Vector (log shipper) |
| **AI Gateway Worker** | LLM Proxy | LLM proxy (direct API or optional CF AI Gateway), API key isolation |
| **Log Receiver Worker** | Log Ingestion | Accepts container logs from Vector, Cloudflare real-time logs |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description |
|----------|-------------|
| `00-fresh-deploy-setup.md` | Fresh deploy validation & overview |
| `00-analysis-mode.md` | Analyze existing deployment |
| `01a-cloudflare-setup.md` | Cloudflare Tunnel & Access automation (API-based, optional) |
| `01-workers.md` | Cloudflare Workers deployment (AI Gateway + Log Receiver) |
| `02-base-setup.md` | Users, SSH, UFW, fail2ban, kernel |
| `03-docker.md` | Docker installation and hardening |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, Vector |
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `maintenance.md` | Token rotation schedules and procedures |
| `08-post-deploy.md` | Device pairing & deployment report |

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.
- **Use the `openclaw` CLI wrapper for OpenClaw commands.** VPS host: `openclaw <subcommand>` (wrapper at `/usr/local/bin/openclaw`). Inside container: `openclaw <subcommand>` (symlink). For explicit docker exec, always use `--user node`: `sudo docker exec --user node openclaw-gateway openclaw <subcommand>`.
- **Single source of truth for deployed files.** Files deployed to the VPS live in `deploy/`. Playbooks reference them via `# SOURCE: deploy/<file>` comments with a `# <<< deploy/<file> >>>` sentinel in the heredoc body. When executing a playbook step with this pattern, read the referenced file from the local repo and use its contents in place of the sentinel. Template files are marked `(template)` and use `{{VAR}}` placeholders — substitute values from `openclaw-config.env` or as documented in the `# VARS:` comment. Never duplicate file contents inline in playbooks.
- **Always substitute ALL `{{VAR}}` template placeholders.** When deploying a template file, replace every `{{VAR}}` with its actual value — including empty strings. A variable like `OPENCLAW_DOMAIN_PATH=` (blank) must still be substituted: `"basePath": "{{OPENCLAW_DOMAIN_PATH}}"` → `"basePath": ""`. Leaving a literal `{{...}}` in the deployed config will cause runtime failures. After writing a config with template variables, verify no `{{` remains in the output.

---

## Configuration

IMPORTANT: Read configuration from `openclaw-config.env`:

```bash
# See openclaw-config.env.example for all fields and documentation.
# VPS1_IP and domain config are required to start a fresh deployment.
# Either CF_API_TOKEN + CF_ACCOUNT_ID (for automated Cloudflare setup) or CF_TUNNEL_TOKEN
# (for manual setup) is required. Domain config (OPENCLAW_DOMAIN, OPENCLAW_DASHBOARD_DOMAIN,
# OPENCLAW_DASHBOARD_DOMAIN_PATH, OPENCLAW_DOMAIN_PATH) is validated during fresh deploy
# setup (00-fresh-deploy-setup.md).
```

SSH_USER and SSH_PORT start as provider defaults (e.g., `ubuntu`/`22`) and are changed to `adminclaw`/`<SSH_HARDENED_PORT>` during hardening. `SSH_HARDENED_PORT` (default `222`) is set in config and removed after hardening completes.

---

## Setup Question Flow

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me"). Also start when the user explicitly requests deployment or mentions VPS work. This is the default entry point.

### Step 0: Check Configuration File

Check `openclaw-config.env` exists. If missing, tell user to `cp openclaw-config.env.example openclaw-config.env` and fill in values. Give the user the option to copy the example env for them.

### Step 1: Deployment Type

Ask: **New deployment** (fresh VPS) or **Existing deployment** (already configured)?

- **New deployment:** Follow `playbooks/00-fresh-deploy-setup.md` for validation (`VPS1_IP`, domain config, and SSH needed). Cloudflare Tunnel + Access can be automated via API (`CF_API_TOKEN` + `CF_ACCOUNT_ID`) or configured manually (`CF_TUNNEL_TOKEN`).
- **Existing deployment:** Ask: **Analyze** (`00-analysis-mode.md`), **Test** (`07-verification.md`), or **Modify** (describe custom changes). If "something else," use plan mode.

---

## Execution Order

### Full Deployment

```
1. Validate openclaw-config.env (including Cloudflare automation + worker placeholder detection)
2. Execute 02-base-setup.md on VPS-1
3. Execute 03-docker.md on VPS-1
4. Execute 04-vps1-openclaw.md on VPS-1
5. Execute 06-backup.md on VPS-1
6. Reboot VPS-1
7. Execute 07-verification.md
8. Execute 08-post-deploy.md (device pairing & deployment report)
```

All steps are sequential on a single VPS. Cloudflare automation (01a-cloudflare-setup) and Workers deployment (01-workers) run from the local machine and are triggered automatically during config validation if needed.

**Automation:** After the user confirms the deployment plan in `00-fresh-deploy-setup.md` § 0.7, execute all playbooks continuously without pausing between steps. Only stop for errors requiring user input. The first user interaction after confirmation should be device pairing in `08-post-deploy.md`.

---

## Quick Reference

### SSH Access

```bash
# After base setup, SSH as adminclaw (not ubuntu)
ssh -i <SSH_KEY_PATH:~/.ssh/vps1_openclaw_ed25519> -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS1-IP>

# Run commands as openclaw
sudo -u openclaw <command>

# Interactive shell as openclaw
sudo su - openclaw
```

### Service Management

All docker compose commands run as openclaw (adminclaw can't cd into openclaw's home):

```bash
# Gateway (main compose project):
# Pattern: sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose <cmd>'
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'       # Start gateway
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'           # Status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f'      # Follow logs

# Vector (separate compose project — independent lifecycle):
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'       # Start Vector
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose ps'          # Status
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose logs -f'     # Follow logs
```

> **Note:** Docker Compose warns about unset `CLAUDE_AI_SESSION_KEY`/`CLAUDE_WEB_SESSION_KEY`/`CLAUDE_WEB_COOKIE` — harmless, these are optional.

> **`restart` vs `up -d`:** `restart` does NOT reload `.env` values (baked at container creation). Use `up -d <service>` after `.env` changes. `restart` is fine for bind-mounted file changes (read from disk at startup).

### Firewall

```bash
sudo ufw status    # View rules
sudo ufw allow <port>  # Add rule
sudo ufw reload    # Reload
```

---

## Security Model

See [REQUIREMENTS.md § 2.1](REQUIREMENTS.md#21-two-user-model) for the two-user security model (`adminclaw` for admin, `openclaw` for runtime).

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

See [07-verification.md § 7.6](playbooks/07-verification.md) for the full security verification.
