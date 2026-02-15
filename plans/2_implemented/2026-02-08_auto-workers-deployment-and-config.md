# Plan: Workers-first deployment flow with placeholder validation

## Context

When a user copies `openclaw-config.env.example`, the AI Gateway and Log Worker fields contain placeholder values like `<account>` and `<worker-auth-token>`. The current Step 0 validation only checks if fields are "set" — it doesn't detect placeholders, so deployment could configure OpenClaw with invalid data.

Workers are deployed from the local machine (no VPS access needed) and must be deployed first to produce real URLs/tokens. Moving the workers playbook to position 01 reflects this dependency.

## Changes

### 1. Rename playbook files

```
playbooks/08-workers.md  →  playbooks/01-workers.md
playbooks/01-base-setup.md  →  playbooks/02-base-setup.md
```

Update internal section numbering inside each renamed file (8.x → 1.x, 1.x → 2.x).

### 2. Update all cross-references

**References to `08-workers` → `01-workers`:**

- `CLAUDE.md` — playbook table, execution order, troubleshooting index, core deployment list
- `playbooks/README.md` — execution order
- `playbooks/07-verification.md` — prerequisites
- `README.md` — config note, directory listing
- `plans/_queued/configure-openclaw-ai-gateway.md` — section reference
- `TODO.md` — task reference

**References to `01-base-setup` → `02-base-setup`:**

- `CLAUDE.md` — playbook table, execution order, troubleshooting index, core deployment list
- `playbooks/README.md` — execution order
- `playbooks/03-docker.md` — prerequisites
- `playbooks/04-vps1-openclaw.md` — prerequisites
- `playbooks/05-cloudflare-tunnel.md` — prerequisites
- `playbooks/00-analysis-mode.md` — state file format table
- `playbooks/extras/sandbox-and-browser.md` — prerequisites
- `plans/3_consideration/MIGRATING_OPENCLAW_SYSTEMD.md` — section references

### 3. Make log worker variables required

**`openclaw-config.env.example`** — uncomment `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` (remove leading `#`), add `(required)` comment.

### 4. Update CLAUDE.md Step 0 validation

Add to the required fields list:

- `LOG_WORKER_URL` — Must be set (Log Receiver Worker URL)
- `LOG_WORKER_TOKEN` — Must be set (Log Receiver auth token)

Add a new validation step **after** "required fields present" and **before** SSH test:

**Check for placeholder values:** Scan `AI_GATEWAY_WORKER_URL`, `AI_GATEWAY_AUTH_TOKEN`, `LOG_WORKER_URL`, and `LOG_WORKER_TOKEN` for angle-bracket placeholders (`<...>`).

**If placeholders detected:** Stop and execute `01-workers.md` to deploy both workers. After deployment, update `openclaw-config.env` with the real Worker URLs and auth tokens, then re-validate.

The stop message should say something like:

> "Worker configuration contains placeholder values. Workers must be deployed first to get real URLs and auth tokens.
>
> Deploying workers now using `playbooks/01-workers.md`..."

Then proceed to execute the workers playbook, capture the deployment outputs, and update `openclaw-config.env`.

### 5. Update CLAUDE.md execution order

```
1. Validate openclaw-config.env (including placeholder detection + auto worker deployment)
2. Execute 02-base-setup.md on VPS-1
3. Execute 03-docker.md on VPS-1
4. Execute 04-vps1-openclaw.md on VPS-1
5. Execute 05-cloudflare-tunnel.md on VPS-1
6. Execute 06-backup.md on VPS-1
7. Reboot VPS-1
8. Execute 07-verification.md
9. Execute 98-post-deploy.md
```

Workers deployment (01-workers) is now part of Step 0 validation — triggered automatically when placeholders are detected. Remove the separate workers step from the execution order.

Update the note: "Workers deployment runs from the local machine using `wrangler` and is triggered automatically during config validation if needed."

### 6. Update CLAUDE.md Configuration section example

Update the example config block to show `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` as required (not under `# Workers` optional heading).

### 7. Update CLAUDE.md playbook selection (A1)

Update the core deployment list from `(01, 03, 04, 05, 06-08)` to `(02, 03, 04, 05, 06-07)` and note that workers (01) are deployed during config validation.

## Files to modify

- `playbooks/08-workers.md` → rename to `playbooks/01-workers.md` + renumber sections
- `playbooks/01-base-setup.md` → rename to `playbooks/02-base-setup.md` + renumber sections
- `CLAUDE.md` — validation flow, execution order, playbook table, troubleshooting, config example
- `openclaw-config.env.example` — uncomment log worker variables
- `playbooks/README.md` — execution order
- `playbooks/07-verification.md` — prerequisites
- `playbooks/03-docker.md` — prerequisites
- `playbooks/04-vps1-openclaw.md` — prerequisites
- `playbooks/05-cloudflare-tunnel.md` — prerequisites
- `playbooks/00-analysis-mode.md` — state file table
- `playbooks/extras/sandbox-and-browser.md` — prerequisites
- `README.md` — config note, directory listing
- `plans/_queued/configure-openclaw-ai-gateway.md` — section reference
- `plans/3_consideration/MIGRATING_OPENCLAW_SYSTEMD.md` — section references
- `TODO.md` — task reference

## Verification

1. `grep -r "08-workers\|01-base-setup" playbooks/ CLAUDE.md README.md` should return zero matches
2. `grep -r "01-workers\|02-base-setup" playbooks/ CLAUDE.md README.md` should show updated references
3. Read the updated Step 0 flow in CLAUDE.md end-to-end to confirm the logic: exists → required fields → placeholder check → auto-deploy workers → SSH test
4. Confirm `openclaw-config.env.example` has `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` uncommented
