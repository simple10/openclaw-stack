#!/bin/bash
set -euo pipefail

# system-hardening.sh — One-pass system hardening (playbook 02, sections 2.5–2.8)
#
# Configures swap, fail2ban, unattended-upgrades, and kernel sysctl in a single pass.
# Run once during initial VPS setup. Safe to re-run (idempotent where possible).
#
# Interface:
#   Required env: SSH_PORT (for fail2ban jail)
#   Optional env: SWAP_SIZE (default: 8G)
#   Exit: 0 success, 1 failure

CURRENT_STEP=""
trap 'if [ $? -ne 0 ]; then echo "FAILED during: ${CURRENT_STEP:-unknown step}" >&2; fi' EXIT

if [ -z "${SSH_PORT:-}" ]; then
  echo "ERROR: SSH_PORT is required (for fail2ban config)." >&2
  exit 1
fi

SWAP_SIZE="${SWAP_SIZE:-8G}"

# ── 1. Swap Configuration ────────────────────────────────────────────
# Docker containers need host swap for memorySwap limits to work.
# Without it, --memory-swap effectively equals --memory (no spill to disk).
CURRENT_STEP="swap configuration (${SWAP_SIZE})"
echo "==> Configuring swap (${SWAP_SIZE})..."

if swapon --show | grep -q /swapfile; then
  echo "  Swap already active, skipping creation."
else
  fallocate -l "${SWAP_SIZE}" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile

  # Persist across reboots (skip if already in fstab)
  grep -q '/swapfile' /etc/fstab || \
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Low swappiness: prefer RAM, only swap under pressure
sysctl -w vm.swappiness=10 > /dev/null
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf

# Verify swap is active
if ! swapon --show --noheadings | grep -q /swapfile; then
  echo "ERROR: Swap file not active after setup." >&2
  exit 1
fi
echo "  Swap: $(swapon --show --noheadings | awk '{print $3}')"

# ── 2. Fail2ban ──────────────────────────────────────────────────────
CURRENT_STEP="fail2ban configuration (SSH port ${SSH_PORT})"
echo "==> Configuring fail2ban (SSH port ${SSH_PORT})..."

tee /etc/fail2ban/jail.local > /dev/null << EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 24h
EOF

systemctl enable fail2ban
systemctl restart fail2ban

# Verify fail2ban is running
if ! systemctl is-active --quiet fail2ban; then
  echo "ERROR: fail2ban failed to start. Check: journalctl -u fail2ban --no-pager -n 20" >&2
  exit 1
fi
echo "  fail2ban active, SSH jail on port ${SSH_PORT}."

# ── 3. Automatic Security Updates ────────────────────────────────────
CURRENT_STEP="unattended-upgrades installation"
echo "==> Configuring unattended-upgrades..."

apt install -y unattended-upgrades

tee /etc/apt/apt.conf.d/50unattended-upgrades > /dev/null << 'EOF'
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

systemctl enable unattended-upgrades
echo "  Unattended security upgrades enabled."

# ── 4. Kernel Hardening (sysctl) ─────────────────────────────────────
CURRENT_STEP="kernel hardening (sysctl)"
echo "==> Applying kernel hardening..."

tee /etc/sysctl.d/99-security.conf > /dev/null << 'EOF'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Ignore send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Block SYN attacks
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

sysctl -p /etc/sysctl.d/99-security.conf

# Spot-check a critical parameter
if [ "$(sysctl -n net.ipv4.tcp_syncookies)" != "1" ]; then
  echo "ERROR: Kernel parameter net.ipv4.tcp_syncookies not applied." >&2
  exit 1
fi
echo "  Kernel parameters applied."

CURRENT_STEP=""
echo ""
echo "System hardening complete."
