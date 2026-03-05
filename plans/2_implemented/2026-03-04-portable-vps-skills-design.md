# Design: Portable VPS Setup Skills

**Date:** 2026-03-04
**Skills:** `/setup-vps`, `/setup-docker`
**Location:** `.claude/skills/` (project-local, extract to plugin later)
**Approach:** Playbook-style — skill markdown IS the playbook, Claude reads and executes step-by-step over SSH. Distro-adaptive (no hardcoded package manager assumptions).

## Motivation

The current OpenClaw playbooks (`02-base-setup.md`, `03-docker.md`, `03b-sysbox.md`) contain VPS hardening steps that are ~95% generic. Extracting them into portable Claude Code skills lets any project run `/setup-vps` to fully secure a server without needing the OpenClaw stack.

## Env Var Discovery (shared by both skills)

Both skills use the same preamble logic to find connection details:

1. Read `.env` — if it contains `SSH_USER`, `SSH_PORT`, `VPS_IP`, or `SSH_KEY`, use `.env` as the env file
2. If not, read `.env.vps` — if it exists and has those vars, use it
3. If neither has the vars, ask the user interactively, then save to `.env.vps` (create it, add `.env.vps` to `.gitignore`)
4. After hardening changes SSH port/user, update the chosen env file in place

### Env vars

```
VPS_IP=                           # required, no default
SSH_USER=ubuntu                   # initial provider user
SSH_PORT=22                       # current SSH port
SSH_HARDENED_PORT=222             # target port (removed from env after hardening)
SSH_KEY=~/.ssh/id_ed25519         # SSH key path
HOSTNAME=                         # optional, set VPS hostname
VPS_SUDO_USER=admin               # admin user to create (passwordless sudo)
VPS_APP_USER=appuser              # unprivileged app user (no sudo, no SSH)
```

## Skill 1: `/setup-vps`

Core server hardening. Assumes a fresh Ubuntu/Debian VPS with root or sudo access.

### Sections (executed in order)

| # | Section | Description |
|---|---------|-------------|
| 1 | System update | `apt update && upgrade`, install essentials (curl, git, vim, htop, jq, fail2ban, ufw, etc.) |
| 2 | Create users | `VPS_SUDO_USER` with passwordless sudo + SSH keys copied from initial user. `VPS_APP_USER` with no sudo, no SSH, uid pinned to 1000 for Docker namespace compatibility. |
| 3 | UFW firewall | Default deny incoming, allow outgoing. Open both port 22 and `SSH_HARDENED_PORT` during transition. |
| 4 | SSH hardening | Non-standard port, key-only auth, disable root login, strong ciphers (curve25519, chacha20-poly1305), systemd socket override. **Mandatory pause** — user must verify new port works before port 22 is locked down. Updates env file after verification. |
| 5 | System hardening | Swap file (configurable size), fail2ban SSH jail on hardened port, unattended-upgrades for security patches, kernel sysctl (ASLR, SYN flood protection, source routing disabled, ICMP hardening). |
| 6 | Verification | Test SSH on hardened port as new admin user, check UFW rules, fail2ban status, sysctl values. |

### Key behaviors

- **Idempotent** — checks existing state before acting (user exists? swap active? port already changed?)
- **Distro-adaptive** — Claude detects package manager and init system, adapts commands for Ubuntu/Debian/etc.
- **Mandatory SSH test gate** — will NOT remove port 22 until user confirms hardened port works
- **Env file updates** — after hardening, sets `SSH_USER=<VPS_SUDO_USER>`, `SSH_PORT=<SSH_HARDENED_PORT>`, removes `SSH_HARDENED_PORT` line
- **Troubleshooting built-in** — each section includes common failure modes and recovery steps

## Skill 2: `/setup-docker`

Docker + optional Sysbox installation. Requires SSH access (run `/setup-vps` first or have equivalent access).

### Sections

| # | Section | Description |
|---|---------|-------------|
| 1 | Install Docker | Add Docker GPG key + repo, install docker-ce/containerd/compose plugin, add `VPS_SUDO_USER` and `VPS_APP_USER` to docker group, enable + start. |
| 2 | Docker daemon hardening | `/etc/docker/daemon.json` — bind to 127.0.0.1 only, json-file logging with rotation (50m/5 files), overlay2 storage, live-restore, no-new-privileges, disable userland proxy. |
| 3 | Install Sysbox (optional) | Prompt: "Do you need Docker-in-Docker?" If yes: download pinned release, verify SHA256, install, fix AppArmor fusermount3 if needed (Ubuntu 25.04+), apply overlayfs ID-mapped mount workaround. If no: skip. |
| 4 | Verification | `docker info`, `docker compose version`, test as app user, verify daemon config, verify Sysbox runtime if installed. |

### Key behaviors

- **Sysbox is opt-in** — not needed for most Docker setups, skill asks first
- **Distro-adaptive** — Docker install commands differ by distro, Claude adapts
- **Idempotent** — checks if Docker is already installed
- **Prerequisite check** — verifies users from `/setup-vps` exist (or that SSH works with expected users)

## File structure

```
.claude/skills/
  setup-vps/
    SKILL.md          # Full playbook (~400 lines)
  setup-docker/
    SKILL.md          # Full playbook (~300 lines)
```

## Not in scope

- Cloudflare tunnel setup (OpenClaw-specific)
- Application deployment (project-specific)
- Backup configuration (path-specific)
- Token rotation / maintenance (app-specific)
