# OpenClaw VPS Stack

Automated deployment of [OpenClaw](https://docs.openclaw.ai) stacks on a single VPS, orchestrated by Claude Code. Cloudflare Workers handle LLM proxying and log aggregation.

All provider API keys are kept safely off of the VPS and out of OpenClaw's reach. Each claw runs
in an isolated container with its own resources and config.

## What's Included

- **[CLAUDE.md](CLAUDE.md) & [playbooks](playbooks/)** — deployment instructions for Claude Code
- **[Deploy tools](deploy/) & [scripts](scripts/)** — build scripts, plugins, and local CLI helpers
- **[Cloudflare Workers](workers/)** — AI Gateway (LLM proxy + KV auth) and Log Receiver

## Quick Start

**Option A: Guided setup (recommended)**

```bash
# Interactive bash script clones the repo & sets up SSH access
# Then runs `claude "onboard"`
bash <(curl -fsSL https://raw.githubusercontent.com/simple10/openclaw-stack/main/install.sh)
```

**Option B: Manual**

```bash
git clone git@github.com:simple10/openclaw-stack.git openclaw-stack
cd openclaw-stack
cp .env.example .env && cp stack.yml.example stack.yml

# Edit .env and stack.yml with your values

# Run claude with "start" or "onboard"
# Both work - "onboard" does more hand-holding to help with configuring missing .env settings
claude "start"
```

`npm run pre-deploy` builds `.deploy/` from `.env` + `stack.yml` + `docker-compose.yml.hbs`. Claude reads the playbooks and executes them step-by-step over SSH. First deploy takes ~30 minutes.

## Requirements

- **[Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code/overview)** — Pro/Max subscription
- **VPS** — Ubuntu 24.04+, kernel 5.12+, minimum 4 GB RAM / 2 vCPUs (8 GB+ / 4+ recommended)
- **[Cloudflare account](https://dash.cloudflare.com/sign-up)** — (free tier) with a domain managed in Cloudflare DNS

## Features

<p align="center"><em>Mission Control — agent browsers, cost tracking, and gateway stats</em></p>
<p align="center">
  <img src="docs/assets/screenshot-mission-control.png" alt="Mission Control Dashboard" width="700">
</p>

**Easy Browser Access**

- Each agent gets its own browser sandbox
- Access the browser via noVNC in the dashboard
- Easy management of browser auth - just login to a site in the agent browser
- OpenClaw never needs your website credentials

<p align="center"><em>Host Alerter — daily health summary and real-time alerts via Telegram</em></p>
<p align="center">
  <img src="docs/assets/telegram-host-alerter-report.png" alt="Host Alerter Telegram Report" width="400">
</p>

- **Multi-claw Stacks** — Run multiple OpenClaw instances on one VPS, each in its own Sysbox container with dedicated resources, Telegram bot, and subdomain
- **AI Gateway Proxy** — Cloudflare Worker proxies LLM requests to Anthropic/OpenAI with per-user KV credentials. API keys never touch the VPS. Self-service `/config` UI for credential management
- **LLM Observability** — Structured logging via Vector to Cloudflare Workers, with optional Langfuse tracing for cost and latency analysis
- **Egress Proxy** — Optional sidecar that routes requests through the VPS IP to bypass WAF blocks on Cloudflare Worker IPs (e.g., ChatGPT Codex)
- **Claude-driven Deployment & Maintenance** — Modular playbooks that Claude Code executes step-by-step. First deploy ~30 minutes, mostly hands-off

## Architecture

This project deploys OpenClaw stacks to a VPS or dedicated server.

Multiple stacks can run on the same VPS. Each stack can contain multiple claws.

```text
                       Cloudflare
                           |
          +----------------+----------------+
          |                |                |
      Tunnel          AI Gateway       Log Receiver
      (HTTPS)         Worker           Worker
          |           (LLM proxy)      (log ingest)
          v               ^                ^
  +---------------------------------------------------+
  |  VPS — OpenClaw Stack (docker compose)            |
  |                                                   |
  |  +-- openclaw-claw (Sysbox) -----------------+    |
  |  |  Gateway process           :18789         |    |
  |  |  Dashboard                 :6090          |    |
  |  |  Nested Docker daemon                     |    |
  |  |    -> sandbox containers (per agent)      |    |
  |  |    -> browser container  (noVNC)          |    |
  |  +-------------------------------------------+    |
  |  +-- openclaw-* (optional) ------------------+    |
  |  |  Run any number of additional             |    |
  |  |  claws via stack.yml                      |    |
  |  +-------------------------------------------+    |
  |                                                   |
  |  cloudflared        tunnel connector              |
  |  host-alert.sh      cron monitoring               |
  |  egress-proxy       WAF bypass (optional)         |
  |  vector             docker log shipper (optional) |
  |  sandbox-registry   local docker hub (optional)   |
  +---------------------------------------------------+
```

- All claws in the stack are isolated from each other in their own docker container.
- Sysbox manages permissions & enables OpenClaw to efficiently spawn agent sandbox containers.
- No ports are exposed to the public internet.
- All traffic flows through the Cloudflare Tunnel (outbound-only). SSH is the only open firewall port.
- LLM provider API keys are stored as Cloudflare KV secrets and injected at the edge.
- Optional sandbox-registry shares base sandbox images to speed up per-claw build time.

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
claude
```

> Update OpenClaw to the latest version
>
> Run the verification tests
>
> Show me the gateway logs
>
> Help me pair a new browser with the gateway

### Helper Scripts

Local CLI scripts for common tasks without Claude:

```bash
./scripts/openclaw.sh doctor --deep    # Run OpenClaw CLI commands via SSH
./scripts/health-check.sh             # Docker and gateway health
./scripts/ssh-vps.sh                  # SSH to VPS host
./scripts/ssh-openclaw.sh             # SSH into gateway container
./scripts/logs-explorer.sh            # TUI for browsing openclaw logs
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
| [Codex Subscription](docs/CODEX-SUBSCRIPTION.md) | Using OpenAI Codex subscription tokens with OpenClaw |
| [Security](docs/SECURITY.md) | Full security model: network, auth, device pairing, containers |
| [Testing](docs/TESTING.md) | End-to-end verification (SSH + browser via DevTools MCP) |

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
