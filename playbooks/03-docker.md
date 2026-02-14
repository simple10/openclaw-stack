# 03 - Docker Installation

Install and harden Docker on VPS-1.

## Overview

This playbook configures:
- Docker CE installation from official repository
- Docker Compose plugin
- Docker group membership for users
- Docker daemon hardening

## Prerequisites

- [02-base-setup.md](02-base-setup.md) completed on VPS-1
- SSH access as `adminclaw` on port 222

## Variables

No external variables required. Uses standard Docker installation.

---

## 3.1 Install Docker

Run on: **VPS-1**

```bash
#!/bin/bash
# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add both users to docker group
# - openclaw: runs containers
# - adminclaw: manages containers via sudo -u openclaw
sudo usermod -aG docker openclaw
sudo usermod -aG docker adminclaw

# Start and enable Docker
sudo systemctl enable docker
sudo systemctl start docker
```

**If `apt install docker-ce` fails with "Unable to locate package":**

> "The Docker repository wasn't added correctly. Verify the GPG key and
> repo entry exist:"
>
> `ls /etc/apt/keyrings/docker.gpg && cat /etc/apt/sources.list.d/docker.list`
>
> If either is missing, re-run the GPG key and repository setup commands above.

---

## 3.2 Docker Daemon Hardening

Run on: **VPS-1**

```bash
#!/bin/bash
sudo mkdir -p /etc/docker

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

> "Docker won't start with the new daemon config. This usually means a JSON
> syntax error in `/etc/docker/daemon.json`. Validate it:"
>
> `sudo cat /etc/docker/daemon.json | python3 -m json.tool`
>
> Fix any syntax errors and retry: `sudo systemctl restart docker`

See [REQUIREMENTS.md § 2.8](../REQUIREMENTS.md#28-docker) for setting rationale.

---

## Verification

```bash
# Check Docker is running
sudo systemctl status docker

# Check Docker version
docker --version
docker compose version

# Verify daemon config is applied
docker info | grep -A5 "Logging Driver"
docker info | grep "Storage Driver"

# Test as openclaw user (may need to logout/login for group membership)
sudo -u openclaw docker ps
```

---

## Troubleshooting

### Permission Denied

```bash
# User not in docker group - add and refresh
sudo usermod -aG docker $USER
newgrp docker

# Or logout and login again
```

### Docker Daemon Won't Start

```bash
# Check logs
sudo journalctl -u docker -f

# Validate daemon.json syntax
sudo cat /etc/docker/daemon.json | python3 -m json.tool

# Check for config errors
sudo dockerd --validate
```

### Storage Issues

```bash
# Check disk space
df -h

# Clean up unused resources
docker system prune -af

# Check Docker disk usage
docker system df
```

