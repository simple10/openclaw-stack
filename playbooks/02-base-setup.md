# 02 - Base Setup

Base system configuration for VPS-1.

## Overview

This playbook configures:

- System updates and essential packages
- Two-user security model (adminclaw + openclaw)
- UFW firewall
- SSH hardening (custom port, key-only)
- System hardening (swap, fail2ban, unattended-upgrades, kernel sysctl)
- Cloudflare Tunnel (cloudflared)

## Prerequisites

- Fresh Linux VPS with SSH access
- SSH key configured and accessible
- VPS IP known and reachable

> **Note (VPS re-installs):** If reusing an IP from a previous deployment, clear the stale SSH host key first:
>
> ```bash
> ssh-keygen -R <VPS1_IP>
> ```
>
> Then connect and accept the new host key when prompted.

## Variables

From `../openclaw-config.env`:

- `VPS1_IP` - Public IP of VPS-1
- `SSH_KEY_PATH` - Path to SSH private key
- `SSH_USER` - Initial SSH user (e.g., ubuntu, root, debian — depends on provider)
- `SSH_HARDENED_PORT` - Target SSH port for hardening (default: 222 if not set)
- `CF_TUNNEL_TOKEN` - Cloudflare Tunnel token
- `VPS_HOSTNAME` - Optional, friendly hostname (replaces provider default)

## Execution Order

Complete sections 2.1–2.6 on VPS-1.

Connect initially as `<SSH_USER>`, then switch to `adminclaw` after section 2.4 (SSH hardening).

---

## 2.1 System Update & Essential Packages

Run on: **VPS-1**

```bash
#!/bin/bash
set -euo pipefail

# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y \
    curl wget git vim htop tmux unzip \
    ca-certificates gnupg lsb-release \
    apt-transport-https software-properties-common \
    ufw fail2ban auditd
```

**If `apt update` fails with "Could not resolve" or network errors:**

> "The VPS can't reach Ubuntu's package repositories. Check DNS and
> outbound connectivity:"
>
> `ping -c 2 archive.ubuntu.com`
>
> If DNS fails, check `/etc/resolv.conf` — it may need a valid nameserver
> (e.g., `nameserver 1.1.1.1`).

---

## 2.1a Set Hostname

If `VPS_HOSTNAME` is set in `openclaw-config.env`, replace the provider's default hostname (e.g., `vps-54a00e96`) with a friendly name. Skip if empty.

```bash
#!/bin/bash
# Only set if VPS_HOSTNAME is configured
if [[ -n "${VPS_HOSTNAME:-}" ]]; then
  sudo hostnamectl set-hostname "${VPS_HOSTNAME}"
  echo "Hostname set to: $(hostname)"
else
  echo "VPS_HOSTNAME not set — keeping current hostname: $(hostname)"
fi
```

---

## 2.2 Create Dedicated Users

Run on: **VPS-1**

Two-user security model:

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key only | Passwordless | System administration, Claude automation |
| `openclaw` | None | None | Runs application, owns app files |

Passwords are auto-generated and set non-interactively. **Save the output** — you may need these for KVM/console emergency access.

```bash
#!/bin/bash
# ============================================
# 1. Create adminclaw (admin user with sudo)
# ============================================
sudo useradd -m -s /bin/bash adminclaw

# Generate and set random password (save this for console/emergency access)
ADMINCLAW_PASS=$(openssl rand -base64 18)
echo "adminclaw:${ADMINCLAW_PASS}" | sudo chpasswd

# Grant passwordless sudo for automation (required for Claude Code to manage the server)
echo "adminclaw ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/adminclaw
sudo chmod 440 /etc/sudoers.d/adminclaw

# Copy SSH authorized_keys from current user (<SSH_USER>)
sudo mkdir -p /home/adminclaw/.ssh
sudo cp ~/.ssh/authorized_keys /home/adminclaw/.ssh/
sudo chown -R adminclaw:adminclaw /home/adminclaw/.ssh
sudo chmod 700 /home/adminclaw/.ssh
sudo chmod 600 /home/adminclaw/.ssh/authorized_keys

# ============================================
# 2. Create openclaw (app user, NO sudo, NO SSH)
# ============================================
sudo useradd -m -s /bin/bash openclaw

# Generate and set random password (save this for console/emergency access)
OPENCLAW_PASS=$(openssl rand -base64 18)
echo "openclaw:${OPENCLAW_PASS}" | sudo chpasswd

# NOTE: No sudo configuration for openclaw - this is intentional for security
# NOTE: No SSH keys for openclaw - access via: sudo su - openclaw

# ============================================
# Display generated passwords — save these!
# ============================================
echo ""
echo "========================================="
echo "  Generated Passwords (save these):"
echo "  adminclaw: ${ADMINCLAW_PASS}"
echo "  openclaw:  ${OPENCLAW_PASS}"
echo "========================================="
```

**Record passwords locally:** Immediately after the script above runs, use the `Edit` tool to update the `ADMINCLAW_PASSWORD` and `OPENCLAW_PASSWORD` values in the `# DEPLOYED:` section of `openclaw-config.env`. Replace the existing `# DEPLOYED: ADMINCLAW_PASSWORD=` and `# DEPLOYED: OPENCLAW_PASSWORD=` lines with the generated passwords. Do NOT use `sed` — it creates backup files on macOS.

> These are comments — `source openclaw-config.env` won't export them. They're a safety net in case the session ends before the deployment report (§ 8.5).

**Workflow after setup:**

```bash
# SSH as admin user
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> adminclaw@<VPS1_IP>

# Run commands as openclaw (no direct SSH — adminclaw can't cd into openclaw's home)
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/openclaw && docker compose up -d'

# Interactive shell as openclaw
sudo su - openclaw
```

---

## 2.3 UFW Firewall Setup

Run on: **VPS-1**

**IMPORTANT**: Configure the firewall FIRST to allow port `<SSH_HARDENED_PORT>`, then apply SSH hardening. This prevents lockout.

```bash
#!/bin/bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH - allow BOTH ports during transition (remove port 22 after verifying <SSH_HARDENED_PORT> works)
sudo ufw allow 22/tcp
sudo ufw allow <SSH_HARDENED_PORT>/tcp

# Enable
sudo ufw --force enable
```

> **Note:** Port 443 is NOT opened here. Cloudflare Tunnel uses outbound connections only — no inbound ports needed.

---

## 2.4 SSH Hardening

Run on: **VPS-1**

**IMPORTANT**: Ubuntu uses systemd socket activation for SSH. The socket controls which port SSH listens on. You must update BOTH the socket AND the sshd config.

> **WARNING — Lockout prevention:**
> - The socket override below listens on BOTH ports 22 and `<SSH_HARDENED_PORT>` during transition. Port 22 is only removed after verifying `<SSH_HARDENED_PORT>` works from your local machine.
> - `AllowUsers` includes both `adminclaw` and `<SSH_USER>` during transition, so you can fall back to the original user if adminclaw auth fails.
> - Do NOT `systemctl restart ssh` after restarting `ssh.socket`. The socket already binds the ports — restarting the service causes "Address already in use" failures. Only restart `ssh.socket`; socket activation handles the service automatically.

### Step 1: Write config files

```bash
#!/bin/bash
# Backup original config
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# Create hardened sshd config
# NOTE: AllowUsers temporarily includes the initial user (<SSH_USER>) for fallback.
# It will be tightened to adminclaw-only after verifying port <SSH_HARDENED_PORT> works.
sudo tee /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
# Use non-standard port to avoid bot scanners
# NOTE: The systemd socket override (below) also sets this port
Port <SSH_HARDENED_PORT>

# Disable root login
PermitRootLogin no

# Disable password authentication - SSH keys only
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no

# IMPORTANT: Keep UsePAM yes on Ubuntu - required for proper authentication
UsePAM yes

# Allow admin user + initial user during transition (tightened in Step 3)
AllowUsers adminclaw <SSH_USER>

# Connection settings
MaxAuthTries 3
MaxSessions 3
LoginGraceTime 30

# Disable unused features
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitEmptyPasswords no
PermitUserEnvironment no

# Use strong algorithms only
KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
EOF

# Systemd socket override: listen on BOTH ports during transition
# Port 22 is removed in Step 3 after verifying <SSH_HARDENED_PORT> works
sudo mkdir -p /etc/systemd/system/ssh.socket.d
sudo tee /etc/systemd/system/ssh.socket.d/override.conf << 'EOF'
[Socket]
# Clear defaults and listen on both ports during transition
ListenStream=
ListenStream=0.0.0.0:22
ListenStream=[::]:22
ListenStream=0.0.0.0:<SSH_HARDENED_PORT>
ListenStream=[::]:<SSH_HARDENED_PORT>
EOF
```

### Step 2: Validate and apply

```bash
#!/bin/bash
# Validate config BEFORE applying changes
echo "Validating SSH config..."
sudo sshd -t
if [ $? -ne 0 ]; then
    echo "ERROR: SSH config validation failed! NOT restarting SSH."
    echo "Reverting config..."
    sudo rm -f /etc/ssh/sshd_config.d/hardening.conf
    sudo rm -rf /etc/systemd/system/ssh.socket.d
    echo "Config reverted. Fix issues and retry."
    exit 1
fi
echo "SSH config valid."

# Reload systemd to pick up socket override
sudo systemctl daemon-reload

# ONLY restart the socket — do NOT restart ssh.service
# Socket activation will start the service automatically for new connections.
sudo systemctl restart ssh.socket

# Verify SSH is listening on BOTH ports
echo "Verifying SSH is listening on ports 22 and <SSH_HARDENED_PORT>..."
ss -tlnp | grep -E ':(22|<SSH_HARDENED_PORT>)\s'
echo ""
echo "SSH hardening applied with both ports active."
echo "Test port <SSH_HARDENED_PORT> from your LOCAL machine before proceeding."
```

### Step 3: Test and finalize

**MANDATORY STOP**: Test SSH on port `<SSH_HARDENED_PORT>` from your LOCAL machine BEFORE proceeding. Do not skip this step during automated deployment.

```bash
# From LOCAL machine — test port <SSH_HARDENED_PORT>
ssh -i <SSH_KEY_PATH> -p <SSH_HARDENED_PORT> adminclaw@<VPS1_IP> "echo 'Port <SSH_HARDENED_PORT> works!'"
```

**If port `<SSH_HARDENED_PORT>` test succeeds:** Update `openclaw-config.env` on the LOCAL machine using the `Edit` tool (do NOT use `sed` — it creates backup files on macOS):

1. Change `SSH_USER=<SSH_USER>` to `SSH_USER=adminclaw            # Changed from <SSH_USER> during hardening`
2. Change `SSH_PORT=<SSH_PORT>` to `SSH_PORT=<SSH_HARDENED_PORT>                  # Changed from <SSH_PORT> during hardening`
3. Delete the `SSH_HARDENED_PORT=` line entirely

Then lock down SSH:

```bash
# On VPS — lock down: remove port 22 from socket, remove <SSH_USER> from AllowUsers
ssh -i <SSH_KEY_PATH> -p <SSH_HARDENED_PORT> adminclaw@<VPS1_IP>

# Update socket to port <SSH_HARDENED_PORT> only
sudo tee /etc/systemd/system/ssh.socket.d/override.conf << 'EOF'
[Socket]
# Clear defaults and listen on port <SSH_HARDENED_PORT> only (port 22 removed after verification)
ListenStream=
ListenStream=0.0.0.0:<SSH_HARDENED_PORT>
ListenStream=[::]:<SSH_HARDENED_PORT>
EOF

# Tighten AllowUsers to adminclaw only
sudo sed -i 's/^AllowUsers adminclaw <SSH_USER>$/AllowUsers adminclaw/' /etc/ssh/sshd_config.d/hardening.conf

# Apply socket change and remove port 22 from firewall
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
sudo ufw delete allow 22/tcp
sudo ufw status

# Verify only port <SSH_HARDENED_PORT> is listening
ss -tlnp | grep -E ':(22|<SSH_HARDENED_PORT>)\s'
```

**If port `<SSH_HARDENED_PORT>` test fails with "Connection refused":**

> "SSH on port `<SSH_HARDENED_PORT>` is not responding. Port 22 is still active (both SSH and UFW).
> Connect on port 22 and debug."

```bash
# SSH in on port 22 (still listening during transition) and debug
ssh -i <SSH_KEY_PATH> -p 22 adminclaw@<VPS1_IP>
sudo systemctl status ssh.socket
cat /etc/systemd/system/ssh.socket.d/override.conf
# Retry socket restart (NOT ssh.service)
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
ss -tlnp | grep -E ':(22|<SSH_HARDENED_PORT>)\s'
```

**If port `<SSH_HARDENED_PORT>` test fails with "Permission denied":**

> "SSH key authentication failed for adminclaw on port `<SSH_HARDENED_PORT>`. I'll verify the
> authorized_keys file was copied correctly."

```bash
# SSH in as <SSH_USER> (still allowed during transition) and check adminclaw's keys
ssh -i <SSH_KEY_PATH> -p 22 <SSH_USER>@<VPS1_IP>
sudo cat /home/adminclaw/.ssh/authorized_keys
sudo ls -la /home/adminclaw/.ssh/
```

---

## 2.5 System Hardening (swap, fail2ban, unattended-upgrades, sysctl)

> **Batch:** Consolidates former steps 2.5–2.8 into a single script. Execute after § 2.4 completes.

Run on: **VPS-1**

Configures in one pass:
- **Swap** — 8G swap file for Docker `memorySwap` limits (idempotent, skips if already active)
- **Fail2ban** — SSH jail on port `<SSH_PORT>`, 3 retries, 24h ban
- **Unattended-upgrades** — automatic security patches (no auto-reboot)
- **Kernel sysctl** — anti-spoofing, SYN flood protection, ASLR, dmesg/kptr restriction

```bash
# SOURCE: deploy/system-hardening.sh
sudo tee /tmp/system-hardening.sh << 'EOF'
# <<< deploy/system-hardening.sh >>>
EOF

sudo SSH_PORT=<SSH_PORT> bash /tmp/system-hardening.sh
rm -f /tmp/system-hardening.sh
```

---

## 2.6 Cloudflare Tunnel Setup

Run on: **VPS-1**

Install cloudflared and register the tunnel as a systemd service. The tunnel token must already be set in `openclaw-config.env`.

```bash
# Download and install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# Verify installation
cloudflared --version

# Install as systemd service using the tunnel token
sudo cloudflared service install ${CF_TUNNEL_TOKEN}

# Enable and start
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Check status
sudo systemctl status cloudflared

# Port 443 should already be closed (never opened in section 2.3)
# Verify it's not in UFW just in case
sudo ufw delete allow 443/tcp 2>/dev/null || true
```

**If `cloudflared service install` fails:**

> "The tunnel token may be invalid or expired. Verify the token in
> `openclaw-config.env` matches the one in Cloudflare Dashboard
> (Zero Trust -> Networks -> Tunnels -> your tunnel -> Configure)."

**If cloudflared starts but immediately exits (check with `systemctl status`):**

> "The tunnel service started but crashed. Check the logs:"
>
> `sudo journalctl -u cloudflared --no-pager | tail -20`
>
> Common issues:
>
> - **"failed to sufficiently increase receive buffer size"** — harmless warning, not a crash cause
> - **"Tunnel credentials not found"** — token is malformed. Re-copy from Cloudflare Dashboard
> - **"connection refused"** — outbound connectivity issue. Check `curl -sI https://cloudflare.com`

> **Note:** The tunnel connects and begins routing traffic to the configured public hostname routes. Domain and Cloudflare Access were verified during fresh deploy setup (`00-fresh-deploy-setup.md`).

---

## Verification

After completing all steps on VPS-1:

```bash
# Test SSH on hardened port
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> adminclaw@<VPS1_IP> "echo 'VPS-1 OK'"

# Verify UFW is active
sudo ufw status

# Verify fail2ban is running
sudo systemctl status fail2ban

# Verify kernel parameters
sudo sysctl net.ipv4.tcp_syncookies

# Verify cloudflared is running
sudo systemctl status cloudflared
```

---

## Troubleshooting

### SSH Connection Refused on Hardened Port

```bash
# Check if socket override exists
ls -la /etc/systemd/system/ssh.socket.d/

# Check what port SSH is listening on
ss -tlnp | grep ssh

# ONLY restart the socket — NEVER restart ssh.service (causes port conflict)
sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
```

### Locked Out of SSH

If you can't SSH in:

1. Use host provider console/KVM access
2. Login as adminclaw (or root if still available)
3. Check `/etc/ssh/sshd_config.d/hardening.conf` for errors
4. Restore port 22: add `ListenStream=0.0.0.0:22` and `ListenStream=[::]:22` to `/etc/systemd/system/ssh.socket.d/override.conf`, then `sudo ufw allow 22/tcp && sudo systemctl daemon-reload && sudo systemctl restart ssh.socket`

### UsePAM Error

If authentication fails:

- Ensure `UsePAM yes` is set (not `no`)
- Ubuntu requires PAM for proper user authentication
