# 00 - Analysis Mode

Analyze existing VPS deployments to determine current state and verify implementations.

## Critical Rule

**NEVER make modifications during analysis.** This mode is strictly read-only.

- Run verification commands only (status checks, file reads, service queries)
- Do not fix issues, even obvious ones, without first getting user approval
- Do not create, edit, or delete any files on the VPS
- Do not restart services or modify configurations
- Record all findings, then ask the user what to do

If you discover issues, present them to the user and wait for explicit direction before making any changes.

## Overview

Use this playbook when connecting to VPSs that may already have OpenClaw deployed. Analysis mode runs verification checks without making changes, then records the state for future sessions.

## When to Use

- New conversation with existing VPSs
- After manual changes were made outside of Claude
- To verify deployment health
- Before implementing new features on existing infrastructure

## Prerequisites

- SSH access to target VPS(s)
- `openclaw-config.env` configured with VPS IPs

---

## Analysis Process

### 1. Determine Scope

Ask the user:

> "What should I analyze?"
>
> - **Full analysis** - Analyze VPS-1 (all playbooks)
> - **Single playbook** - Verify specific playbook only

If single playbook, ask which one.

### 2. Create State Directory

```bash
mkdir -p .state
```

### 3. Run Verification

**For base playbooks (01-06):**

- Use `07-verification.md` verification commands
- These are designed to check the core deployment holistically

**For networking playbooks:**

- Use the Verification section in `05-cloudflare-tunnel.md`

**For optional features (`extras/`):**

- Use the Verification section in each specific playbook
- Only check extras that show signs of being installed

**For single playbook verification:**

- Base playbooks 01-06: Use relevant sections from `07-verification.md`
- All others: Use the playbook's own Verification section

### 4. Detect Optional Features

Check for signs of optional features:

```bash
# Example: Check if rich sandbox image exists (sandbox-and-browser)
docker images | grep openclaw-sandbox-common

# Add detection commands for each extras/ playbook as they're created
```

Only add optional features to the state file if they're detected.

### 5. Record State

Create or update `.state/<IP>.md` with findings.

---

## State File Format

```markdown
---
vps: <IP>
role: <Role>
ssh-user: <SSH_USER>
ssh-port: <SSH_PORT>
last-analyzed: YYYY-MM-DD HH:MM:SS
state: ready | error
---

## Base Playbooks

| Playbook | Status | Verified | Notes |
|----------|--------|----------|-------|
| 02-base-setup | ✓ | YYYY-MM-DD | |
| 03-docker | ✓ | YYYY-MM-DD | |
| 04-vps1-openclaw | ✓ | YYYY-MM-DD | |
| 05-cloudflare-tunnel | ✓ | YYYY-MM-DD | |
| 06-backup | ✗ | YYYY-MM-DD | Cron job missing |

## Networking

| Playbook | Status | Verified | Notes |
|----------|--------|----------|-------|
| cloudflare-tunnel | ✓ | YYYY-MM-DD | |

## Optional Features

| Playbook | Status | Verified | Notes |
|----------|--------|----------|-------|
| extras/sandbox-and-browser | ✓ | YYYY-MM-DD | |

## Issues

- 06-backup: `/etc/cron.d/openclaw-backup` not found

## Deviations

- Custom SSH port: 2222 (not standard 222)
```

**Status symbols:**

- `✓` - Verification passed
- `✗` - Verification failed
- `~` - Partially implemented or unknown

**Notes column:** Brief description of what failed or what's different.

**Optional Features table:** Only include features that are actually detected/implemented. Omit the entire section if no optional features are installed.

---

## After Analysis

Present findings to the user:

```
## Analysis Complete: <IP>

**Base Playbooks:** 5/6 passing
**Networking:** cloudflare-tunnel ✓
**Optional Features:** 1 detected (sandbox-and-browser ✓)

### Issues Found

1. **06-backup** - Cron job missing
   - Expected: `/etc/cron.d/openclaw-backup`
   - Found: File does not exist

### What would you like to do?

- Fix the issues listed above
- Implement additional features
- Continue without changes
```

Wait for user direction before making any changes.

---

## Resuming from State

When starting a new session with existing state files:

1. Read `.state/<IP>.md` for each VPS
2. Inform user of last known state
3. Ask if they want to:
   - Re-run analysis (state may be outdated)
   - Trust existing state and proceed
   - Fix previously recorded issues

---

## Single Playbook Verification

When verifying a single playbook:

1. Run only that playbook's verification checks
2. Update only that row in the state file
3. Report results for that playbook only

Example:

```
## Verification: 06-backup

**Status:** ✗ Failed

### Checks
- [✓] Backup script exists
- [✗] Cron job installed
- [✓] Backup directory exists

### Failed Check Details
- Cron job: `/etc/cron.d/openclaw-backup` not found

Fix this issue?
```

---

## Notes

- Analysis mode is read-only - no changes are made
- State files are gitignored (contain IP addresses)
- Always ask before making fixes
- State files help Claude maintain context across sessions
