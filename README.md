# OpenClaw on VPS

This repository contains everything needed to deploy OpenClaw on a single VPS with Cloudflare Workers for observability.

**This project is an experiment** for using `claude code` for devops. A reasonable effort was made to ensure OpenClaw
is running as securely as possible. However, there's no guarantee claude will always follow the playbooks as designed.

Networking uses Cloudflare Tunnel for zero exposed ports and hidden origin IP.

Cloudflare Tunnel requires manual device pairing after initial setup. Claude should run the post deploy playbook
and guide you through the process. It requires visiting the openclaw UI with a token, then approving the request
via the openclaw CLI running on the VPS.

---

## Quick Start

1. Clone this repo
2. Create a new VPS - see **[ovh_setup_guide.md](./ovh_setup_guide.md)** for recommendations
3. Set values in openclaw-config.env
4. Run claude in this project dir and just say `start`

   ```bash
   claude
   # Prompt: 'start'
   ```

   Claude will deploy and test the VPS (10+ minutes)
5. After deploy, claude will guide you through device pairing
6. Start using OpenClaw: `https://openclaw.YOURDOMAIN.com/chat` or via messaging channel (Telegram, etc.)

Claude will interview you for any missing config values and then start the deploy process.
After deployment, claude can be used to make any changes or manage your VPS with the same prompt.

---

## Requirements

- **Claude Code** - used to deploy and manage the VPS
- **VPS**
  - Minimum: 4GB RAM & 2 vCPUS
  - Recommended: 8GB+ RAM & 4+ vCPUS
  - Linux distro with kernel that supports sysbox
    - Minimum: 5.12+ kernel
    - Recommended: Ubuntu 24.04+
  - Root SSH support - claude needs to be able to SSH into the server
- **AI Gateway Worker** - proxies all LLM requests (real API keys live on the Worker, never on the VPS)
- **Domain** - needed for Cloudflare Tunnel
- **Cloudflare Account** - for Workers (log receiver, AI gateway) and Tunnel

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
        |               |               ^
        v               v               |
  +-------------------------------------+-------+
  |  VPS-1: OpenClaw                             |
  |                                              |
  |  Gateway (Sysbox)     Vector (log shipper)   |
  |  Sandboxes            host-alert.sh (cron)   |
  |                                              |
  |  Port 443: CLOSED                            |
  |  Port 80:  CLOSED                            |
  +----------------------------------------------+
```

| Component | Location | Purpose |
|-----------|----------|---------|
| Gateway | VPS-1 | OpenClaw runtime (Sysbox, Docker-in-Docker, sandboxes) |
| Vector | VPS-1 | Ships container logs to Cloudflare |
| AI Gateway Worker | Cloudflare | Proxies LLM requests, analytics |
| Log Receiver Worker | Cloudflare | Captures container logs |
| Cloudflare Tunnel | VPS-1 -> Cloudflare | Zero exposed ports, origin IP hidden |

No ports are exposed to the public internet.

---

## Configuration

### Step 1: Set Up VPS

Any VPS provider can be used as long as they meet the minimum requirements.

Follow the detailed instructions in **[ovh_setup_guide.md](./ovh_setup_guide.md)** to:

1. Create an OVHCloud account
2. Generate a new SSH key
3. Order a VPS - add your public SSH key during checkout
4. Verify SSH access

### Step 2: Create Config Env File

Clone this repo first if you haven't already.

```bash
git clone git@github.com:simple10/claudiusmaximus.git openclaw-vps
cd openclaw-vps
```

Create your openclaw-config.env

```bash
cp openclaw-config.env.example openclaw-config.env
```

Then, add your VPS IP and other values to the config file.

### Step 2.1: Configure AI Gateway & Keys

The AI Gateway Worker proxies all LLM requests through Cloudflare. Real provider API keys are configured as Worker secrets (via `wrangler secret put`) and never stored on the VPS.

- [ ] **AI Gateway Worker URL**: Deploy the Worker first (see `playbooks/01-workers.md`), then set `AI_GATEWAY_WORKER_URL`
- [ ] **AI Gateway Auth Token**: Set `AI_GATEWAY_AUTH_TOKEN` to the Worker's `AUTH_TOKEN` secret
- [ ] **Telegram Bot Token** (optional): Create via [@BotFather](https://t.me/BotFather)
- [ ] **Discord Bot Token** (optional): From [Discord Developer Portal](https://discord.com/developers/applications)
- [ ] **Slack Bot Token** (optional): From [Slack API](https://api.slack.com/apps)

Fill in your actual values in openclaw-config.env.

### Step 2.2: Set Domain

Update `openclaw-config.env` with your domain:

```bash
OPENCLAW_DOMAIN=openclaw.example.com
```

Cloudflare Tunnel is used for networking — no certificates needed. Claude will set up the tunnel during deployment.

### Step 3: Deploy with Claude Code

You're now ready for Claude Code to automate the rest.

1. Ensure your SSH key is loaded:

   ```bash
   ssh-add ~/.ssh/ovh_openclaw_ed25519
   ```

2. Open Claude Code in this directory

   ```bash
   claude
   ```

3. Start chatting with Claude

   > start

[CLAUDE.md](CLAUDE.md) is configured to start an interview process at the start of a conversation.
For future conversations, you can skip the interview by just asking it to perform a specific task.

e.g.
> Restart the openclaw gateway container

### What Claude Code Will Do During Deploy

Claude runs the various [playbooks](/playbooks/) using values from openclaw-config.env

1. **On VPS-1:**
   - System updates and hardening
   - Create dedicated `adminclaw` user
   - Configure UFW firewall
   - Set up Fail2ban
   - Install Docker + Sysbox
   - Deploy OpenClaw gateway container
   - Set up Vector (ships container logs to Cloudflare)
   - Configure Cloudflare Tunnel
   - Configure automated backups
   - Set up host alerter (Telegram notifications)

2. **Cloudflare Workers:**
   - Deploy AI Gateway Worker (LLM proxy + analytics)
   - Deploy Log Receiver Worker (log capture)
   - Configure Cloudflare Health Check

---

## Post-Deployment: Configuration

**If using Cloudflare Tunnel:** see [docs/CLOUDFLARE-TUNNEL.md](docs/CLOUDFLARE-TUNNEL.md) to finish setting up Cloudflare Access.

Cloudflare Access is the gateway that authorizes users to access OpenClaw through the tunnel.

## Post-Deployment: Testing

Optionally ask Claude to run end-to-end tests:

> Run the tests in docs/TESTING.md using devtools mcp

**DevTools MCP** must already be installed and enabled in Claude Code to allow browser automation tests.

## Post-Deployment: Getting Started with OpenClaw

### Access Your OpenClaw Dashboard

Ask claude to give you the OpenClaw admin URL to start chatting with OpenClaw.

> Please give me the OpenClaw url with the token

The URL should look something like: `https://openclaw.YOURDOMAIN.com/chat?token=OPENCLAW_TOKEN`

This will take you to the OpenClaw web UI where you can start the onboarding process.
If you're using Cloudflare Tunnel option, you'll need to [configure the tunnel](docs/CLOUDFLARE-TUNNEL.md)
before the URL will work.

---

## Verification

For comprehensive testing, see **[docs/TESTING.md](./docs/TESTING.md)**.

---

## File Structure

```
openclaw-vps/
├── README.md                 # This file (for users)
├── CLAUDE.md                 # Deployment orchestration (for Claude)
├── REQUIREMENTS.md           # Architecture reference
├── ovh_setup_guide.md        # OVHCloud account setup instructions
├── openclaw-config.env       # Configuration (contains secrets)
├── vector.yaml               # Vector log shipper config (YAML; deployed to VPS)
├── build/
│   ├── build-openclaw.sh     # Build script with auto-patching
│   └── host-alert.sh         # Host monitoring + Telegram alerts
├── workers/
│   ├── ai-gateway/           # Cloudflare AI Gateway proxy worker
│   └── log-receiver/         # Cloudflare log receiver worker
├── docs/
│   ├── CLOUDFLARE-TUNNEL.md  # Cloudflare Tunnel reference
│   └── TESTING.md            # Testing instructions
└── playbooks/                # Deployment playbooks (for Claude)
    ├── 01-workers.md
    ├── 02-base-setup.md
    ├── 03-docker.md
    ├── 04-vps1-openclaw.md
    ├── 05-cloudflare-tunnel.md
    ├── 06-backup.md
    ├── 07-verification.md
    └── 98-post-deploy.md
```

---

## Troubleshooting

### Can't Access OpenClaw

- Verify the gateway token is correct
- Verify networking is correct:
  - Check Cloudflare Access configuration
  - Check tunnel is running: `sudo systemctl status cloudflared`

### Logs Not Appearing in Cloudflare

1. Check Vector is running on VPS-1:

   ```bash
   docker compose logs vector
   ```

2. Check the Log Receiver Worker is healthy:

   ```bash
   curl https://<LOG_WORKER_URL>/health
   ```

3. Check Cloudflare Workers dashboard for errors

---

## Security Notes

- **Two-user model**: `adminclaw` for SSH/admin, `openclaw` for app runtime (no SSH access)
- **SSH uses port 222** (not 22) to avoid bot scanners - always use `-p 222`
- **SSH key-only** - password authentication is disabled
- **Adminclaw user** has passwordless sudo for automation
- Gateway token should be kept secret - it provides admin access
- The `.gitignore` excludes `*.env` and `certs/` by default
- Real API keys stay in Cloudflare Workers (never on the VPS)
- No ports exposed to the internet (Cloudflare Tunnel uses outbound connections only)

---

## Support

- OpenClaw Documentation: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- OVHCloud Support: <https://help.ovhcloud.com>

---

## Resources

- <https://github.com/VoltAgent/awesome-openclaw-skills>
- <https://github.com/lekt9/openclaw-foundry>
- <https://gist.github.com/simple10/50b9d5fdaf0a12162c2a682c1f7e2391>
- <https://github.com/knostic/openclaw-telemetry/>
- <https://github.com/knostic/openclaw-shield>
- <https://www.knostic.ai/blog/why-we-built-openclaw-shield-securing-ai-agents-from-themselves>
- <https://gist.github.com/simple10/7a91c7471fb543bf0a75341cb2367622>

## Related Apps & Tools

- <https://www.easyclaw.app/docs/privacy>
- <https://seqpu.com/mco>
