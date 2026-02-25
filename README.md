# Claude > Multi OpenClaw > VPS

> [!NOTE]
> This project is in active development. Reach out if you need help.

This project packed full of useful debugging tools to assist you or `claude code` in modifying your OpenClaw setup.

It enables automated deployment of one or more OpenClaw instances to a single VPS.

OpenClaw gateways are run inside of a Docker container for isolation from other claws & services.

Sysbox runtime is used to enable the OpenClaw gateway containers to securely & efficiently spin up agent sandboxes.

---

**About this project:**

This repo enables `claude code` to securely deploy & maintain [OpenClaw](https://docs.openclaw.ai) on your own VPS.

**What's included:**

- [CLAUDE.md](CLAUDE.md) & [playbooks](playbooks/)
  - Carefully designed instructions for claude to follow
- [Tools](deploy/) & [scripts](scripts/)
  - OpenClaw plugins & build scripts
- [Cloudflare Workers](workers/)
  - for logging & LLM proxy (no API keys stored on the VPS)

OpenClaw gets wrapped with production-grade infrastructure: SSH hardening, firewall rules, Docker-in-Docker sandboxing via [Sysbox](https://github.com/nestybox/sysbox), Cloudflare Tunnel for zero-exposed-port networking, and a Cloudflare Worker proxy that keeps your real API keys off the server entirely.

**Quick install:**

```bash
# Interactive claude setup:
curl -fsSL https://raw.githubusercontent.com/simple10/openclaude/main/docs/CLAUDE_INSTALL.md -o CLAUDE.md && claude "start"
```

> Or clone this repo and run `claude "start"`.

## Is this better than one-click VPS installs?

If you already use `claude`, care about security, or like to tinker, this project is worth your time.

There are a lot of power-ups stashed in this repo. It's a batteries included OpenClaw & devops framework.

One-click VPS installs are a great way to get up and running quickly. But then you're left running a fairly insecure
or an overly locked-down OpenClaw setup. This project strikes a nice balance between the two.

Check out this guide on [OpenClaw hosting](https://proclaw.co/resources/openclaw-hosting) for more details.

## What do I need to get started?

1. Claude subscription - Pro/Max for Claude Code
2. Cloudflare Account (free)
3. A Cloudflare Tunnel token **or** API token:
   - **`CF_TUNNEL_TOKEN`** — create a tunnel manually in the [CF Dashboard](https://one.dash.cloudflare.com/) and copy the token
   - **`CF_API_TOKEN`** — create an [API token](https://dash.cloudflare.com/profile/api-tokens) with Tunnel Edit + DNS Edit permissions, and Claude automates the rest (tunnel creation, route config, DNS records)

About 30 min for the first deploy. Claude does a LOT of work on your VPS to get OpenClaw securely deployed.

## What gets deployed?

A secure OpenClaw instance that doesn't limit OpenClaw's ability to function.

**Infrastructure**

- **Zero exposed ports** — Cloudflare Tunnel + Access for secure connectivity, SSH is the only open port
- **Hardened VPS** — non-standard SSH port, key-only auth, fail2ban, UFW firewall, kernel tuning
- **Docker-in-Docker sandboxing** — gateway & agent tools run in their own isolated container via [Sysbox](https://github.com/nestybox/sysbox)
- **API key isolation** — LLM keys stored as Cloudflare Worker secrets, never in OpenClaw or on the VPS

**Multi-Agent**

- **Coordinator plugin** — auto-discovers agent skills and routes tasks to the right agent
- **Per-agent sandboxes** — custom images, network rules, memory limits, and tool permissions per agent
- **Remote browser viewing** — watch and control agent browser sessions via noVNC

**Observability**

- **AI Gateway Worker** — proxies all LLM requests through Cloudflare for analytics and key management
- **Log shipping** — Vector ships container logs to a Cloudflare Log Receiver Worker
- **Host monitoring** — cron-based health checks with Telegram alerts, shared with your OpenClaw so it can self-diagnose
- **Debugging hooks** — Claude Code can read command logs, session transcripts, and LLM traces to troubleshoot issues

## Quick Start

**Use claude to set up your env & clone this repo** (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/simple10/openclaude/main/docs/CLAUDE_INSTALL.md -o CLAUDE.md
claude "start"
```

That's it.

The [CLAUDE_INSTALL.md](docs/CLAUDE_INSTALL.md) file instructs claude on how to walk you through the
required config setup, git clone this repo, and automate the deploy.

### Manual Steps

1. Create a **[new VPS](docs/VPS-SETUP-GUIDE.md)** and set up a [Cloudflare Tunnel](docs/CLOUDFLARE-TUNNEL.md) (manual token or API token)
2. Clone this repo
3. Run `claude` in this repo dir, just say `start`

   ```bash
   git clone git@github.com:simple10/openclaude.git openclaw-vps
   cd openclaw-vps

   # Copy the config template
   cp openclaw-config.env.example openclaw-config.env
   # Edit required config vars or just start claude, it will help you gather requirements

   # Run claude with skip permissions if you want a more automated deploy
   claude --dangerously-skip-permissions "start"

   # Claude will deploy OpenClaw and test the VPS (20+ minutes)
   ```

After successfully deploying OpenClaw, claude assists you in device pairing & accessing the webchat.

## Upgrading or Maintaining Your OpenClaw VPS

After deployment, claude can be used to make any changes or manage your VPS with the same prompt.

```bash
claude "start"
```

Then just chat with claude...

> Please verify the setup and run the end to end tests

> I updated openclaw.json configs, please deploy it to the VPS

> I can't access OpenClaw through the web, please help.

> Please update OpenClaw to the latest version on the VPS

> The agent routing doesn't seem to be working properly. Please check the debug logs and help me fix it.

The playbooks instruct claude on how to detect if you already deployed your VPS.
There are also explicit claude instructions for verifying & maintaining deployments.

If you want more control, see [scripts/](scripts/) dir for CLI helper scripts without using claude.

## Detailed Guides

- **[VPS Setup Guide](docs/VPS-SETUP-GUIDE.md)** - guidance on VPS setup
- **[Cloudflare Tunnel](docs/CLOUDFLARE-TUNNEL.md)** - details on Cloudflare Access & Tunnel setup
- **[Telegram](docs/TELEGRAM.md)** - guide for setting up Telegram bots to use with OpenClaw
- **[Claude Subscription](docs/CLAUDE-SUBSCRIPTION.md)** - info on using OpenClaw with a claude subscription
- **[Security](docs/SECURITY.md)** - in depth details on the security layers
- See [docs/](docs/) for more guides

## What happens during deploy

Claude reads the [playbooks](playbooks/) and executes them step-by-step over SSH:

1. **Cloudflare Workers** — deploys the AI Gateway proxy and Log Receiver (~2 min)
2. **VPS hardening** — creates users, hardens SSH, configures firewall and fail2ban (~3 min)
3. **Docker + Sysbox** — installs the container runtime with security hardening (~3 min)
4. **OpenClaw deployment** — builds the Docker image, starts the gateway and Vector log shipper, builds sandbox images (base, packages, toolkit with 25+ tools, browser with noVNC) (~15 min on first boot)
5. **Backups** — configures automated backup scripts (~1 min)
6. **Reboot + verification** — reboots to confirm everything auto-starts, runs security audit (~3 min)
7. **Post-deploy** — helps you configure Cloudflare Tunnel routes and pair your first device

Total time: **~30 minutes** for a fresh deployment. Subsequent restarts are much faster since sandbox images are cached.

---

## How This OpenClaw Setup Works

OpenClaw uses a multi-agent architecture where a main "coordinator" agent delegates tasks to specialized sub-agents:

```
User message
  -> Gateway (single process, makes all LLM API calls)
       -> Main agent (coordinator, routes tasks)
            -> Code agent (development tools, Claude Code CLI)
            -> Skills agent (gifgrep, weather, web tools, etc.)
```

**Agents are not separate processes.** An "agent" is a configuration profile — a sandbox image, network rules, memory limits, and tool permissions. The gateway process makes all LLM API calls itself and runs tool calls inside the agent's sandbox container via `docker exec`.

Each agent runs tools inside an isolated Docker container (via Sysbox for secure Docker-in-Docker). LLM provider API keys are stored as Cloudflare Worker secrets — they never touch the VPS. For details on how requests flow through the system, see [docs/REQUEST-FLOW.md](docs/REQUEST-FLOW.md).

---

## Architecture

```
                    Cloudflare
                        |
        +---------------+---------------+
        |               |               |
   Tunnel           AI Gateway     Log Receiver
   (HTTPS)          Worker         Worker
        |           (LLM proxy)    (log capture)
        |               ^               ^
        v               |               |
  +-------------------------------------+-------+
  |  VPS                                         |
  |                                              |
  |  +-- openclaw-main-claw (Sysbox) --------+   |
  |  |  Gateway process (Node.js)            |   |
  |  |  Nested Docker daemon                 |   |
  |  |    -> sandbox containers (per agent)  |   |
  |  |    -> browser container (noVNC)       |   |
  |  +---------------------------------------+   |
  |                                              |
  |  Vector (log shipper)                        |
  |  cloudflared (tunnel connector)              |
  |  host-alert.sh (cron monitoring)             |
  |                                              |
  |  Port 443: CLOSED                            |
  |  Port 80:  CLOSED                            |
  |  All gateway ports: 127.0.0.1 only           |
  +----------------------------------------------+
```

| Component | Location | Purpose |
|-----------|----------|---------|
| Gateway | VPS (Sysbox container) | OpenClaw runtime — manages agents, makes LLM calls, runs tools in sandboxes |
| Vector | VPS (separate compose project) | Ships container logs to Cloudflare Log Receiver Worker (optional) |
| AI Gateway Worker | Cloudflare | Proxies LLM requests, injects API keys, provides analytics |
| Log Receiver Worker | Cloudflare | Captures and stores container logs |
| Cloudflare Tunnel | VPS -> Cloudflare | Outbound-only connection — no exposed ports, hidden origin IP |
| host-alert.sh | VPS (cron) | Monitors disk, memory, CPU; sends Telegram alerts |

**No ports are exposed to the public internet.** The Cloudflare Tunnel uses outbound-only connections. SSH is the only port open on the firewall.

---

## Requirements

- **[Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code/overview)** — the CLI tool that runs the deployment
- **VPS**
  - Minimum: 4 GB RAM, 2 vCPUs
  - Recommended: 8 GB+ RAM, 4+ vCPUs (the gateway, nested Docker, and sandbox images need room)
  - Linux with kernel 5.12+ (needed for Sysbox). Ubuntu 24.04+ or Debian 13+ recommended
  - SSH access with a key (Claude needs to SSH into the server as root initially)
- **[Cloudflare Account](https://dash.cloudflare.com/sign-up)** (free tier works) — for the tunnel and workers
- **Domain** — any domain or subdomain managed in Cloudflare DNS

---

## Configuration

### The config file

All deployment settings live in `openclaw-config.env`. The example file documents every field:

```bash
cp openclaw-config.env.example openclaw-config.env
```

You can prepopulate the config file or claude will ask for any missing required settings.

### Configuring LLM API keys

After deployment, add your LLM provider API keys to the Cloudflare Worker (not the VPS):

```bash
cd workers/ai-gateway
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY    # if using OpenAI models
```

These keys are stored only in Cloudflare and never touch the VPS. See [docs/POST-DEPLOY.md](docs/POST-DEPLOY.md) for details.

---

## Accessing OpenClaw Control UI (chat & config dashboard)

There are two main UIs provided by this setup:

1. OpenClaw Control UI: `https://openclaw.YOURDOMAIN.com/chat` - chat or change OpenClaw configs
2. Dashboard UI: `https://openclaw.YOURDOMAIN.com/dashboard` - to access the agent browsers or downloaded media files

If you get a `disconnected` error when viewing the Control UI, that means your browser
is not properly paired with OpenClaw. It's a security feature.

Claude guides you through pairing your device during initial deployment.

If you need to re-pair your browser, just ask claude for the URL:

```
> I need to re-pair my device with OpenClaw. Please give me the link.
```

You'll get something like: `https://openclaw.YOURDOMAIN.com/chat?token=GATEWAY_TOKEN`

This opens the OpenClaw web UI where you can start chatting with your agents.

### Remote browser viewing

Agents with browser access run a real Chrome instance (not just headless) in a separate container.

You can watch and control their browser sessions remotely via noVNC:

```
https://openclaw.YOURDOMAIN.com/dashboard
```

See [docs/DASHBOARD.md](docs/DASHBOARD.md) for details.

## Testing

Optionally run end-to-end tests with claude:

```bash
claude "Run the tests in docs/TESTING.md using devtools mcp"
```

Requires [DevTools MCP](https://github.com/anthropics/devtools-mcp) installed in Claude Code.

---

## Day-to-Day Operations

Just use OpenClaw as normal. It will alert you if there's a problem with the VPS.

Then if there's a problem, use claude to fix it.

```
> Show me the gateway status
> Restart the gateway
> Show me the last 50 lines of gateway logs
```

### Manually Managing VPS & Gateway

```bash
# SSH into the VPS (port changes during hardening — check your config)
ssh -i ~/.ssh/your_key -p 222 adminclaw@YOUR_VPS_IP

# Gateway commands (run as openclaw user)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'          # Status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f'      # Logs
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-main-claw'  # Restart
```

**Or use the helper scripts:**

```bash
# Most of the helper scripts have optional params like `--all` or `--dry-run`
# See comments at the top of each script for details

# Run OpenClaw CLI commands
# SSHs into gateway container to run `openclaw ...`
# Supports all of the openclaw CLI commands
./scripts/openclaw.sh
./scripts/openclaw.sh doctor --deep

# If any OpenClaw CLI commands don't work as expected,
# SSH into the gateway first then run `openclaw`
# Interactive commands sometimes have trouble with SSH -> Docker exec TTY -> openclaw
./scripts/gateway.sh
openclaw doctor --deep

# Health Checks
./scripts/health-check.sh # Show OpenClaw and docker containers health

# SSH
./scripts/ssh-vps.sh # SSH into VPS host
./scripts/ssh-openclaw.sh # SSH into VPS -> exec bash into OpenClaw gateway container
./scripts/ssh-agent.sh # SSH into an agent sandbox - auto starts if not currently running

# Restart
./scripts/restart-gateway.sh
./scripts/restart-sandboxes.sh

# Logs
./scripts/logs-openclaw.sh # Logs from OpenClaw command logger (built-in plugin)
./scripts/logs-docker.sh # Docker container logs, including gateway
./scripts/logs-session.sh # OpenClaw chat session logs - one of the most useful debugging logs

# Browser
./scripts/start-browser.sh # Start a browser container for an agent, print dashboard URL for pre-auth

# Sync browser downloaded media to local host
# Screenshots, PDFs etc. - whatever the agents or browser have downloaded
# Same files visible at /dashboard/media endpoint in web dashboard UI
./scripts/sync-media.sh

#
# Update Containers
#

# Update OpenClaw gateway container
# Pulls latest openclaw source & rebuilds & restarts gateway container
# Expect 5-10 seconds of downtime for the gateway and agent sandboxes
./scripts/update-openclaw.sh

# Update sandbox toolkit — sync config, rebuild images
# Default: detects new/changed tools and quick-layers them (seconds)
# Use --full for a complete rebuild with proper layer ordering
# See deploy/sandbox-toolkit.yaml for tool config
./scripts/update-sandbox-toolkit.sh          # quick (default)
./scripts/update-sandbox-toolkit.sh --full   # full rebuild

# Update and rebuild sandbox containers
./scripts/update-sandboxes.sh
```

### Updating OpenClaw

Updates are done via `git pull` and rebuilding the gateway container on the VPS.
OpenClaw's `openclaw update` command does not work (by design) because the `.git`
directory is not inside the container. It's safer to rebuild on host.

Just tell `claude`:

```text
> Update openclaw to the latest version
```

Claude will pull the latest code, rebuild the Docker image with auto-patching, and restart the gateway.

```bash
# OR use the update script
./scripts/update-openclaw.sh
```

### Managing sandbox tools

The tools available inside agent sandboxes are defined in `deploy/sandbox-toolkit.yaml`.
Adding a tool is a one-line YAML edit + `scripts/update-sandbox-toolkit.sh` — the default quick mode layers the new tool in seconds. See [docs/SANDBOX-TOOLKIT.md](docs/SANDBOX-TOOLKIT.md) for details.

---

## Security

This deployment implements defense-in-depth with multiple independent security layers:

### Network isolation

- **No Exposed Ports** - only SSH on non-standard port is reachable
- **Cloudflare Tunnel** uses outbound-only connections
- **UFW firewall** denies all incoming traffic except the SSH port
- **Docker daemon** binds all container ports to `127.0.0.1` only, preventing Docker's iptables rules from bypassing UFW
- **Gateway ports** (18789, 18790, 6090) are only reachable from localhost — external access goes through the Cloudflare Tunnel

### Access control

- **Two-user model**: `adminclaw` for SSH/admin with passwordless sudo, `openclaw` for app runtime with no SSH and no sudo
- **SSH hardened**: custom port, key-only auth (passwords disabled), restricted to `adminclaw` only, modern ciphers (curve25519, chacha20-poly1305), 3 max auth tries, all forwarding disabled
- **Fail2ban**: bans IPs after 3 failed SSH attempts for 24 hours
- **Cloudflare Access**: optional identity-based authentication layer in front of the tunnel

### Container security

- **Sysbox runtime**: provides secure Docker-in-Docker without `--privileged` mode — user namespace isolation maps container root to an unprivileged host user
- **Read-only root filesystems** with targeted tmpfs mounts for writable paths
- **All capabilities dropped** (`capDrop: ALL`)
- **PID limits** (512 per sandbox, 1024 for gateway) prevent fork bombs
- **Memory and CPU limits** prevent resource exhaustion
- **Internal sandbox network** (`172.31.0.0/24`) is marked `internal` — no external connectivity

### API key isolation

- **Keys stored at the edge**: LLM provider API keys are stored as Cloudflare Worker secrets, never on the VPS
- **Injection at the edge**: the AI Gateway Worker injects keys before forwarding to providers
- **VPS has no direct access**: the VPS only holds an auth token for the Worker, not the actual API keys

### Monitoring

- **Built-in security audit**: `openclaw security audit` checks for misconfigurations
- **Host alerter**: cron job monitors disk, memory, CPU, and container health — sends Telegram alerts
- **Automatic security updates** via unattended-upgrades
- **Kernel hardening**: sysctl tuning for IP spoofing protection, SYN flood mitigation, ASLR, restricted dmesg/kptr access

### OpenClaw Security

- **Containerized gateway** — runs inside its own Sysbox container with no root access to the host
- **Sandboxed agents** — all agent tools are `docker exec`'d into isolated containers with dropped capabilities
- **Isolated browsers** — each agent's browser runs in a separate container
- **No stored API keys** — the gateway only has an auth token for the LLM proxy, never the real provider keys
- **Unprivileged processes** — no root user in the gateway or any agent sandbox
- **Device pairing** - OpenClaw UI requires one-time per device pairing
- **Double auth layer** - Cloudflare Access + OpenClaw device pairing

## Troubleshooting

In general, just chat with claude to troubleshoot. Claude is fully context-aware thanks to the CLAUDE.md and playbooks/

See also [scripts/](./scripts/) for bash utils for SSHing, showing logs, etc.

If you're running into OpenClaw specific bugs, clone the openclaw repo into `./openclaw`.
Then tell claude to scan through the local openclaw code to help you debug.

---

## Repo Files Highlights

```

openclaw-vps/
├── README.md                         # This file
├── CLAUDE.md                         # Deployment orchestration instructions (for Claude)
├── openclaw-config.env               # Your deployment config (secrets, gitignored)
├── openclaw-config.env.example       # Template with all fields documented
│
├── deploy/                           # Files deployed to the VPS
│   ├── openclaws/                    # Per-claw configuration
│   │   ├── _defaults/                # Shared templates (openclaw.json, models.json)
│   │   ├── main-claw/               # Default claw (inherits from openclaw-config.env)
│   │   └── _example/                # Template for creating new claws
│   ├── sandbox-toolkit.yaml          # Sandbox tool definitions
│   ├── vector/                        # Vector log shipper (standalone compose project)
│   │   ├── docker-compose.yml        # Independent of gateway — start/stop separately
│   │   └── vector.yaml               # Log shipper config
│   ├── build-openclaw.sh             # Docker image builder with auto-patching
│   ├── entrypoint-gateway.sh         # Container init (dockerd, sandboxes, privilege drop)
│   ├── rebuild-sandboxes.sh          # Layered sandbox image builder with split config detection
│   ├── host-alert.sh                 # Host monitoring + Telegram alerts
│   ├── dashboard.mjs                 # Dashboard server — browser sessions, media, logs
│   └── logrotate-openclaw            # Log rotation config
│
├── workers/                          # Cloudflare Workers (deployed via wrangler)
│   ├── ai-gateway/                   # LLM proxy — injects API keys, provides analytics
│   └── log-receiver/                 # Log aggregation from Vector
│
├── scripts/                          # Local management scripts
│   ├── update-sandbox-toolkit.sh     # Sync toolkit config and rebuild sandbox images
│   ├── update-sandboxes.sh           # Force-rebuild sandbox images
│   └── restart-sandboxes.sh          # Restart sandbox containers
│
├── docs/
│   ├── VPS-SETUP-GUIDE.md            # VPS provisioning instructions
│   ├── CLOUDFLARE-TUNNEL.md          # Tunnel and Access setup
│   ├── DASHBOARD.md                  # Details on web server sidecar (noVNC browser, etc.)
│   ├── SANDBOX-TOOLKIT.md            # How to add/manage sandbox tools
│   ├── TELEGRAM.md                   # Telegram integration guide
│   └── TESTING.md                    # End-to-end testing instructions
│
└── playbooks/                        # Deployment playbooks (read by Claude)
    ├── 00-fresh-deploy-setup.md      # Fresh deploy validation and overview
    ├── 00-analysis-mode.md           # Analyze existing deployment
    ├── 01-workers.md                 # Cloudflare Workers deployment
    ├── 02-base-setup.md              # Users, SSH, firewall, kernel hardening
    ├── 03-docker.md                  # Docker + Sysbox installation
    ├── 04-vps1-openclaw.md           # Gateway deployment and configuration
    ├── 06-backup.md                  # Automated backup setup
    ├── 07-verification.md            # Security audit and service verification
    ├── 08a-configure-llm-proxy.md     # AI proxy provider key setup
    ├── 08b-pair-devices.md            # Browser & Telegram device pairing
    ├── 08c-deploy-report.md           # Deployment report generation
    └── maintenance.md                # Token rotation and maintenance procedures

```

---

## Reference

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>

## OpenClaw Config Reference

- [Agents Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.agents.ts)
- [Models Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts)
