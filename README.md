# OpenClaw on VPS

Deploy [OpenClaw](https://github.com/openclaw/openclaw) on a single VPS with Cloudflare for networking and observability — fully automated by [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code/overview).

**This project is an experiment** in using `claude code` for devops. Claude reads modular playbooks, SSHs into your server, and sets up everything from scratch. A significant effort was made to ensure OpenClaw runs as securely as possible without limiting capabilities. However, there's no guarantee Claude will always follow the playbooks as designed.

## What is OpenClaw?

[OpenClaw](https://docs.openclaw.ai) is an open-source AI agent platform. It provides a gateway that manages multiple AI agents, each running in isolated sandbox containers. Agents can use tools (shell, browser, file I/O), delegate tasks to sub-agents, and interact with users through a web dashboard or messaging channels like Telegram and Discord.

This repo wraps OpenClaw with production-grade infrastructure: SSH hardening, firewall rules, Docker-in-Docker sandboxing via [Sysbox](https://github.com/nestybox/sysbox), Cloudflare Tunnel for zero-exposed-port networking, and a Cloudflare Worker proxy that keeps your real API keys off the server entirely.

## Quick Start

You need three things to get started: a VPS, a Cloudflare account, and Claude Code.

### 1. Set up your VPS

Any provider works (OVHCloud, Hetzner, DigitalOcean, AWS EC2, etc.) as long as it meets the [requirements](#requirements). See **[VPS-SETUP-GUIDE.md](docs/VPS-SETUP-GUIDE.md)** for step-by-step instructions.

### 2. Create a Cloudflare Tunnel

The tunnel gives your VPS a public URL without opening any ports. No SSL certificates to manage — Cloudflare handles it.

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels**
2. Click **Create a tunnel** -> Choose **Cloudflared**
3. Name it (e.g., `openclaw`), copy the **tunnel token** (starts with `ey...`)
4. **Skip** the public hostname step for now — save the tunnel without routes

See [docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) for detailed instructions.

### 3. Configure and deploy

```bash
# Clone the repo
git clone git@github.com:simple10/claudiusmaximus.git openclaw-vps
cd openclaw-vps

# Create your config file (only VPS_IP and CF_TUNNEL_TOKEN are required to start)
cp openclaw-config.env.example openclaw-config.env

# Edit with your VPS IP and tunnel token
# Everything else can stay as placeholders — Claude will handle or ask you about them
```

```bash
# Make sure your SSH key is loaded
ssh-add ~/.ssh/your_vps_key

# Start Claude Code in this directory
claude

# Just say:
> start
```

Claude will ask you a few setup questions, then run the full deployment automatically.

### What happens during deploy

Claude reads the [playbooks](playbooks/) and executes them step-by-step over SSH:

1. **Cloudflare Workers** — deploys the AI Gateway proxy and Log Receiver (~2 min)
2. **VPS hardening** — creates users, hardens SSH, configures firewall and fail2ban (~3 min)
3. **Docker + Sysbox** — installs the container runtime with security hardening (~3 min)
4. **OpenClaw deployment** — builds the Docker image, starts the gateway and Vector log shipper, builds three sandbox images (base, common with 25+ tools, browser with noVNC) (~15 min on first boot)
5. **Backups** — configures automated backup scripts (~1 min)
6. **Reboot + verification** — reboots to confirm everything auto-starts, runs security audit (~3 min)
7. **Post-deploy** — helps you configure Cloudflare Tunnel routes and pair your first device

Total time: **~30 minutes** for a fresh deployment. Subsequent restarts are much faster since sandbox images are cached.

### After deployment

Claude can manage your VPS on an ongoing basis. Just open `claude` in this directory and ask:

```
> Restart the openclaw gateway container
> Update openclaw to the latest version
> Show me the gateway logs
> Run the security verification
```

---

## How It Works

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

```
openclaw-sandbox:bookworm-slim              (base: minimal Debian + CLI tools)
  -> openclaw-sandbox-common:bookworm-slim  (+ 25 dev tools via Homebrew, npm, Go, uv)
       -> openclaw-sandbox-browser:bookworm-slim  (+ Chrome + noVNC for visual tasks)
```

Sandboxes have read-only root filesystems, no network access by default (only enabled for specific agents), capped memory/CPU/PIDs, and all capabilities dropped. The main agent's sandbox has no network access at all — it delegates network-requiring tasks to sub-agents.

For details on how requests flow through the system, see [docs/REQUEST-FLOW.md](docs/REQUEST-FLOW.md).

### API key isolation

LLM provider API keys (Anthropic, OpenAI) are stored as Cloudflare Worker secrets — they never touch the VPS. All AI requests route through the AI Gateway Worker proxy, which injects the real API key before forwarding to the provider.

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

**Only two fields are required to start a fresh deployment:**

| Field | Description | Example |
|-------|-------------|---------|
| `VPS1_IP` | Your server's IP address | `203.0.113.42` |
| `CF_TUNNEL_TOKEN` | Cloudflare Tunnel token (from step 2 above) | `eyJhIjoiYWJj...` |

Everything else has sensible defaults or is handled automatically:

- **SSH settings** default to `admin` on port `22` (standard for fresh VPS). Claude changes these to `adminclaw` on a custom port during hardening.
- **Worker URLs** — if left as placeholders, Claude auto-deploys the workers and fills them in.
- **Domain config** — deferred until post-deploy when you set up Cloudflare Tunnel routes.
- **Telegram/Discord/Slack** — optional messaging integrations, leave blank if not using.

### Configuring LLM API keys

After deployment, add your LLM provider API keys to the Cloudflare Worker (not the VPS):

```bash
cd workers/ai-gateway
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY    # if using OpenAI models
```

These keys are stored only in Cloudflare and never touch the VPS. See [docs/POST-DEPLOY.md](docs/POST-DEPLOY.md) for details.

---

## Post-Deployment

### 1. Configure Cloudflare Tunnel routes

After deployment, you need to connect your domain to the tunnel. See [docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) for step-by-step instructions on:

- Adding public hostname routes
- Setting up Cloudflare Access (authentication layer)
- Configuring the browser VNC path (`/browser`)

### 2. Access the OpenClaw dashboard

Ask Claude for the URL:

```
> Please give me the OpenClaw url with the token
```

You'll get something like: `https://openclaw.yourdomain.com/chat?token=GATEWAY_TOKEN`

This opens the OpenClaw web UI where you can start chatting with your agents.

### 3. Remote browser viewing

Agents with browser access run a headless Chrome instance. You can watch and control their browser sessions remotely via noVNC:

```
https://openclaw.yourdomain.com/browser
```

See [docs/BROWSER-VNC.md](docs/BROWSER-VNC.md) for details.

### 4. Testing

Optionally run end-to-end tests:

```
> Run the tests in docs/TESTING.md using devtools mcp
```

Requires [DevTools MCP](https://github.com/anthropics/devtools-mcp) installed in Claude Code.

---

## Day-to-Day Operations

### Managing the gateway

```bash
# SSH into the VPS (port changes during hardening — check your config)
ssh -i ~/.ssh/your_key -p 222 adminclaw@YOUR_VPS_IP

# Gateway commands (run as openclaw user)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'          # Status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f'      # Logs
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'  # Restart
```

Or just ask Claude:

```
> Show me the gateway status
> Restart the gateway
> Show me the last 50 lines of gateway logs
```

### Updating OpenClaw

Updates are done via `git pull` and rebuild on the VPS (the container's `openclaw update` command doesn't work because the `.git` directory isn't inside the container):

```
> Update openclaw to the latest version
```

Claude will pull the latest code, rebuild the Docker image with auto-patching, and restart the gateway.

### Managing sandbox tools

The tools available inside agent sandboxes are defined in `deploy/sandbox-toolkit.yaml`. See [docs/SANDBOX-TOOLKIT.md](docs/SANDBOX-TOOLKIT.md) for how to add, update, or remove tools.

---

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

### Can't access OpenClaw after deployment

1. **Check the tunnel is running**: `sudo systemctl status cloudflared`
2. **Check Cloudflare Tunnel routes** are configured in the Zero Trust dashboard (this is a post-deploy step)
3. **Verify the gateway is healthy**: `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'`
4. **Check the gateway token** matches what's in the URL

### Gateway shows "unhealthy" in Docker

This is normal during first boot — the gateway takes ~14 minutes to build three sandbox images on first start. The Docker healthcheck has a 5-minute start period, so it may report unhealthy while images are still building. Check the logs:

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs -f openclaw-gateway'
```

Look for `Executing as node` — that means initialization is complete.

### Sysbox installation fails

On Debian, Sysbox may fail with a missing `rsync` dependency. Fix it with:

```bash
sudo apt --fix-broken install
```

The playbook handles this automatically, but if you're troubleshooting manually, this is the fix.

### Sandbox build timeout

The first boot builds three sandbox images (base, common with 25+ dev tools, browser with Chrome). This can take 15+ minutes on slower VPS hardware. If it times out, the gateway will still start — sandbox builds are non-fatal. Check the entrypoint logs and re-trigger with:

```bash
sudo docker exec openclaw-gateway /app/deploy/rebuild-sandboxes.sh --force
```

### Logs not appearing in Cloudflare

1. Check Vector is running: `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose logs vector'`
2. Check the Log Receiver Worker: `curl https://YOUR_LOG_WORKER_URL/health`
3. Check Cloudflare Workers dashboard for errors

### SSH locked out

If you get locked out after SSH hardening, use your VPS provider's web console (VNC/KVM) to log in with the emergency password that was set during user creation. Then check `/etc/ssh/sshd_config.d/hardening.conf` for the correct port and settings.

---

## File Structure

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
│   ├── REQUEST-FLOW.md               # How requests flow through the system
│   ├── POST-DEPLOY.md                # Optional post-deploy configuration
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

## Support

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>

## OpenClaw Config Reference

- [Agents Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.agents.ts)
- [Models Config](https://github.com/openclaw/openclaw/blob/main/src/config/types.models.ts)

## Skills, Plugins & Tools

- <https://github.com/lekt9/unbrowse-openclaw> — auto-generates API skills from browser sessions
- <https://github.com/jovanSAPFIONEER/Network-AI>
- <https://docs.openclaw.ai/prose>

## Resources

- <https://deepwiki.com/openclaw/openclaw>
- <https://openclaw.dog/docs/concepts/multi-agent/>
- <https://github.com/VoltAgent/awesome-openclaw-skills>
- <https://github.com/lekt9/openclaw-foundry>
- <https://gist.github.com/simple10/50b9d5fdaf0a12162c2a682c1f7e2391>
- <https://github.com/knostic/openclaw-telemetry/>
- <https://github.com/knostic/openclaw-shield>
- <https://www.knostic.ai/blog/why-we-built-openclaw-shield-securing-ai-agents-from-themselves>
- <https://gist.github.com/simple10/7a91c7471fb543bf0a75341cb2367622>

## Guides & Videos

- <https://www.youtube.com/watch?v=3GrG-dOmrLU> — ideas on using Telegram groups for topics

## Related Apps & Tools

- <https://www.easyclaw.app/docs/privacy>
- <https://seqpu.com/mco>
