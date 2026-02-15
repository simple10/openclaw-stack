# Plan: Parameterize SSH hardening — remove hardcoded `ubuntu` and `222`

## Context

The playbooks hardcode `ubuntu` as the initial SSH user and `222` as the hardened SSH port. This breaks on non-Ubuntu hosts (where the initial user might be `root`, `debian`, etc.) and prevents users from choosing a different hardened port. We need one new config variable (`SSH_HARDENED_PORT`) and systematic replacement of all hardcoded values with placeholders.

## Design

**One new variable:** `SSH_HARDENED_PORT=222` in `openclaw-config.env`. It's ephemeral — only exists during the hardening step, then gets deleted after `SSH_PORT` is updated to match.

**Variable usage rules:**

- `<SSH_USER>` / `<SSH_PORT>` = current working values (from config)
- `<SSH_HARDENED_PORT>` = target port, used ONLY in `02-base-setup.md` § 2.3–2.4
- After hardening succeeds: `SSH_PORT=<SSH_HARDENED_PORT>`, then delete `SSH_HARDENED_PORT` from config
- All other playbooks use `<SSH_PORT>` (which by then equals the hardened value)
- `adminclaw` stays hardcoded — it's a user we create, not a provider default
- Default to `222` if `SSH_HARDENED_PORT` is not set in config

## Changes

### 1. `openclaw-config.env.example`

- Add `SSH_HARDENED_PORT=222` with comment: `# Target SSH port for hardening (removed after hardening completes)`
- Change `SSH_USER` comment from `# Changed to adminclaw during hardening` to `# Initial SSH user — set to match your VPS provider (ubuntu, root, debian, etc.)`
- Change `SSH_PORT` comment from `# Changed to 222 during hardening` to `# Updated to SSH_HARDENED_PORT value after hardening`

### 2. `playbooks/02-base-setup.md` — the big one

**Variables section:** Add `SSH_HARDENED_PORT` with note about defaulting to 222.

**Overview/Prerequisites (lines 12, 20, 38, 45):**

- `SSH hardening (port 222, key-only)` → `SSH hardening (custom port, key-only)`
- `Fresh Ubuntu VPS with SSH access as \`ubuntu\` user` → `Fresh Linux VPS with SSH access`
- `SSH_USER - Initial SSH user (ubuntu)` → `SSH_USER - Initial SSH user (e.g., ubuntu, root, debian — depends on provider)`
- Line 45 already says "or whatever the default is" — just clean up to use `<SSH_USER>`

**§ 2.2 (line 108):** `# Copy SSH authorized_keys from current user (ubuntu)` → `# Copy SSH authorized_keys from current user (<SSH_USER>)`

**§ 2.3 UFW (lines 167, 174, 176):**

- `allow port 222` → `allow port <SSH_HARDENED_PORT>`
- `sudo ufw allow 222/tcp` → `sudo ufw allow <SSH_HARDENED_PORT>/tcp`

**§ 2.4 SSH Hardening — all steps:**

- Every `222` in sshd_config, socket override, ssh commands, ss grep, echo messages, sed commands → `<SSH_HARDENED_PORT>`
- Every `ubuntu` in AllowUsers, sed commands, fallback SSH commands → `<SSH_USER>`
- The sed that updates `SSH_PORT` should write `SSH_PORT=<SSH_HARDENED_PORT value>` and also delete the `SSH_HARDENED_PORT` line
- Add note at top of § 2.4: "If `SSH_HARDENED_PORT` is not set in config, default to `222`."

**§ 2.5 Verification (line 152):** `ssh -p 222` → `ssh -p <SSH_PORT>` (by this point SSH_PORT is already updated)

**§ 2.6 Fail2ban (line 411):** `port = 222` → `port = <SSH_PORT>` (runs after § 2.4, so SSH_PORT is updated)

**Verification section (line 556-557):** `ssh -p 222` → `ssh -p <SSH_PORT>`

**Troubleshooting (line 576):** `SSH Connection Refused on Port 222` → `SSH Connection Refused on Port <SSH_PORT>`

### 3. Other playbooks — replace `222` with `<SSH_PORT>`

These all run after hardening, so `SSH_PORT` is already the hardened value:

- `playbooks/03-docker.md:16` — `port 222` → `port <SSH_PORT>`
- `playbooks/04-vps1-openclaw.md:21` — `port 222` → `port <SSH_PORT>`
- `playbooks/06-backup.md:17` — `port 222` → `port <SSH_PORT>`
- `playbooks/07-verification.md:268,278,287,324,411` — all `222` → `<SSH_PORT>`
- `playbooks/08-post-deploy.md:325` — `ssh -p 222` → `ssh -p <SSH_PORT>`
- `playbooks/maintenance.md:100,104,153` — all `222` → `<SSH_PORT>`

### 4. `playbooks/00-fresh-deploy-setup.md`

- Line 71: `SSH_USER=ubuntu`, `SSH_PORT=22` → use `<SSH_USER>`, `<SSH_PORT>` placeholders
- Line 74: `ssh ... -p 22 ubuntu@` → `ssh ... -p <SSH_PORT> <SSH_USER>@`
- Line 259: `port 222` → `port <SSH_HARDENED_PORT>`

### 5. `CLAUDE.md`

- Line 56: `ubuntu`/`22` ... `adminclaw`/`222` → `<SSH_USER>`/`<SSH_PORT>` ... `adminclaw`/`<SSH_HARDENED_PORT>`
- Line 104: Already uses `<SSH_PORT:222>` notation — change to `<SSH_PORT:222>` (this is fine as-is, it shows the default)

## Not changed

- `adminclaw` — hardcoded everywhere, by design (we create this user)
- `README.md`, `REQUIREMENTS.md`, `docs/`, `notes/` — general documentation describing the deployed state; not playbook instructions. Can be updated separately if desired.
- `playbooks/03-docker.md:32,37` — `ubuntu` here refers to the Ubuntu OS for Docker's apt repo, not the SSH user

## Verification

After changes, grep for:

- `grep -rn '222' playbooks/` — should only appear in the default-value note for SSH_HARDENED_PORT
- `grep -rn 'ubuntu' playbooks/` — should only appear in OS-specific contexts (apt repos, distro references), never as an SSH user
