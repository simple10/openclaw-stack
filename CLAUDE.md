# CLAUDE.md — OpenClaw Single-VPS Deployment

## Overview

This document orchestrates the automated deployment of OpenClaw on a single VPS instance, with Cloudflare Workers handling observability and LLM API proxying.

| Component | Role | Services |
|-----------|------|----------|
| **VPS-1** | OpenClaw | Gateway, Sysbox, Vector (log shipper), Egress Proxy (optional) |
| **AI Gateway Worker** | LLM Proxy | LLM proxy (direct API or optional CF AI Gateway), per-user KV auth & credentials |
| **Log Receiver Worker** | Log Ingestion | Accepts container logs from Vector, Cloudflare real-time logs |

## Playbook Structure

All deployment steps are in modular playbooks under `playbooks/`:

| Playbook | Description |
|----------|-------------|
| `00-onboarding.md` | Interactive first-time stack configuration |
| `00-fresh-deploy-setup.md` | Fresh deploy validation & overview |
| `00-analysis-mode.md` | Analyze existing deployment |
| `01-workers.md` | Cloudflare Workers deployment (AI Gateway + Log Receiver) |
| `02-base-setup.md` | Users, SSH, UFW, fail2ban, kernel |
| `03-docker.md` | Docker installation and hardening |
| `03b-sysbox.md` | Sysbox runtime for secure Docker-in-Docker |
| `04-vps1-openclaw.md` | Networks, gateway, Vector, host alerter |
| `06-backup.md` | Backup scripts and cron jobs |
| `07-verification.md` | Testing and verification |
| `maintenance.md` | Token rotation, image updates, and maintenance |
| `08a-configure-llm-proxy.md` | AI proxy credential setup (via `/config` UI) |
| `08b-pair-devices.md` | Browser & Telegram device pairing |
| `08c-deploy-report.md` | Deployment report generation |

---

## General Rules

- **Preserve comments in config files.** Comments document intent and aid future maintenance.
- **Update stale comments.** If code changes make a comment inaccurate, fix the comment.
- **Add comments for non-obvious settings.** Explain *why*, not *what*.
- **Always use bind mounts, never named volumes.** All Docker container data must use bind mounts to directories under the service's working directory (e.g., `./data/<service>:/path`). Named volumes hide data inside `/var/lib/docker/volumes/` where it cannot be easily backed up with `rsync`. Bind mounts keep everything on the host filesystem under known paths.
- **Use the `openclaw` CLI wrapper for OpenClaw commands.** VPS host: `openclaw <subcommand>` (auto-detects claw). Inside container: `openclaw <subcommand>` (symlink). For explicit docker exec: `sudo docker exec --user node <project>-openclaw-<name> openclaw <subcommand>`.
- **Single source of truth for deployment.** `npm run pre-deploy` builds `.deploy/` from `.env` + `stack.yml` + `docker-compose.yml.hbs`. All deployed files are generated — never manually edit `.deploy/` contents.
- **Template syntax.** `${VAR}` in `stack.yml` (resolved from `.env` at build time), `{{expr}}` in `.hbs` templates (Handlebars, resolved at build time), `${VAR}` in `openclaw.jsonc` (resolved by OpenClaw's native env var substitution at config load time).

---

## Configuration

Configuration uses three files:

| File | Purpose | Gitignored |
|------|---------|------------|
| `.env` | Secrets & VPS access (flat key-value) | Yes |
| `stack.yml` | Stack structure, claw definitions, defaults (YAML) | Yes |
| `docker-compose.yml.hbs` | Compose template (Handlebars) | No |

Create from examples: `cp .env.example .env && cp stack.yml.example stack.yml`

**To build deployment artifacts:** `npm run pre-deploy` (or `npm run pre-deploy:dry` to preview)

See `.env.example` for secrets/VPS fields. See `stack.yml.example` for stack structure. Per-claw config lives in `stack.yml` under `claws.<name>` — deep-merged with `defaults`.

SSH_USER and SSH_PORT in `.env` start as provider defaults (e.g., `ubuntu`/`22`) and are changed to `adminclaw`/`SSH_HARDENED_PORT` during hardening.

---

## Setup Question Flow

**ALWAYS start this flow when the user's intent is ambiguous or general** (e.g., "hi", "start", "let's go", "help me"). Also start when the user explicitly requests deployment or mentions VPS work. This is the default entry point.

**If user says "onboard":** Follow [00-onboarding.md](playbooks/00-onboarding.md) for guided first-time configuration. This is for new users who ran `install.sh` and need to configure their stack.

1. Check `.env` exists. If missing, offer to `cp .env.example .env && cp stack.yml.example stack.yml`.
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
ssh -i <SSH_KEY:~/.ssh/vps1_openclaw_ed25519> -p <SSH_PORT:222> <SSH_USER:adminclaw>@<VPS_IP>

# Run commands as openclaw
sudo -u openclaw <command>

# Interactive shell as openclaw
sudo su - openclaw
```

### Service Management

All docker compose commands run as openclaw (adminclaw can't cd into openclaw's home):

```bash
# Main compose project — starts all claws (+ Vector when stack.logging.vector: true):
# Pattern: sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose <cmd>'
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'       # Start all services
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose ps'           # Status
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose logs -f'      # Follow logs
```

> **Vector** is included in the main compose project when `stack.logging.vector: true` in `stack.yml`.

> **Multi-claw:** `docker compose up -d` starts ALL claws. To target one: `docker compose restart <project>-openclaw-<name>`. Use `openclaw --instance <name> <cmd>` for per-claw CLI commands.

> **Note:** Docker Compose warns about unset `CLAUDE_AI_SESSION_KEY`/`CLAUDE_WEB_SESSION_KEY`/`CLAUDE_WEB_COOKIE` — harmless, these are optional.

> **`restart` vs `up -d`:** `restart` does NOT reload `.env` values (baked at container creation). Use `up -d <service>` after `.env` changes. `restart` is fine for bind-mounted file changes (read from disk at startup).
