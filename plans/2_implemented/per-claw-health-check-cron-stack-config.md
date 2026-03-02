# Plan: Per-Claw Health Check Cron Toggle

## Context

The "Daily VPS Health Check" OpenClaw CLI cron job currently registers on **every** claw unconditionally. This is redundant — `host-alert.sh` already runs every 15 minutes on the host and sends Telegram alerts. With multiple claws, the user gets bombarded: one alert from `host-alert.sh` plus one from each claw's agent analyzing the same report.

The fix: add a per-claw `health_check_cron` toggle in `stack.yml`, defaulting to `false`.

---

## Changes

### 1. `stack.yml.example` — Add toggle to defaults

Add `health_check_cron: false` to the `defaults` section (after `allow_updates`). Show an override example in the commented-out work-claw.

### 2. `build/pre-deploy.mjs` — Emit per-claw var to stack.env

In `generateStackEnv()` per-claw loop (~line 490), add:

```javascript
lines.push(`STACK__CLAWS__${envKey}__HEALTH_CHECK_CRON=${claw.health_check_cron ?? false}`);
```

### 3. `deploy/host/register-cron-jobs.sh` — Skip registration when disabled

In the Section 4 claw loop, before the existing idempotency check:

```bash
envKey=$(echo "$CLAW" | tr '-' '_' | tr '[:lower:]' '[:upper:]')
varName="STACK__CLAWS__${envKey}__HEALTH_CHECK_CRON"
if [ "${!varName:-false}" != "true" ]; then
  echo "    CLI health check cron disabled for $CLAW, skipping."
  continue
fi
```

---

## Behavior

| `health_check_cron` | Result |
|---------------------|--------|
| `false` (default) | Cron not registered; host-alert.sh still runs |
| `true` (per-claw override) | Cron registered as before |

---

## Files

| File | Change |
|------|--------|
| `stack.yml.example` | Add `health_check_cron: false` to defaults |
| `build/pre-deploy.mjs` | Emit `STACK__CLAWS__<KEY>__HEALTH_CHECK_CRON` in stack.env |
| `deploy/host/register-cron-jobs.sh` | Check per-claw toggle before registering |
