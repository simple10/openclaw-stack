# Portable VPS Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create two Claude Code skills (`/setup-vps` and `/setup-docker`) that harden any VPS server over SSH.

**Architecture:** Playbook-style skills — the SKILL.md IS the playbook. Claude reads it, discovers SSH credentials from `.env` or `.env.vps`, connects to the server, and executes hardening steps in order. Distro-adaptive (no hardcoded package manager).

**Tech Stack:** Claude Code skills (YAML frontmatter + markdown), bash over SSH

**Design doc:** `docs/plans/2026-03-04-portable-vps-skills-design.md`

---

### Task 1: Create skills directory structure

**Files:**
- Create: `.claude/skills/setup-vps/SKILL.md` (placeholder)
- Create: `.claude/skills/setup-docker/SKILL.md` (placeholder)

**Step 1: Create directory structure**

```bash
mkdir -p .claude/skills/setup-vps .claude/skills/setup-docker
```

**Step 2: Create placeholder SKILL.md files**

Each file should have just the frontmatter and a TODO comment so we can verify the skill is discoverable before writing the full content.

`.claude/skills/setup-vps/SKILL.md`:
```markdown
---
name: setup-vps
description: Use when the user wants to harden a VPS server - SSH hardening, firewall, fail2ban, user setup, kernel security. Triggered by /setup-vps or requests to secure/harden a server.
---

# TODO: Full skill content in Task 2
```

`.claude/skills/setup-docker/SKILL.md`:
```markdown
---
name: setup-docker
description: Use when the user wants to install Docker and optionally Sysbox on a VPS server. Triggered by /setup-docker or requests to install Docker on a server.
---

# TODO: Full skill content in Task 3
```

**Step 3: Commit**

```bash
git add .claude/skills/
git commit -m "Scaffold setup-vps and setup-docker skill directories"
```

---

### Task 2: Write `/setup-vps` SKILL.md

**Files:**
- Create: `.claude/skills/setup-vps/SKILL.md`

**Reference files to consult while writing:**
- `playbooks/02-base-setup.md` — source material for sections 1-4, 6
- `deploy/setup/system-hardening.sh` — source material for section 5
- `docs/plans/2026-03-04-portable-vps-skills-design.md` — the design spec

**Step 1: Write the full SKILL.md**

The skill must contain these sections in this order. Write the complete file content — do NOT use "see playbook" references; the skill must be self-contained.

**Frontmatter:**
```yaml
---
name: setup-vps
description: Use when the user wants to harden a VPS server - SSH hardening, firewall, fail2ban, user setup, kernel security. Triggered by /setup-vps or requests to secure/harden a server.
---
```

**Section: Overview** (~50 words)
- What the skill does (harden a fresh VPS)
- What it covers: users, SSH, firewall, fail2ban, kernel
- Distro-adaptive note

**Section: Env Var Discovery** (~100 words)
The exact logic from the design doc:
1. Read `.env` — if it has any of `SSH_USER`, `SSH_PORT`, `VPS_IP`, `SSH_KEY`, use `.env` as `ENV_FILE`
2. Else read `.env.vps` — if it exists and has those vars, use it as `ENV_FILE`
3. Else ask user interactively, save to `.env.vps`, add `.env.vps` to `.gitignore`
4. Display discovered values, confirm with user before proceeding
5. After hardening changes port/user, update `ENV_FILE` in place

Include the full var table:
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

**Section: SSH Connection**
Tell Claude to use this pattern for all remote commands:
```bash
ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new $SSH_USER@$VPS_IP "command"
```

**Section 1: System Update** — commands from playbook 2.1
- `apt update && apt upgrade -y`
- Install essential packages list
- Note: adapt `apt` to `dnf`/`yum`/`apk` if not Debian-based
- Troubleshooting: DNS resolution failure

**Section 2: Set Hostname** — from playbook 2.1a
- Only if `HOSTNAME` is set
- `hostnamectl set-hostname`

**Section 3: Create Users** — from playbook 2.2, parameterized
- Create `$VPS_SUDO_USER` with passwordless sudo, copy SSH keys from `$SSH_USER`
- Create `$VPS_APP_USER` with uid 1000, no sudo, no SSH
- Generate random passwords for both users
- Handle uid 1000 conflict (check if taken, reassign if needed)
- Idempotency: check if users already exist before creating

**Section 4: UFW Firewall** — from playbook 2.3
- Default deny/allow
- Allow both port 22 and `$SSH_HARDENED_PORT`
- Enable
- Note: adapt to `firewalld` if not Ubuntu/Debian

**Section 5: SSH Hardening** — from playbook 2.4
- Write `sshd_config.d/hardening.conf` with: non-standard port, disable root, key-only auth, strong ciphers, `AllowUsers` with both `$VPS_SUDO_USER` and `$SSH_USER` during transition
- Write systemd socket override for both ports
- Validate with `sshd -t` before applying
- Restart socket (NOT ssh.service)
- **MANDATORY GATE:** Tell user to test new port from local machine. Do NOT proceed until confirmed.
- After confirmation: remove port 22 from socket override, remove `$SSH_USER` from AllowUsers, `ufw delete allow 22/tcp`
- Update `ENV_FILE`: set `SSH_USER=$VPS_SUDO_USER`, `SSH_PORT=$SSH_HARDENED_PORT`, remove `SSH_HARDENED_PORT` line
- Troubleshooting: connection refused, permission denied recovery steps

**Section 6: System Hardening** — from `deploy/setup/system-hardening.sh`
- Swap file (default 8G, configurable)
- fail2ban jail for SSH on `$SSH_PORT`
- unattended-upgrades config
- Kernel sysctl: all the hardening params from `99-security.conf`
- Verification: check each subsystem

**Section 7: Final Verification**
- Test SSH as `$VPS_SUDO_USER` on hardened port
- Check UFW status
- Check fail2ban status
- Check sysctl values
- Print summary of what was configured

**Step 2: Review the file**

Read back the file and verify:
- All commands use `$VPS_SUDO_USER` / `$VPS_APP_USER` (never hardcoded `adminclaw` / `openclaw`)
- All SSH commands use `$SSH_KEY`, `$SSH_PORT`, `$SSH_USER`, `$VPS_IP`
- Env var discovery logic is complete
- SSH test gate is present and mandatory
- Each section has idempotency checks

**Step 3: Commit**

```bash
git add .claude/skills/setup-vps/SKILL.md
git commit -m "Add /setup-vps skill for VPS server hardening"
```

---

### Task 3: Write `/setup-docker` SKILL.md

**Files:**
- Create: `.claude/skills/setup-docker/SKILL.md`

**Reference files to consult while writing:**
- `playbooks/03-docker.md` — source material for sections 1-2
- `playbooks/03b-sysbox.md` — source material for section 3
- `docs/plans/2026-03-04-portable-vps-skills-design.md` — the design spec

**Step 1: Write the full SKILL.md**

**Frontmatter:**
```yaml
---
name: setup-docker
description: Use when the user wants to install Docker and optionally Sysbox on a VPS server. Triggered by /setup-docker or requests to install Docker on a server.
---
```

**Section: Overview** (~50 words)
- What: Install Docker CE + Compose, harden daemon, optionally install Sysbox
- Prerequisite: SSH access to a server (run `/setup-vps` first or have equivalent)

**Section: Env Var Discovery**
Same preamble as `/setup-vps` — identical logic for `.env` / `.env.vps`.
Needs: `VPS_IP`, `SSH_USER`, `SSH_PORT`, `SSH_KEY`, `VPS_SUDO_USER`, `VPS_APP_USER`.

**Section: Prerequisite Check**
- Verify SSH works with current credentials
- Verify `$VPS_SUDO_USER` and `$VPS_APP_USER` exist on the server
- If not, suggest running `/setup-vps` first

**Section 1: Install Docker** — from playbook 3.1
- Add Docker GPG key + apt repo (adapt for distro)
- Install docker-ce, containerd, compose plugin, buildx
- Add `$VPS_SUDO_USER` and `$VPS_APP_USER` to docker group
- Enable and start Docker
- Idempotency: check if Docker is already installed
- Troubleshooting: package not found, GPG key issues

**Section 2: Docker Daemon Hardening** — from playbook 3.2
- Write `/etc/docker/daemon.json`: bind 127.0.0.1, json-file logging (50m/5 files), overlay2, live-restore, no-new-privileges, disable userland proxy, nofile ulimits
- Restart Docker
- Troubleshooting: JSON syntax errors, daemon won't start

**Section 3: Install Sysbox (optional)** — from playbook 3b
- **Ask user:** "Do you need Docker-in-Docker (Sysbox)? This is for running Docker containers inside Docker containers." If no, skip this section.
- Download pinned version (0.6.7), verify SHA256 checksum
- Install dependencies (jq, fuse), install .deb
- AppArmor fusermount3 fix: check if profile is enforcing, disable if needed (Ubuntu 25.04+)
- Overlayfs ID-mapped mount workaround: create systemd override with `--disable-ovfs-on-idmapped-mount`
- Idempotency: check if Sysbox is already installed and at correct version

**Section 4: Verification**
- `docker info` — check storage driver, logging, security options
- `docker compose version`
- Test as `$VPS_APP_USER`: `sudo -u $VPS_APP_USER docker ps`
- If Sysbox: verify runtime in `docker info`, check sysbox-mgr override
- Print summary

**Step 2: Review the file**

Read back and verify:
- All user references use `$VPS_SUDO_USER` / `$VPS_APP_USER`
- Sysbox section is clearly gated behind user prompt
- Distro-adaptive notes for non-Debian systems
- Idempotency checks present

**Step 3: Commit**

```bash
git add .claude/skills/setup-docker/SKILL.md
git commit -m "Add /setup-docker skill for Docker and Sysbox installation"
```

---

### Task 4: Verify skills are discoverable

**Step 1: Check skill loading**

List available skills and verify both appear. If they don't, check that the `.claude/skills/` directory is recognized by the Claude Code skill discovery mechanism.

**Step 2: Test invocation**

Try invoking `/setup-vps` — verify the skill content loads (don't actually run against a server, just confirm the skill file is read and the preamble runs).

**Step 3: Final commit with any fixes**

If any adjustments were needed for discovery, commit them.

```bash
git add -A && git commit -m "Fix skill discovery if needed"
```
