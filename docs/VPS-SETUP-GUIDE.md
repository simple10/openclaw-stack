# OVHCloud Setup Guide for OpenClaw Deployment

This guide covers setting up your VPS on OVHCloud before handing off to Claude Code to deploy OpenClaw.

Any VPS host will work as long as it supports root SSH access and Ubuntu 24+.

The deployment playbooks take care of hardening and system updates. Only a provisioned VPS
with root SSH key access (no password) is required to start.

For non-Ubuntu Linux distros, you'll need a kernel that supports sysbox, and you'll need to have claude
modify the playbooks for your distro.

---

## Overview

Setting up **a VPS instance** on OVHCloud:

| VPS | Purpose | Hostname | IP (example) |
|-----|---------|----------|--------------|
| VPS-1 | OpenClaw (gateway + sandboxes) | `openclaw` | `x.x.x.x` |

---

## Step 1: Create OVHCloud Account

1. Go to [us.ovhcloud.com](https://us.ovhcloud.com) (or your regional OVHCloud site)
2. Create an account or log in
3. Add a payment method
4. Verify your email and identity if prompted

---

## Step 2: Generate a New SSH Key

You will need the public key during the checkout flow for OVH.

If you do not add the public key during checkout, it can be added after provisioning by
reinstalling the OS in the OVH dashboard.

```bash
# On your local machine
ssh-keygen -t ed25519 -C "vps1-openclaw" -f ~/.ssh/vps1_openclaw_ed25519
# Enter a secure password when prompted, used to decrypt the local private key
# Securely store the password, you'll need it for ssh-add step later on

# Update permissions for all local keys
chmod -R 600 ~/.ssh/*

# View public key to paste into OVHCloud
cat ~/.ssh/vps1_openclaw_ed25519.pub
```

## Step 3: Order a VPS Instance

1. Navigate to **Bare Metal & VPS → VPS**
2. Click **Configure your VPS** or select **VPS-2** ($6.75/mo)
3. Configure:

   | Setting | Value |
   |---------|-------|
   | **Model** | VPS-2 (6 vCores, 12GB RAM, 100GB NVMe) |
   | **Location** | Choose a **standard datacenter** (not Local Zone) — e.g., Vint Hill VA, Hillsboro OR, or EU |
   | **Operating System** | **Ubuntu 24.04 LTS** |
   | **SSH Key** | Add your public SSH key |
   | **Hostname** | `openclaw` |

### VPS Size

If you setup a VPS that's smaller or larger than 6 cores + 12GB RAM, you'll likely want to adjust:

1. Gateway container resource limits in `stack.yml` under `defaults` or `claws.<name>`
2. Sandbox container resources in `openclaw/default/openclaw.jsonc`

Just ask Claude to adjust the sizing for you before deploying. The gateway container limits should
nearly max out the limits of your VPS. It effectively shares resources with its nested sandbox
containers -- the agent and browser containers. Besides the gateway, the VPS
runs Vector (if logging enabled) and normal Ubuntu system daemons.

---

## Step 4: Wait for Provisioning

OVHCloud typically provisions VPSs within 5-15 minutes. You'll receive:

- Email confirmation with IP addresses
- Access credentials in OVHCloud Control Panel

### Find Your IPs

1. Log into [OVHCloud Control Panel](https://manager.us.ovhcloud.com)
2. Go to **Bare Metal Cloud → VPS**
3. Note the **IPv4 address** for your VPS

Record it in `.env`:

```bash
# .env

VPS_IP=x.x.x.x

# SSH Configuration (required)
SSH_KEY=~/.ssh/vps1_openclaw_ed25519 # Optional: path to your ssh key file
SSH_IDENTITY_AGENT=                  # Optional: ssh agent socket path if you use an agent instead of a key file
SSH_USER=ubuntu # Initial user created by OVH, changed to adminclaw during hardening
SSH_PORT=22 # Initial SSH port, changed to 222 during hardening
```

---

## Step 5: Verify SSH Access

Test SSH access to VPS-1 from your local machine:

```bash
# Add ssh key for local sessions - needed for claude to do it's work
ssh-add ~/.ssh/vps1_openclaw_ed25519

# Test VPS-1 (OpenClaw)
ssh -i ~/.ssh/vps1_openclaw_ed25519 ubuntu@<VPS-1-IP>
# Or, if your key is already available through your SSH agent/config:
ssh ubuntu@<VPS-1-IP>
```

On first connection, accept the host key fingerprint.

### Troubleshooting SSH

If you can't connect:

1. **Check firewall**: OVHCloud VPSs should have port 22 open by default
2. **Check username**: Ubuntu 24.04 uses `ubuntu` as the default user
3. **Use KVM console**: In OVHCloud Control Panel, click your VPS → **KVM** to access directly

---

## Step 6: Verify System Requirements

SSH into your VPS and run these checks:

```bash
# Check Ubuntu version (should be 24.04)
lsb_release -a

# Check kernel version (should be 6.x)
uname -r

# Check available RAM
free -h

# Check disk space
df -h

# Check CPU info
nproc
```

Expected output:

- Ubuntu 24.04 LTS
- Kernel 6.x (e.g., 6.8.0-xx)
- ~12GB RAM
- ~100GB disk
- 6 vCores

---

### Step 7: Continue with Deployment

Return to the repo root and start Claude:

```bash
cd openclaw-stack
claude "start"
```

Claude reads `CLAUDE.md` and walks you through the rest of the deployment.

---

## Quick Reference

### SSH Commands

**Note**: After deployment, SSH uses port 222 (not 22). During initial setup, use the default port 22.

```bash
# Add ssh key for local sessions - needed for claude to do it's work
ssh-add ~/.ssh/vps1_openclaw_ed25519

# SSH to OpenClaw VPS (before deployment - default port 22)
ssh -i ~/.ssh/vps1_openclaw_ed25519 ubuntu@<VPS-1-IP>
# Or with agent-based auth:
ssh ubuntu@<VPS-1-IP>

# After claude deployment and hardening - use port 222 and adminclaw user
ssh -i ~/.ssh/vps1_openclaw_ed25519 -p 222 adminclaw@<VPS-1-IP>
# Or with agent-based auth:
ssh -p 222 adminclaw@<VPS-1-IP>
```

### OVHCloud Control Panel Links

- VPS Management: <https://manager.us.ovhcloud.com> → Bare Metal Cloud → VPS
- KVM Console: Click your VPS → More options → KVM
- Reboot/Rescue: Click your VPS → Actions

### Support

- OVHCloud Support: <https://help.ovhcloud.com>
- OpenClaw Docs: <https://docs.openclaw.ai>
- OpenClaw GitHub: <https://github.com/openclaw/openclaw>

---

## Checklist Before Claude Code

- [ ] VPS provisioned and running
- [ ] SSH access verified to VPS
- [ ] Ubuntu 24.04 LTS installed
- [ ] Kernel version is 6.x
- [ ] Configuration files created (`.env` + `stack.yml`)
- [ ] (Optional) Domain DNS records created
- [ ] (Optional) Messaging bot tokens ready

Once complete, proceed with CLAUDE.md!
