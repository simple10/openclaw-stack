---
name: setup-vps
description: Use when the user wants to harden a VPS server - SSH hardening, firewall, fail2ban, user setup, kernel security. Triggered by /setup-vps or requests to secure/harden a server.
---

# /setup-vps -- VPS Server Hardening

Harden a fresh Linux VPS: create admin and app users, configure UFW firewall, lock down SSH with key-only auth on a non-standard port, apply kernel security parameters, set up fail2ban and unattended-upgrades. Distro-adaptive -- detect the target OS and adjust commands accordingly (apt/dnf/yum, ufw/firewalld, systemd variants).

## Env Var Discovery

Before doing anything, find connection details. Follow this logic exactly:

1. Read `.env` in the project root. If it contains ANY of `SSH_USER`, `SSH_PORT`, `VPS_IP`, or `SSH_KEY`, use `.env` as `ENV_FILE`.
2. Else read `.env.vps`. If it exists and contains any of those vars, use `.env.vps` as `ENV_FILE`.
3. If neither file has the vars, ask the user interactively for each value, then save them to `.env.vps`. Also ensure `.env.vps` is listed in `.gitignore` (append if not present).
4. Display all discovered values and ask the user to confirm before proceeding.
5. After hardening changes the SSH port and user (Section 5 Step 3), update `ENV_FILE` in place using the Edit tool (never sed on macOS).

### Variables and defaults

```
VPS_IP=                           # required, no default
SSH_USER=ubuntu                   # initial provider user
SSH_PORT=22                       # current SSH port
SSH_HARDENED_PORT=222             # target port (removed after hardening)
SSH_KEY=~/.ssh/id_ed25519         # SSH key path
HOSTNAME=                         # optional
VPS_SUDO_USER=admin               # admin user to create
VPS_APP_USER=appuser              # unprivileged app user to create
```

## SSH Connection Pattern

For every remote command, use this pattern:

```bash
ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new $SSH_USER@$VPS_IP "<command>"
```

For multi-line scripts, use heredoc:

```bash
ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new $SSH_USER@$VPS_IP bash <<'REMOTE'
set -euo pipefail
# commands here
REMOTE
```

---

## Section 1: System Update

Run a full system update and install essential packages.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
    curl wget git vim htop tmux unzip jq \
    ca-certificates gnupg lsb-release \
    apt-transport-https software-properties-common \
    ufw fail2ban
```

**If `apt` is not available** (RHEL/Fedora/etc.), adapt: use `dnf` or `yum` with equivalent packages. Replace `ufw` with `firewalld` and adjust Section 4 accordingly.

**If `apt update` fails with DNS errors:** Check `/etc/resolv.conf` -- it may need a valid nameserver. Run:

```bash
ping -c 2 archive.ubuntu.com
# If DNS fails:
echo "nameserver 1.1.1.1" | sudo tee /etc/resolv.conf
```

Verify the update succeeded before proceeding.

---

## Section 2: Set Hostname

Only run this if `HOSTNAME` is set (non-empty). Skip otherwise.

```bash
sudo hostnamectl set-hostname "$HOSTNAME"
echo "Hostname set to: $(hostname)"
```

---

## Section 3: Create Users

Create two users. Check if each user already exists before creating. Generate random passwords with `openssl rand -base64 24`.

### 3a: Admin user ($VPS_SUDO_USER)

```bash
# Check if user exists
if id "$VPS_SUDO_USER" &>/dev/null; then
    echo "$VPS_SUDO_USER already exists, skipping creation."
else
    ADMIN_PASSWORD=$(openssl rand -base64 24)
    sudo useradd -m -s /bin/bash "$VPS_SUDO_USER"
    echo "$VPS_SUDO_USER:$ADMIN_PASSWORD" | sudo chpasswd

    # Passwordless sudo for automation
    echo "$VPS_SUDO_USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/$VPS_SUDO_USER
    sudo chmod 440 /etc/sudoers.d/$VPS_SUDO_USER

    # Copy SSH keys from current user
    sudo mkdir -p /home/$VPS_SUDO_USER/.ssh
    sudo cp ~/.ssh/authorized_keys /home/$VPS_SUDO_USER/.ssh/
    sudo chown -R $VPS_SUDO_USER:$VPS_SUDO_USER /home/$VPS_SUDO_USER/.ssh
    sudo chmod 700 /home/$VPS_SUDO_USER/.ssh
    sudo chmod 600 /home/$VPS_SUDO_USER/.ssh/authorized_keys

    echo "$VPS_SUDO_USER created with password: $ADMIN_PASSWORD"
fi
```

### 3b: App user ($VPS_APP_USER)

Pin uid to 1000 for Docker namespace compatibility. If uid 1000 is already taken by another user, reassign that user first.

```bash
if id "$VPS_APP_USER" &>/dev/null; then
    echo "$VPS_APP_USER already exists, skipping creation."
else
    # Handle uid 1000 conflict
    EXISTING_USER=$(getent passwd 1000 | cut -d: -f1 || true)
    if [ -n "$EXISTING_USER" ] && [ "$EXISTING_USER" != "$VPS_APP_USER" ]; then
        echo "uid 1000 taken by $EXISTING_USER -- reassigning to 1099"
        sudo usermod -u 1099 "$EXISTING_USER"
        sudo find / -xdev -user 1099 -exec chown 1099 {} \; 2>/dev/null || true
    fi

    APP_PASSWORD=$(openssl rand -base64 24)
    sudo useradd -m -s /bin/bash -u 1000 "$VPS_APP_USER"
    echo "$VPS_APP_USER:$APP_PASSWORD" | sudo chpasswd

    # No sudo, no SSH keys -- access via: sudo su - $VPS_APP_USER
    echo "$VPS_APP_USER created (no sudo, no SSH). Password: $APP_PASSWORD"
fi
```

Display both passwords to the user and advise them to save them. Verify both users exist with `id $VPS_SUDO_USER && id $VPS_APP_USER`.

---

## Section 4: UFW Firewall

Set up the firewall. Allow BOTH port 22 and `$SSH_HARDENED_PORT` during transition to prevent lockout.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
# Allow both ports during transition
sudo ufw allow 22/tcp
sudo ufw allow $SSH_HARDENED_PORT/tcp
sudo ufw --force enable
sudo ufw status
```

**For `firewalld` systems** (RHEL/Fedora), adapt:

```bash
sudo firewall-cmd --set-default-zone=drop
sudo firewall-cmd --permanent --add-port=22/tcp
sudo firewall-cmd --permanent --add-port=$SSH_HARDENED_PORT/tcp
sudo firewall-cmd --reload
```

Verify the firewall is active and both ports are listed before proceeding.

---

## Section 5: SSH Hardening

This is the most critical section. Follow the three steps exactly. Do NOT skip the mandatory test gate.

### Step 1: Write config files

```bash
# Backup original config
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# Write hardened sshd config
sudo tee /etc/ssh/sshd_config.d/hardening.conf << EOF
# Non-standard port
Port $SSH_HARDENED_PORT

# Disable root login
PermitRootLogin no

# Key-only authentication
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no

# Keep PAM enabled (required on Ubuntu for proper auth)
UsePAM yes

# Allow admin + initial user during transition (tightened in Step 3)
AllowUsers $VPS_SUDO_USER $SSH_USER

# Connection limits
MaxAuthTries 3
MaxSessions 3
LoginGraceTime 30

# Disable unused features
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitEmptyPasswords no
PermitUserEnvironment no

# Strong algorithms only
KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
EOF
```

Write the systemd socket override to listen on BOTH ports during transition:

```bash
sudo mkdir -p /etc/systemd/system/ssh.socket.d
sudo tee /etc/systemd/system/ssh.socket.d/override.conf << EOF
[Socket]
# Clear defaults, listen on both ports during transition
ListenStream=
ListenStream=0.0.0.0:22
ListenStream=[::]:22
ListenStream=0.0.0.0:$SSH_HARDENED_PORT
ListenStream=[::]:$SSH_HARDENED_PORT
EOF
```

**Note:** If the distro does not use systemd socket activation for SSH (check with `systemctl status ssh.socket`), skip the socket override. The `Port` directive in the sshd config and a `systemctl restart sshd` will suffice.

### Step 2: Validate and apply

```bash
# Validate before applying -- abort if invalid
sudo sshd -t
if [ $? -ne 0 ]; then
    echo "SSH config validation FAILED. Reverting."
    sudo rm -f /etc/ssh/sshd_config.d/hardening.conf
    sudo rm -rf /etc/systemd/system/ssh.socket.d
    exit 1
fi

sudo systemctl daemon-reload
# ONLY restart the socket, NOT ssh.service (causes port conflict)
sudo systemctl restart ssh.socket

# Verify both ports are listening
ss -tlnp | grep -E ":(22|$SSH_HARDENED_PORT)\s"
```

If `sshd -t` fails, read the error output, fix the config, and retry. Common issues: duplicate directives conflicting with files in `sshd_config.d/`.

### Step 3: MANDATORY TEST GATE

**STOP. Do NOT proceed until the user confirms the new port works.**

Tell the user to run this from their LOCAL machine:

```bash
ssh -i $SSH_KEY -p $SSH_HARDENED_PORT $VPS_SUDO_USER@$VPS_IP "echo 'Port $SSH_HARDENED_PORT works!'"
```

Wait for the user to confirm success. Do NOT auto-proceed.

**If "Connection refused":** Port 22 is still active. Debug on the VPS:

```bash
sudo systemctl status ssh.socket
cat /etc/systemd/system/ssh.socket.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ssh.socket
ss -tlnp | grep -E ":(22|$SSH_HARDENED_PORT)\s"
```

**If "Permission denied":** SSH keys were not copied correctly. Check:

```bash
sudo ls -la /home/$VPS_SUDO_USER/.ssh/
sudo cat /home/$VPS_SUDO_USER/.ssh/authorized_keys
```

### After user confirms success

Lock down to the hardened port only. Connect as the new admin user on the hardened port for these commands:

```bash
# Remove initial user from AllowUsers
sudo sed -i "s/^AllowUsers $VPS_SUDO_USER $SSH_USER$/AllowUsers $VPS_SUDO_USER/" /etc/ssh/sshd_config.d/hardening.conf

# Socket: hardened port only
sudo tee /etc/systemd/system/ssh.socket.d/override.conf << EOF
[Socket]
ListenStream=
ListenStream=0.0.0.0:$SSH_HARDENED_PORT
ListenStream=[::]:$SSH_HARDENED_PORT
EOF

sudo systemctl daemon-reload
sudo systemctl restart ssh.socket

# Remove port 22 from firewall
sudo ufw delete allow 22/tcp
sudo ufw status

# Verify only hardened port is listening
ss -tlnp | grep -E ":(22|$SSH_HARDENED_PORT)\s"
```

**Update ENV_FILE** using the Edit tool (never sed on macOS):

1. Change `SSH_USER=<old>` to `SSH_USER=$VPS_SUDO_USER`
2. Change `SSH_PORT=22` to `SSH_PORT=$SSH_HARDENED_PORT`
3. Remove the `SSH_HARDENED_PORT=` line entirely

From this point forward, use the new SSH_USER and SSH_PORT for all connections.

---

## Section 6: System Hardening

Run these as the new admin user on the hardened port.

### 6a: Swap file

Default 8G. Skip if swap is already active.

```bash
if swapon --show | grep -q /swapfile; then
    echo "Swap already active, skipping."
else
    sudo fallocate -l 8G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
# Low swappiness
sudo sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf

# Verify
swapon --show
```

### 6b: Fail2ban

Configure SSH jail on the hardened port.

```bash
sudo tee /etc/fail2ban/jail.local << EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = $SSH_HARDENED_PORT
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h
EOF

sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
sudo systemctl is-active fail2ban
```

If fail2ban fails to start, check: `sudo journalctl -u fail2ban --no-pager -n 20`. Common issue: missing `/var/log/auth.log` -- switch `backend` to `systemd` and remove the `logpath` line.

### 6c: Unattended upgrades

```bash
sudo apt install -y unattended-upgrades

sudo tee /etc/apt/apt.conf.d/50unattended-upgrades > /dev/null << 'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

sudo systemctl enable unattended-upgrades
```

For non-Debian systems, use `dnf-automatic` with `apply_updates = yes` instead.

### 6d: Kernel sysctl hardening

```bash
sudo tee /etc/sysctl.d/99-security.conf << 'EOF'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Disable send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2

# Log Martians
net.ipv4.conf.all.log_martians = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0

# Enable ASLR
kernel.randomize_va_space = 2

# Restrict dmesg access
kernel.dmesg_restrict = 1

# Restrict kernel pointer access
kernel.kptr_restrict = 2
EOF

sudo sysctl -p /etc/sysctl.d/99-security.conf
```

Verify a critical parameter: `sysctl -n net.ipv4.tcp_syncookies` must return `1`. If not, investigate and fix before proceeding.

---

## Section 7: Final Verification

Run all checks from the local machine and on the VPS. Report results to the user.

**Local test:**

```bash
ssh -i $SSH_KEY -p $SSH_HARDENED_PORT $VPS_SUDO_USER@$VPS_IP "echo 'SSH OK'"
```

**Remote checks** (run on VPS as $VPS_SUDO_USER):

```bash
# Users exist
id $VPS_SUDO_USER && id $VPS_APP_USER

# UFW active with correct rules
sudo ufw status

# Fail2ban running
sudo systemctl is-active fail2ban
sudo fail2ban-client status sshd

# Kernel hardening applied
sysctl net.ipv4.tcp_syncookies net.ipv4.conf.all.rp_filter kernel.randomize_va_space kernel.dmesg_restrict

# Swap active
swapon --show

# SSH only on hardened port
ss -tlnp | grep ssh

# Unattended upgrades enabled
systemctl is-enabled unattended-upgrades 2>/dev/null || echo "N/A (non-Debian)"
```

Print a summary table with pass/fail for each check. If any check fails, report the failure and suggest remediation.
