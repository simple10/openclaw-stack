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
| `01-workers.md` | Cloudflare Workers deployment (AI Gateway + Log Receiver) |
| `02-base-setup.md` | Users, SSH, UFW, fail2ban, kernel |
| `03-docker.md` | Docker installation and hardening |
| `04-vps1-openclaw.md` | Sysbox, networks, gateway, Vector |
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `maintenance.md` | Token rotation, image updates, and maintenance |
| `08-post-deploy.md` | Device pairing & deployment report |

See [playbooks/README.md](playbooks/README.md) for detailed playbook documentation.

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.
- **Use the `openclaw` CLI wrapper for OpenClaw commands.** VPS host: `openclaw <subcommand>` (auto-detects claw). Inside container: `openclaw <subcommand>` (symlink). For explicit docker exec: `sudo docker exec --user node openclaw-<name> openclaw <subcommand>`.
- **Single source of truth for deployed files.** Files deployed to the VPS live in `deploy/`. Playbooks reference them via `# SOURCE: deploy/<file>` comments with a `# <<< deploy/<file> >>>` sentinel in the heredoc body. When executing a playbook step with this pattern, read the referenced file from the local repo and use its contents in place of the sentinel. Template files are marked `(template)` and use `{{VAR}}` placeholders — substitute values from `openclaw-config.env` or as documented in the `# VARS:` comment. Never duplicate file contents inline in playbooks.
- **Always substitute ALL `{{VAR}}` template placeholders.** When deploying a template file, replace every `{{VAR}}` with its actual value — including empty strings. A variable like `OPENCLAW_DOMAIN_PATH=` (blank) must still be substituted: `"basePath": "{{OPENCLAW_DOMAIN_PATH}}"` → `"basePath": ""`. Leaving a literal `{{...}}` in the deployed config will cause runtime failures. After writing a config with template variables, verify no `{{` remains in the output.

---

## Configuration

IMPORTANT: Read configuration from `openclaw-config.env`. See `openclaw-config.env.example` for all fields. Required: `VPS1_IP`, `CF_TUNNEL_TOKEN`, domain config (`OPENCLAW_DOMAIN`, `OPENCLAW_DASHBOARD_DOMAIN`, paths). Domain config is validated during fresh deploy setup (`00-fresh-deploy-setup.md`).

SSH_USER and SSH_PORT start as provider defaults (e.g., `ubuntu`/`22`) and are changed to `adminclaw`/`<SSH_HARDENED_PORT>` during hardening. `SSH_HARDENED_PORT` (default `222`) is set in config and removed after hardening completes.

---

## Setup Question Flow

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me"). Also start when the user explicitly requests deployment or mentions VPS work. This is the default entry point.

1. Check `openclaw-config.env` exists. If missing, offer to `cp openclaw-config.env.example openclaw-config.env`.
2. Ask: **New deployment** (fresh VPS) or **Existing deployment** (already configured)?
   - **New deployment:** Follow [00-fresh-deploy-setup.md](playbooks/00-fresh-deploy-setup.md) for validation and deployment.
   - **Existing deployment:** Ask: **Analyze** (`00-analysis-mode.md`), **Test** (`07-verification.md`), or **Modify** (describe changes). If something else, use plan mode.

---

## Execution Order

See [00-fresh-deploy-setup.md](playbooks/00-fresh-deploy-setup.md) § 0.7 for execution order, automation directive, and context window management.

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

> **Multi-claw:** `docker compose up -d` starts ALL claws. To target one: `docker compose restart openclaw-<name>`. Use `openclaw --instance <name> <cmd>` for per-claw CLI commands.

> **Note:** Docker Compose warns about unset `CLAUDE_AI_SESSION_KEY`/`CLAUDE_WEB_SESSION_KEY`/`CLAUDE_WEB_COOKIE` — harmless, these are optional.

> **`restart` vs `up -d`:** `restart` does NOT reload `.env` values (baked at container creation). Use `up -d <service>` after `.env` changes. `restart` is fine for bind-mounted file changes (read from disk at startup).

For detailed architecture, security model, and gotchas, see [REQUIREMENTS.md](REQUIREMENTS.md).
