# VPS Status Report Cron Overhaul

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the daily VPS status report cron so it doesn't trigger OpenClaw's built-in "healthcheck" skill, and revert the bind mount from `/tmp/.host-status` back to `/workspace/.host-status`.

**Architecture:** The host-status files (health.json, maintenance.json) are written by host cron scripts to each instance's `.openclaw/workspace/.host-status/` directory. The OpenClaw sandbox bind-mounts this into the sandbox at `/workspace/.host-status/` so the cron agent can read them directly with the read tool. The cron job name and prompt must avoid "health check" phrasing to prevent triggering OpenClaw's upstream "healthcheck" skill.

**Tech Stack:** Shell scripts, JSONC config files, CHANGELOG.md

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `openclaw/personal-claw/openclaw.jsonc` | Modify ~L196-206 | Revert bind target to `/workspace/.host-status`, add `dangerouslyAllowExternalBindSources` |
| `openclaw/work-claw/openclaw.jsonc` | Modify ~L196-206 | Same as personal-claw |
| `openclaw/default/openclaw.jsonc` | Modify ~L193-203 | Same — this is the template other claws copy from |
| `deploy/host/register-cron-jobs.sh` | Modify ~L158-223 | Rename cron job, rewrite prompt, update file paths, rename stack.yml toggle |
| `build/pre-deploy.mjs` | Modify ~L543 | Rename env var from `HEALTH_CHECK_CRON` to `STATUS_REPORT_CRON` |
| `stack.yml.example` | Modify ~L79, ~L99 | Rename `health_check_cron` to `status_report_cron` |
| `CHANGELOG.md` | Modify (prepend entry) | Migration steps for existing deployments |

---

### Task 1: Revert bind mount in all three openclaw.jsonc files

**Files:**
- Modify: `openclaw/personal-claw/openclaw.jsonc:196-206`
- Modify: `openclaw/work-claw/openclaw.jsonc:196-206`
- Modify: `openclaw/default/openclaw.jsonc:193-203`

- [ ] **Step 1: Update personal-claw/openclaw.jsonc**

Replace the docker bind section (~L196-206) with:
```jsonc
          "docker": {
            // VPS status reports (health.json, maintenance.json) written by host cron scripts.
            // Bind into sandbox workspace so the read tool can access them at /workspace/.host-status/.
            // The status report cron reads these and notifies the user over Telegram if there are any issues.
            // Optionally comment this out if status_report_cron is disabled in stack.yml
            "dangerouslyAllowExternalBindSources": true,
            "binds": [
              "/home/node/.openclaw/workspace/.host-status:/workspace/.host-status:ro"
            ]
          }
```

Key changes:
- Bind target: `/tmp/.host-status` -> `/workspace/.host-status`
- Bind source: `workspace/host-status` (no dot) -> `workspace/.host-status` (with dot — matches where host-alert.sh actually writes)
- Added `dangerouslyAllowExternalBindSources: true` (required because source is outside sandbox workspace)
- Removed `dangerouslyAllowReservedContainerTargets` (NOT needed — `/workspace/.host-status` is a subdirectory the sandbox already has access to, the flag is only needed for paths like `/workspace` itself)
- Updated comments: "health_check_cron" -> "status_report_cron", removed "health check" language

- [ ] **Step 2: Update work-claw/openclaw.jsonc**

Apply the exact same change as Step 1.

- [ ] **Step 3: Update default/openclaw.jsonc**

Apply the same change. Note: the default config currently has a different comment about `readOnlyRoot` — replace entirely with the same block as Step 1.

- [ ] **Step 4: Commit**

```bash
git add openclaw/personal-claw/openclaw.jsonc openclaw/work-claw/openclaw.jsonc openclaw/default/openclaw.jsonc
git commit -m "Revert host-status bind to /workspace/.host-status, remove dangerouslyAllowReservedContainerTargets"
```

---

### Task 2: Rename cron job and rewrite prompt in register-cron-jobs.sh

**Files:**
- Modify: `deploy/host/register-cron-jobs.sh:158-223`

- [ ] **Step 1: Rename stack.yml toggle variable**

At line 164, change:
```bash
# OLD
varName="STACK__CLAWS__${envKey}__HEALTH_CHECK_CRON"
```
to:
```bash
# NEW
varName="STACK__CLAWS__${envKey}__STATUS_REPORT_CRON"
```

Update the skip message at line 166:
```bash
# OLD
echo "    CLI health check cron disabled for $CLAW, skipping."
# NEW
echo "    Status report cron disabled for $CLAW, skipping."
```

- [ ] **Step 2: Rename cron job name**

The cron job name is used for idempotent registration (grep check at L172) and the `--name` flag (L180). Change ALL occurrences of `"Daily VPS Health Check"` to `"Daily VPS Status Report"`.

Line 172:
```bash
if openclaw --instance "$CLAW" cron list 2>/dev/null | grep -q "Daily VPS Status Report"; then
    echo "    Cron job 'Daily VPS Status Report' already registered on $CLAW, skipping."
```

Line 177-180:
```bash
echo "    Registering 'Daily VPS Status Report' on $CLAW..."
openclaw --instance "$CLAW" cron add \
    --name "Daily VPS Status Report" \
```

- [ ] **Step 3: Rewrite the cron prompt message**

Replace the entire `--message` content (L189-220) with:

```bash
    --message "Read the VPS status report files and analyze them:

1. Read /workspace/.host-status/health.json (resource metrics)
2. Read /workspace/.host-status/maintenance.json (OS maintenance)

Analyze for issues that need human attention:

Resource status (health.json):
- containers: inspect each entry — \"stopped\" or \"restarting\" means a claw is down
- containers_ok is false means at least one expected container is not running
- disk_pct approaching or exceeding disk_threshold
- memory_pct approaching or exceeding memory_threshold
- load_avg significantly above cpu_count
- docker_ok is false
- crashed is non-empty (unexpected containers restarting)
- backup_ok is false or backup_age_hours > 36
- timestamp older than 30 minutes (monitoring may be broken)

Maintenance status (maintenance.json):
- security_updates > 0 (pending security patches)
- reboot_required is true
- failed_services is not \"none\"
- uptime_days > 90 (consider scheduled reboot)
- timestamp older than 26 hours (maintenance monitor may not be running)

If everything looks good, respond with exactly: HEARTBEAT_OK

If any issues are found, send a concise alert with:
- What's wrong (use emoji indicators: critical, warning)
- Why it matters (one line per issue)
- Recommended action
Keep it brief - this goes to Telegram."
```

Key changes:
- File paths: `/tmp/.host-status/` -> `/workspace/.host-status/`
- Section headers: "Health" -> "Resource status", "Maintenance" -> "Maintenance status" (avoid "health" triggering the skill)
- Replaced "healthy" with "looks good"
- Replaced "check each entry" with "inspect each entry"
- Replaced "monitoring may be broken" (kept — no "health" or "check")
- Replaced "checker may not be running" with "maintenance monitor may not be running"

- [ ] **Step 4: Commit**

```bash
git add deploy/host/register-cron-jobs.sh
git commit -m "Rename cron to Daily VPS Status Report, avoid health/check language that triggers upstream skill"
```

---

### Task 3: Rename stack.yml toggle from health_check_cron to status_report_cron

**Files:**
- Modify: `stack.yml.example:79,99`
- Modify: `build/pre-deploy.mjs:543`

- [ ] **Step 1: Update stack.yml.example defaults**

Line 79:
```yaml
# OLD
  health_check_cron: false
# NEW
  status_report_cron: false
```

Line 99:
```yaml
# OLD
    health_check_cron: true  # Enable health check cron on the main claw - not needed on each claw
# NEW
    status_report_cron: true  # Enable VPS status report cron on one claw - not needed on each
```

- [ ] **Step 2: Update build/pre-deploy.mjs**

Line 543:
```javascript
// OLD
lines.push(`STACK__CLAWS__${envKey}__HEALTH_CHECK_CRON=${claw.health_check_cron ?? false}`)
// NEW
lines.push(`STACK__CLAWS__${envKey}__STATUS_REPORT_CRON=${claw.status_report_cron ?? false}`)
```

- [ ] **Step 3: Update the user's stack.yml** (gitignored, not committed)

Same rename as stack.yml.example — `health_check_cron` -> `status_report_cron`.

- [ ] **Step 4: Commit**

```bash
git add stack.yml.example build/pre-deploy.mjs
git commit -m "Rename health_check_cron to status_report_cron in stack config"
```

---

### Task 4: Add CHANGELOG.md entry

**Files:**
- Modify: `CHANGELOG.md` (prepend after line 7)

- [ ] **Step 1: Add changelog entry**

Insert after the `---` on line 7:

```markdown

## 2026-03-14 — Rename VPS status report cron, fix bind mount path

The daily VPS status report cron job has been renamed and the sandbox bind mount path reverted from `/tmp/.host-status` to `/workspace/.host-status`. This avoids conflicts with OpenClaw's upstream "healthcheck" skill which was being incorrectly triggered by the old "Daily VPS Health Check" cron name and prompt.

**What changed:**
- `stack.yml.example`: `health_check_cron` renamed to `status_report_cron`
- `build/pre-deploy.mjs`: env var `HEALTH_CHECK_CRON` renamed to `STATUS_REPORT_CRON`
- `deploy/host/register-cron-jobs.sh`: cron renamed from "Daily VPS Health Check" to "Daily VPS Status Report", prompt reworded to avoid "health"/"check" language, file paths updated to `/workspace/.host-status/`
- `openclaw/*/openclaw.jsonc`: bind mount reverted from `/tmp/.host-status` to `/workspace/.host-status`, removed `dangerouslyAllowReservedContainerTargets`, kept `dangerouslyAllowExternalBindSources`

**Migration:**

1. Update `stack.yml` — rename the toggle:
   ```yaml
   defaults:
     status_report_cron: false    # was: health_check_cron

   claws:
     personal-claw:
       status_report_cron: true   # was: health_check_cron
   ```

2. Update `openclaw.jsonc` for each claw — change the sandbox docker bind:
   ```jsonc
   // In agents.main.sandbox.docker:
   "dangerouslyAllowExternalBindSources": true,
   "binds": [
     "/home/node/.openclaw/workspace/.host-status:/workspace/.host-status:ro"
   ]
   // Remove dangerouslyAllowReservedContainerTargets if present
   ```

3. Rebuild and deploy:
   ```bash
   npm run pre-deploy
   scripts/sync-deploy.sh --all
   ```

4. On the VPS, remove the old cron job and re-register:
   ```bash
   # Remove old cron (run inside the claw container or via openclaw CLI):
   openclaw --instance personal-claw cron remove --name "Daily VPS Health Check"

   # Re-register cron jobs:
   sudo bash /home/<project>/openclaw/host/register-cron-jobs.sh
   ```

5. Restart the claw container to pick up the new bind mount:
   ```bash
   sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d --force-recreate'
   ```

---
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "Add changelog entry for VPS status report cron rename and bind mount fix"
```

---

### Task 5: Deploy and verify on VPS

- [ ] **Step 1: Rebuild artifacts**
```bash
npm run pre-deploy
```

- [ ] **Step 2: Sync to VPS**
```bash
scripts/sync-deploy.sh --all --force
```

- [ ] **Step 3: Remove old cron job on VPS**
```bash
ssh <VPS> "openclaw --instance personal-claw cron remove --name 'Daily VPS Health Check'"
```

- [ ] **Step 4: Restart claw container**
```bash
ssh <VPS> "sudo -u openclaw bash -c 'cd /home/muxxibot/openclaw && docker compose up -d --force-recreate muxxibot-openclaw-personal-claw'"
```

- [ ] **Step 5: Re-register cron jobs**
```bash
ssh <VPS> "sudo bash /home/muxxibot/openclaw/host/register-cron-jobs.sh"
```

- [ ] **Step 6: Verify the new cron is registered**
```bash
ssh <VPS> "openclaw --instance personal-claw cron list"
```
Expect: "Daily VPS Status Report" in the list, "Daily VPS Health Check" absent.

- [ ] **Step 7: Verify bind mount works**
```bash
ssh <VPS> "sudo -u openclaw bash -c 'cd /home/muxxibot/openclaw && docker compose exec muxxibot-openclaw-personal-claw cat /home/node/.openclaw/workspace/.host-status/health.json'"
```
Expect: valid JSON with current timestamp, `containers_ok: true`.
