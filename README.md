# Claude > OpenClaw > VPS

**About this project:**

This repo enables `claude code` to securely deploy & maintain [OpenClaw](https://docs.openclaw.ai) on your own VPS.

**What's included:**

- [CLAUDE.md](CLAUDE.md) & [playbooks](playbooks/)
  - Carefully designed instructions for claude to follow
- [Tools](deploy/) & [script](scripts/)
  - OpenClaw plugins & build scripts
- [Cloudflare Workers](workers/)
  - for logging & LLM proxy (no API keys stored on the VPS)

OpenClaw gets wrapped with production-grade infrastructure: SSH hardening, firewall rules, Docker-in-Docker sandboxing via [Sysbox](https://github.com/nestybox/sysbox), Cloudflare Tunnel for zero-exposed-port networking, and a Cloudflare Worker proxy that keeps your real API keys off the server entirely.

> Claude automates it all for you.
>
> **Just clone the repo & run `claude "start"`**
>

## Is this better than one-click VPS installs?

If you already use `claude`, care about security, or like to tinker, this project is worth your time.

There are a LOT of power-ups stashed in this repo. It's a batteries included OpenClaw & devops framework.

One-click VPS installs are a great way to get up and running quickly. But then you're left running a fairly insecure
or an overly locked-down OpenClaw setup. This project strike a nice balance between the two.

Check out this guide on [OpenClaw hosting](https://proclaw.co/resources/openclaw-hosting) for more details.

## What do I need to get started?

- Claude Code subscription
- Cloudflare Account (free)
- 30 min of free time - claude does a LOT of work on your VPS to get OpenClaw securely deployed

## What gets deployed?

A secure OpenClaw instance that doesn't limit OpenClaw's ability to function.

- Hardened VPS with no exposed public ports other than SSH
- Cloudflare Tunnel + Cloudflare Access to easily & securely connect to your OpenClaw
- OpenClaw Gateway running in a Docker container
- Agents run in their own container sandboxes (can be locked down per agent)
- No LLM API Keys stored on the VPS or OpenClaw
- Coordinator plugin that assists OpenClaw in routing to agents per skill or capabilities
- Debugging hooks that assists Claude Code in debugging everything
- Lightweight node server for securely accessing agent browser sessions and downloaded media
- Full lightweight observability stack:
  - Vector for log shipping
  - Cloudflare Workers:
    - AI Gateway Proxy Worker - stores your LLM API keys & can log all LLM traffic
    - Log Receiver Worker to receive system logs from multiple VPS (optional)
  - Host alerter script
    - Monitors VPS health - sends you daily reports over Telegram, detects if OpenClaw is down
    - Shares reports with your OpenClaw
    - OpenClaw cron job runs daily to read reports:
      - Notifies you of issues like outdated packages
      - Includes instructions how to fix them - you can also just chat with OpenClaw about the issue

OpenClaw gateway runs inside of it's own Docker container and uses sysbox to properly spawn agent containers.

The gateway can auto update it's container contents (update or repair OpenClaw code & agent sandboxes)
but has no root access to the VPS. i.e. It can't jailbreak itself.

You can also easily customize or lockdown the gateway and individual agent sandboxes.

## Quick Start

**Use claude to setup your env & clone this repo** (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/simple10/openclaude/main/docs/CLAUDE_INSTALL.md -o CLAUDE.md
claude "start"
```

That's it.

The [CLAUDE_INSTALL.md](docs/CLAUDE_INSTALL.md) file instructs claude on how to walk you through the
required config setup, git clone this repo, and automate the deploy.

### Manual Steps

1. Create a **[new VPS](docs/VPS-SETUP-GUIDE.md)** and [Cloudflare Tunnel](docs/CLOUDFLARE-TUNNEL.md)
2. Clone this repo
3. Run `claude` in this repo dir, just say `start`

   ```bash
   git clone <git@github.com>:simple10/openclaude.git openclaw-vps
   cd openclaw-vps

   # Run claude with skip permissions if you want a more automated deploy
   claude --dangerously-skip-permissions "start"

   # Claude will deploy OpenClaw and test the VPS (20+ minutes)
   ```

After successfully deploying OpenClaw to your VPS, claude assists you in OpenClaw device pairing.

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

The playbooks instruct claude on how to detect if you already deployment your VPS.
There are also explicit claude instructions for verifying & maintaining deployments.

If you want more control, see [scripts/](scripts/) dir for CLI helper scripts without using claude.

## Detailed Guides

- **[VPS Setup Guide](docs/VPS-SETUP-GUIDE.md)** - guidance on VPS setup
- **[Cloudflare Tunnel](docs/CLOUDFLARE-TUNNEL.md)** - details on Cloudflare Access & Tunnel setup
- **[Telegram](docs/TELEGRAM.md)** - guide for setting up Telegram bots to use with OpenClaw
- **[Claude Subscription](docs/CLAUDE-SUBSCRIPTION.md)** - info on using OpenClaw with a claude subscription
- See [docs/](docs/) for more guides

## Key Features

- **Fully automated deployment**
   — Claude Code runs modular playbooks to set up the entire VPS from scratch
- **Single VPS**
   — gateway, sandboxes, and log shipping all run on one server
- **Cloudflare Tunnel**
   — zero exposed ports, hidden origin IP, no SSL certificates to manage
- **AI Gateway Worker**
   — all LLM requests proxy through a worker for observability & API key management; real API keys never touch the VPS
- **Log shipping**
   — Vector ships container logs to a Cloudflare Log Receiver Worker
- **Host monitoring**
   — cron-based alerts for disk, memory, and CPU via Telegram
- **Automated backups**
   — scheduled backup scripts with cron
- **Browser viewing**
   — view and control agent browser sessions remotely via [noVNC proxy](docs/BROWSER-VNC.md)
- **Ongoing management**
   — use Claude Code for day-to-day VPS operations after deploy

## Security

- **Sysbox sandboxing**
   — agent code executes in isolated Docker-in-Docker containers
- **API key isolation**
   — LLM provider keys stored as Cloudflare Worker secrets, not on the VPS
- **Cloudflare Access**
   — optional authentication layer in front of the tunnel
- **No exposed ports**
   — Cloudflare Tunnel uses outbound-only connections; SSH is the only public port
- **SSH hardened**
   — non-standard port (222), key-only auth, restricted ciphers, fail2ban
- **Two-user model**
   — `adminclaw` (SSH/sudo) and `openclaw` (app runtime, no SSH, no sudo)
- **UFW firewall**
   — only SSH allowed; all other inbound ports closed
- **Docker localhost binding**
   — daemon configured to bind container ports to 127.0.0.1 only, preventing Docker's iptables rules from bypassing UFW
- **Kernel hardening**
   — sysctl tuning and automatic security updates
- **Security audit**
   — built-in `openclaw security audit` checks for misconfigurations; claude runs comprehensive verifications & security checks during deploy

## What happens during deploy

Claude reads the [playbooks](playbooks/) and executes them step-by-step over SSH:

1. **Cloudflare Workers** — deploys the AI Gateway proxy and Log Receiver (~2 min)
2. **VPS hardening** — creates users, hardens SSH, configures firewall and fail2ban (~3 min)
3. **Docker + Sysbox** — installs the container runtime with security hardening (~3 min)
4. **OpenClaw deployment** — builds the Docker image, starts the gateway and Vector log shipper, builds three sandbox images (base, common with 25+ tools, browser with noVNC) (~15 min on first boot)
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

### Sandbox isolation

Each agent runs tools inside an isolated Docker container (via Sysbox for secure Docker-in-Docker):

For details on how requests flow through the system, see [docs/REQUEST-FLOW.md](docs/REQUEST-FLOW.md).

### API key isolation

LLM provider API keys (Anthropic, OpenAI) are securely stored as secrets on your Cloudflare Worker — they never touch the VPS. All AI requests route through the AI Gateway Worker proxy, which injects the real API key before forwarding to the provider.

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
  |  +-- openclaw-gateway (Sysbox) ----------+   |
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
| Vector | VPS (container) | Ships container logs to Cloudflare Log Receiver Worker |
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

There are two main UI's provided by this setup:

1. OpenClaw Control UI: <https://openclaw.yourdomain.com/chat> - chat or change OpenClaw configs
2. Browser Proxy: <https://openclaw.yourdomain.com/browser> - to access the agent browsers or downloaded media files

If you get a `disconnected` error when viewing the Control UI, that means your browser
is not properly paired with OpenClaw. It's a security feature.

Claude guides you through pair your device during initial deployment.

If you need to re-pair your browser, just ask claude for the URL:

```
> I need to repair my device with OpenClaw. Please give me the link.
```

You'll get something like: `https://openclaw.yourdomain.com/chat?token=GATEWAY_TOKEN`

This opens the OpenClaw web UI where you can start chatting with your agents.

### Remote browser viewing

Agents with browser access run a real Chrome instance (not headless) in a separate container.

You can watch and control their browser sessions remotely via noVNC:

```
https://openclaw.yourdomain.com/browser
```

See [docs/BROWSER-VNC.md](docs/BROWSER-VNC.md) for details.

## 4. Testing

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

### Manually Managing the Gateway

```bash
# SSH into the VPS (port changes during hardening — check your config)
ssh -i ~/.ssh/your_key -p 222 adminclaw@YOUR_VPS_IP

# Gateway commands (run as openclaw user)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'          # Status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f'      # Logs
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'  # Restart
```

### Updating OpenClaw

Updates are done via `git pull` and rebuild on the VPS (the container's `openclaw update` command doesn't work because the `.git` directory isn't inside the container).

Just tell `claude`:

```
> Update openclaw to the latest version
```

Claude will pull the latest code, rebuild the Docker image with auto-patching, and restart the gateway.

### Managing sandbox tools

The tools available inside agent sandboxes are defined in `deploy/sandbox-toolkit.yaml`. See [docs/SANDBOX-TOOLKIT.md](docs/SANDBOX-TOOLKIT.md) for how to add, update, or remove tools.

## Security

This deployment implements defense-in-depth with multiple independent security layers:

### Network isolation

- **Cloudflare Tunnel** uses outbound-only connections from the VPS — no inbound ports exposed except SSH
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

- LLM provider API keys are stored as Cloudflare Worker secrets, never on the VPS
- The AI Gateway Worker injects keys at the edge before forwarding to providers
- The VPS only has an auth token for the Worker, not the actual API keys

### Monitoring

- **Built-in security audit**: `openclaw security audit` checks for misconfigurations
- **Host alerter**: cron job monitors disk, memory, CPU, and container health — sends Telegram alerts
- **Automatic security updates** via unattended-upgrades
- **Kernel hardening**: sysctl tuning for IP spoofing protection, SYN flood mitigation, ASLR, restricted dmesg/kptr access

---

## Troubleshooting

In general, just chat with claude to troubleshoot. Claude is fully context aware thanks to the CLAUDE.md and playbooks/

See also [scripts/](./scripts/) for bash utils for SSHing, showing logs, etc.

---

## File Structure Highlights

```
openclaw-vps/
├── README.md                         # This file
├── CLAUDE.md                         # Deployment orchestration instructions (for Claude)
├── REQUIREMENTS.md                   # Architecture reference and design decisions
├── openclaw-config.env               # Your deployment config (secrets, gitignored)
├── openclaw-config.env.example       # Template with all fields documented
│
├── deploy/                           # Files deployed to the VPS
│   ├── docker-compose.override.yml   # Container config (Sysbox, resource limits, ports)
│   ├── openclaw.json                 # Gateway config (agents, plugins, security)
│   ├── models.json                   # AI provider routing (baseUrl overrides)
│   ├── sandbox-toolkit.yaml          # Sandbox tool definitions
│   ├── vector.yaml                   # Log shipper config
│   ├── build-openclaw.sh             # Docker image builder with auto-patching
│   ├── entrypoint-gateway.sh         # Container init (dockerd, sandboxes, privilege drop)
│   ├── rebuild-sandboxes.sh          # Sandbox image builder with config detection
│   ├── host-alert.sh                 # Host monitoring + Telegram alerts
│   ├── novnc-proxy.mjs              # Browser session reverse proxy
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
│   ├── BROWSER-VNC.md                # Remote browser viewing via noVNC
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
    ├── 08-post-deploy.md             # Domain, tunnel routes, device pairing
    └── maintenance.md                # Token rotation and maintenance procedures
```

---

## Reference

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>

## OpenClaw Config Reference

- [Agents Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.agents.ts)
- [Models Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts)
