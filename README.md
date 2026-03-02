# OpenClaw Single-VPS Deployment

Automated deployment of [OpenClaw](https://docs.openclaw.ai) on a single VPS, orchestrated by Claude Code. Cloudflare Workers handle LLM proxying and log aggregation. Sysbox provides secure Docker-in-Docker sandboxing.

## What's Included

- **[CLAUDE.md](CLAUDE.md) & [playbooks](playbooks/)** — deployment instructions for Claude Code
- **[Deploy tools](deploy/) & [scripts](scripts/)** — build scripts, plugins, and local CLI helpers
- **[Cloudflare Workers](workers/)** — AI Gateway (LLM proxy + KV auth) and Log Receiver

## Quick Start

**Option A: Let Claude walk you through everything**

```bash
curl -fsSL https://raw.githubusercontent.com/simple10/openclaude/main/docs/CLAUDE_INSTALL.md -o CLAUDE.md
claude "start"
```

**Option B: Clone and go**

```bash
git clone git@github.com:simple10/openclaude.git openclaw-vps
cd openclaw-vps
cp .env.example .env && cp stack.yml.example stack.yml
# Edit .env and stack.yml with your values, or let Claude help:
claude "start"
```

`npm run pre-deploy` builds `.deploy/` from `.env` + `stack.yml` + `docker-compose.yml.hbs`. Claude reads the playbooks and executes them step-by-step over SSH. First deploy takes ~30 minutes.

## Requirements

- **[Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code/overview)** CLI
- **VPS** — Ubuntu 24.04+, kernel 5.12+, minimum 4 GB RAM / 2 vCPUs (8 GB+ / 4+ recommended)
- **[Cloudflare account](https://dash.cloudflare.com/sign-up)** (free tier) with a domain managed in Cloudflare DNS
- **Cloudflare Tunnel** — either a manual `CF_TUNNEL_TOKEN` or a `CF_API_TOKEN` for automated setup

## Architecture

```
                    Cloudflare
                        |
        +---------------+---------------+
        |               |               |
   Tunnel           AI Gateway     Log Receiver
   (HTTPS)          Worker         Worker
        |           (LLM proxy)    (log capture)
        v               ^               ^
  +-------------------------------------+-------+
  |  VPS                                         |
  |                                              |
  |  +-- openclaw-claw (Sysbox) ------------+   |
  |  |  Gateway process (Node.js)            |   |
  |  |  Nested Docker daemon                 |   |
  |  |    -> sandbox containers (per agent)  |   |
  |  |    -> browser container (noVNC)       |   |
  |  +---------------------------------------+   |
  |                                              |
  |  Vector (log shipper)                        |
  |  cloudflared (tunnel connector)              |
  |  host-alert.sh (cron monitoring)             |
  +----------------------------------------------+
```

No ports are exposed to the public internet. The Cloudflare Tunnel uses outbound-only connections. SSH is the only open firewall port.

LLM provider API keys are stored as Cloudflare KV secrets and injected at the edge — they never touch the VPS. After deployment, manage credentials via the self-service config UI at `https://<AI_GATEWAY_WORKER_URL>/config`.

## Configuration

Two config files plus a Handlebars template:

| File | Purpose | Gitignored |
|------|---------|------------|
| `.env` | Secrets & VPS access | Yes |
| `stack.yml` | Stack structure, claw definitions, defaults | Yes |
| `docker-compose.yml.hbs` | Compose template | No |

Create from examples: `cp .env.example .env && cp stack.yml.example stack.yml`

Build deployment artifacts: `npm run pre-deploy` (or `npm run pre-deploy:dry` to preview)

## Day-to-Day Operations

Just use OpenClaw normally. Host alerts notify you via Telegram if something needs attention. Use Claude to troubleshoot or make changes:

```bash
claude "start"
```

> Update OpenClaw to the latest version
> Run the verification tests
> Show me the gateway logs

### Helper Scripts

Local CLI scripts for common tasks without Claude:

```bash
./scripts/openclaw.sh doctor --deep    # Run OpenClaw CLI commands via SSH
./scripts/health-check.sh             # Docker and gateway health
./scripts/ssh-vps.sh                  # SSH to VPS host
./scripts/ssh-openclaw.sh             # SSH into gateway container
./scripts/logs-session.sh             # Chat session logs
./scripts/update-openclaw.sh          # Pull latest + rebuild gateway
./scripts/update-sandbox-toolkit.sh   # Sync toolkit config + rebuild sandbox images
./scripts/restart-sandboxes.sh        # Restart sandbox containers
./scripts/start-browser.sh            # Start browser container, print dashboard URL
./scripts/sync-media.sh               # Sync agent downloads to local machine
```

See comments at the top of each script for flags and options.

### Updating OpenClaw

```bash
# Via Claude:
claude "Update OpenClaw to the latest version"

# Or directly:
./scripts/update-openclaw.sh
```

Updates pull the latest source and rebuild the gateway Docker image with auto-patching.

### Managing Sandbox Tools

Tools available inside agent sandboxes are defined in `openclaw/default/sandbox-toolkit.yaml`. Adding a tool is a one-line YAML edit + `scripts/update-sandbox-toolkit.sh`. See [docs/SANDBOX-TOOLKIT.md](docs/SANDBOX-TOOLKIT.md).

## Documentation

| Guide | Description |
|-------|-------------|
| [VPS Setup Guide](docs/VPS-SETUP-GUIDE.md) | VPS provisioning (OVHCloud example, any provider works) |
| [Cloudflare Tunnel](docs/CLOUDFLARE-TUNNEL.md) | Tunnel, Access, and domain routing setup |
| [AI Gateway Config](docs/AI-GATEWAY-CONFIG.md) | LLM proxy configuration and provider credentials |
| [Dashboard](docs/DASHBOARD.md) | Browser sessions (noVNC), media files, URL routing |
| [Sandbox Toolkit](docs/SANDBOX-TOOLKIT.md) | Adding and managing sandbox tools |
| [Telegram](docs/TELEGRAM.md) | Telegram bot setup for chat and host alerts |
| [Claude Subscription](docs/CLAUDE-SUBSCRIPTION.md) | Using Claude Code subscription tokens with OpenClaw |
| [Security](docs/SECURITY.md) | Full security model: network, auth, device pairing, containers |
| [Testing](docs/TESTING.md) | End-to-end verification (SSH + browser via DevTools MCP) |
| [Claude Install](docs/CLAUDE_INSTALL.md) | Standalone setup assistant (used by Quick Start option A) |

## Security Overview

Defense-in-depth with multiple independent layers:

- **Zero exposed ports** — Cloudflare Tunnel (outbound-only), SSH on non-standard port only
- **Two-user model** — `adminclaw` (SSH/admin with sudo) and `openclaw` (app runtime, no SSH, no sudo)
- **SSH hardened** — key-only auth, fail2ban, modern ciphers, all forwarding disabled
- **Sysbox containers** — secure Docker-in-Docker without `--privileged`, uid remapping
- **Sandboxes** — read-only root, all capabilities dropped, no network (default), PID/memory/CPU limits
- **API key isolation** — LLM keys in Cloudflare KV, never on the VPS
- **Cloudflare Access** — identity-based auth before traffic reaches the VPS
- **Device pairing** — Ed25519 challenge-response protocol for gateway access

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model, cryptographic inventory, and protocol details.

## Testing

```bash
claude "Run the tests in docs/TESTING.md using devtools mcp"
```

Requires [DevTools MCP](https://github.com/anthropics/devtools-mcp) installed in Claude Code.

## Reference

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- [Agents Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.agents.ts)
- [Models Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts)
