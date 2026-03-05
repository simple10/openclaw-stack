---
name: setup-docker
description: Use when the user wants to install Docker and optionally Sysbox on a VPS server. Triggered by /setup-docker or requests to install Docker on a server.
---

# /setup-docker -- Docker & Sysbox Installation

Install Docker CE with Compose plugin, harden the daemon for production use, and optionally install the Sysbox runtime for secure Docker-in-Docker. Prerequisite: SSH access to the server with a sudo user and app user already created (run `/setup-vps` first or equivalent).

## Env Var Discovery

Before doing anything, find connection details. Follow this logic exactly:

1. Read `.env` in the project root. If it contains ANY of `SSH_USER`, `SSH_PORT`, `VPS_IP`, or `SSH_KEY`, use `.env` as `ENV_FILE`.
2. Else read `.env.vps`. If it exists and contains any of those vars, use `.env.vps` as `ENV_FILE`.
3. If neither file has the vars, ask the user interactively for each value, then save them to `.env.vps`. Also ensure `.env.vps` is listed in `.gitignore` (append if not present).
4. Display all discovered values and ask the user to confirm before proceeding.

### Variables and defaults

```
VPS_IP=                           # required, no default
SSH_USER=admin                    # sudo user (post-hardening default)
SSH_PORT=222                      # SSH port (post-hardening default)
SSH_KEY=~/.ssh/id_ed25519         # SSH key path
VPS_SUDO_USER=admin               # admin user (must exist on server)
VPS_APP_USER=appuser              # unprivileged app user (must exist on server)
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

## Prerequisite Check

Before starting installation, verify the server is reachable and the required users exist.

```bash
# Test SSH connectivity
echo "SSH OK"

# Verify required users exist
id "$VPS_SUDO_USER" && id "$VPS_APP_USER"
```

If SSH fails, check the connection details in `ENV_FILE`. If either user does not exist, tell the user to run `/setup-vps` first to create them.

---

## Section 1: Install Docker

Check if Docker is already installed. If so, report the version and skip to Section 2.

```bash
if command -v docker &>/dev/null && docker --version &>/dev/null; then
    echo "Docker already installed: $(docker --version)"
    echo "Compose: $(docker compose version 2>/dev/null || echo 'not found')"
    echo "Skipping installation."
    exit 0
fi
```

If Docker is not installed, proceed with installation. Detect the distro and adapt commands.

### Debian/Ubuntu

```bash
# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository (works for Ubuntu and Debian -- uses $ID from os-release)
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**For RHEL/Fedora:** Use `dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo` then `dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`.

### Post-install (all distros)

```bash
# Add both users to docker group
sudo usermod -aG docker $VPS_APP_USER
sudo usermod -aG docker $VPS_SUDO_USER

# Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker
```

**If `apt install docker-ce` fails with "Unable to locate package":**

Check that the GPG key and repo entry exist:

```bash
ls /etc/apt/keyrings/docker.gpg && cat /etc/apt/sources.list.d/docker.list
```

If either is missing, re-run the GPG key and repository setup commands above. Also verify the distro codename is correct in the repo URL -- some distros (Linux Mint, Pop!_OS) need the upstream Ubuntu codename.

**If GPG key import fails:**

The `gpg --dearmor` command may fail if the keyring file already exists. Remove it first:

```bash
sudo rm -f /etc/apt/keyrings/docker.gpg
```

Then retry the GPG key import.

---

## Section 2: Docker Daemon Hardening

Write the hardened daemon configuration. If `/etc/docker/daemon.json` already exists, back it up first.

```bash
sudo mkdir -p /etc/docker

# Back up existing config if present
if [ -f /etc/docker/daemon.json ]; then
    sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.backup
    echo "Existing daemon.json backed up to daemon.json.backup"
fi

sudo tee /etc/docker/daemon.json << 'EOF'
{
  "ip": "127.0.0.1",
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  }
}
EOF

sudo systemctl restart docker
```

**If Docker fails to restart after daemon.json changes:**

Validate the JSON syntax:

```bash
sudo cat /etc/docker/daemon.json | python3 -m json.tool
```

Fix any syntax errors and retry. Also check the journal for specific error messages:

```bash
sudo journalctl -u docker --no-pager -n 20
```

Common issues: duplicate keys, trailing commas, incompatible options with the installed Docker version.

---

## Section 3: Install Sysbox (optional)

**STOP. Ask the user:** "Do you need Docker-in-Docker support (Sysbox)? This is needed for running Docker inside containers (e.g., OpenClaw sandboxes). If you're just running regular containers, you can skip this."

If the user says no, skip this entire section and go to Section 4.

If yes, proceed below.

### 3a: Check if already installed

```bash
if command -v sysbox-runc &>/dev/null; then
    echo "Sysbox already installed: $(sysbox-runc --version)"
    echo "Skipping installation."
    exit 0
fi
```

### 3b: Download and install

```bash
SYSBOX_VERSION="0.6.7"
SYSBOX_SHA256="b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e"
SYSBOX_DEB="sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"

# Download
wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"

# Verify download integrity
echo "${SYSBOX_SHA256}  ${SYSBOX_DEB}" | sha256sum -c -

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i "${SYSBOX_DEB}"

# Cleanup
rm "${SYSBOX_DEB}"
```

**If sha256sum fails:** The download may be corrupted. Delete the file and re-download:

```bash
rm "${SYSBOX_DEB}"
wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"
```

**If `dpkg -i` fails with dependency errors:**

```bash
sudo apt --fix-broken install -y
```

### 3c: AppArmor fusermount3 fix

Ubuntu 25.04+ ships a `fusermount3` AppArmor profile in enforce mode that blocks sysbox-fs from creating FUSE mounts. Check if it applies and fix:

```bash
if sudo aa-status 2>/dev/null | grep -q 'fusermount3'; then
    echo "fusermount3 AppArmor profile is enforcing -- disabling for sysbox-fs compatibility"

    # Disable the profile (persists across reboots)
    sudo ln -sf /etc/apparmor.d/fusermount3 /etc/apparmor.d/disable/
    sudo apparmor_parser -R /etc/apparmor.d/fusermount3 2>/dev/null || true

    # Restart sysbox services
    sudo systemctl restart sysbox-fs sysbox-mgr sysbox

    echo "fusermount3 profile disabled, sysbox restarted"
else
    echo "fusermount3 AppArmor profile not enforcing -- no action needed"
fi
```

This is not needed on Ubuntu 24.04 where the profile is absent or in complain mode. On a hardened VPS with key-only SSH, disabling this profile has negligible security impact.

### 3d: Overlayfs ID-mapped mount workaround

Sysbox 0.6.7 detects kernel support for ID-mapped mounts on overlayfs but fails to apply them, causing files inside containers to appear as `nobody:nogroup`. Apply a systemd override to force rootfs cloning instead:

```bash
sudo mkdir -p /etc/systemd/system/sysbox-mgr.service.d
sudo tee /etc/systemd/system/sysbox-mgr.service.d/override.conf << 'EOF'
[Service]
# Force rootfs cloning (chown) instead of broken ID-mapped mount on overlayfs.
# Sysbox 0.6.7 detects kernel ID-mapped mount support but fails to apply it,
# causing image files to appear as nobody:nogroup inside containers.
# This slows container start/stop by a few seconds but ensures correct uid mapping.
# See: https://github.com/nestybox/sysbox/issues/968
ExecStart=
ExecStart=/usr/bin/sysbox-mgr --disable-ovfs-on-idmapped-mount --log-level info
EOF

sudo systemctl daemon-reload
sudo systemctl restart sysbox
```

**When to remove:** Once a future Sysbox release fixes this bug, remove the override:

```bash
sudo rm /etc/systemd/system/sysbox-mgr.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart sysbox
```

---

## Section 4: Verification

Run all checks and report results to the user.

```bash
# Docker version
docker --version
docker compose version

# Docker daemon info
docker info | grep -E "Storage Driver|Logging Driver|Default Runtime"

# Verify daemon config is applied
docker info | grep -A2 "Default Address Pools"

# Test as app user (group membership may need logout/login -- use sudo to test)
sudo -u $VPS_APP_USER docker ps

# Verify daemon.json settings
cat /etc/docker/daemon.json | python3 -m json.tool
```

If Sysbox was installed, also verify:

```bash
# Sysbox runtime registered with Docker
docker info | grep -i "sysbox"

# Sysbox service running
sudo systemctl is-active sysbox

# Overlayfs override active
sudo systemctl show sysbox-mgr --property=ExecStart | grep -q 'disable-ovfs-on-idmapped-mount' \
    && echo "sysbox-mgr override: ACTIVE" \
    || echo "sysbox-mgr override: NOT APPLIED"
```

Print a summary with pass/fail for each check:

- Docker installed and running
- Docker Compose available
- Daemon hardening applied (127.0.0.1 binding, log rotation, overlay2, no-new-privileges)
- App user can run docker commands
- Sysbox runtime registered (if installed)
- Sysbox overlayfs workaround active (if installed)

If any check fails, report the failure and suggest remediation.
