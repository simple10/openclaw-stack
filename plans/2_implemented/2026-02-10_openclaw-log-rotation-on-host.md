# Plan: Add logrotate for OpenClaw application logs

## Context

The hook-generated log files (`debug.log`, `commands.log`) and the backup cron log (`backup.log`) in `~/.openclaw/logs/` grow unbounded. Docker container logs already have rotation via the `json-file` driver in `deploy/docker-compose.override.yml`, but these application-level JSONL files do not. This is tracked in `notes/TODO.md` line 7.

## Changes

### 1. Create `deploy/logrotate-openclaw`

logrotate config for the three host-path log files. Uses `copytruncate` (safe for append-only writers like `fs.appendFile` and `>>`), `delaycompress` (keeps most recent rotated file readable), weekly rotation with 4 weeks retained.

### 2. Update `playbooks/04-vps1-openclaw.md` — new section 4.8g

Add a "Log Rotation" step between 4.8f and 4.9 that deploys `deploy/logrotate-openclaw` to `/etc/logrotate.d/openclaw` on the VPS. Uses the `# SOURCE:` / `# <<< >>>` sentinel pattern per CLAUDE.md rules. Includes a dry-run test.

- File: `playbooks/04-vps1-openclaw.md` (insert after section 4.8f, before 4.9)

### 3. Update `playbooks/07-verification.md` — new section 7.5a

Add a "Verify Log Rotation" check between 7.5 (Host Alerter) and 7.6 (Security Checklist). Verifies the config file exists, passes `logrotate -d` dry run, and optionally forces a rotation cycle to confirm.

- File: `playbooks/07-verification.md` (insert after section 7.5, before 7.6)

### 4. Update `notes/TODO.md`

Mark the log rotation TODO (line 7) as done: `- [x]`.

### 5. Deploy to VPS now

SCP the config, install to `/etc/logrotate.d/openclaw`, dry-run test, and force one rotation cycle to verify.

## Files to create/modify

| File | Action |
|------|--------|
| `deploy/logrotate-openclaw` | **Create** — logrotate config |
| `playbooks/04-vps1-openclaw.md` | **Edit** — add section 4.8g |
| `playbooks/07-verification.md` | **Edit** — add section 7.5a |
| `notes/TODO.md` | **Edit** — mark done |

## Verification

1. `sudo logrotate -d /etc/logrotate.d/openclaw` — dry run shows no errors
2. `sudo logrotate -f /etc/logrotate.d/openclaw` — force rotation, confirm `.1` files appear
3. Send a `/new` via webchat, confirm `debug.log` continues receiving new entries after rotation
