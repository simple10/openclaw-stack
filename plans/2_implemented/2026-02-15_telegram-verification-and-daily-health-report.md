# Plan: Telegram verification + daily health report

## Context

Two problems:

1. **No Telegram credential verification during deployment.** `07-verification.md` § 7.5 runs `host-alert.sh` on a healthy VPS — no thresholds are breached, no state change occurs, so the script exits 0 without ever calling the Telegram API. Bad credentials pass silently.
2. **No daily health summary.** The alerter only fires on state *changes* (threshold breach or recovery). If the VPS is healthy for weeks, you never hear from it — no confirmation it's still alive and the bot still works.

## Changes

### 1. `openclaw-config.env.example` — new variable

```
HOSTALERT_DAILY_REPORT_TIME=9:00 AM UTC    # Daily health report time (human-readable, converted to cron by Claude)
```

Add under the existing Telegram variables in the `# === OPTIONAL ===` section.

### 2. `deploy/host-alert.sh` — add `--report` mode

Add a `--report` flag that sends a full status summary regardless of state changes.

**Behavior:**

- Collects all the same health checks (disk, memory, load, Docker, gateway, containers, backup)
- Always sends a message (bypasses state deduplication)
- Does NOT update the state file (so it doesn't interfere with alert dedup)
- Message includes all metrics with current values, not just breached thresholds

**Report message format:**

```
🖥️ hostname: Daily Status
  Disk: 45% (threshold: 85%) ✅
  Memory: 62% (threshold: 90%) ✅
  Load: 1.2 / 6 CPUs ✅
  Docker: ✅
  Gateway: ✅
  Containers: all healthy ✅
  Backup: 8h ago ✅
  Uptime: 15d 3h
```

If any check is breached, show the warning emoji instead:

```
  Disk: 92% (threshold: 85%) ⚠️
```

**Implementation:** Early in the script, check `$1` for `--report`. If set, collect metrics, format report, send via curl (checking response for `"ok":true` and logging errors to stderr), then exit. Skip state file logic entirely.

### 3. `playbooks/04-vps1-openclaw.md` § 4.8d — add daily report cron entry

After the existing `*/15 * * * *` cron entry, add a second entry for the daily report. The cron time is derived from `HOSTALERT_DAILY_REPORT_TIME` in the config (Claude converts the human-readable time to cron format at execution time).

```bash
sudo tee /etc/cron.d/openclaw-alerts << 'EOF'
# OpenClaw host alerter — checks disk, memory, CPU, container health
*/15 * * * * root /home/openclaw/scripts/host-alert.sh
# Daily health report (time configured via HOSTALERT_DAILY_REPORT_TIME)
<CRON_MINUTE> <CRON_HOUR> * * * root /home/openclaw/scripts/host-alert.sh --report
EOF
```

If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to `9:00 AM UTC` (i.e., `0 9 * * *`).

Only add the daily report cron line if Telegram is configured (both bot token and chat ID are set). If Telegram is not configured, only write the alerter line (same as current behavior).

### 4. `playbooks/07-verification.md` § 7.5 — add Telegram credential test

After the existing checks (script run + cron job), add a conditional Telegram delivery test:

```bash
# Test Telegram delivery (if configured)
TELEGRAM_TOKEN=$(sudo grep -oP 'HOSTALERT_TELEGRAM_BOT_TOKEN=\K.+' /home/openclaw/openclaw/.env)
TELEGRAM_CHAT=$(sudo grep -oP 'HOSTALERT_TELEGRAM_CHAT_ID=\K.+' /home/openclaw/openclaw/.env)

if [[ -n "$TELEGRAM_TOKEN" && -n "$TELEGRAM_CHAT" ]]; then
  RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT}" \
    -d "text=✅ OpenClaw host alerter verified on $(hostname)")
  if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "Telegram delivery: OK"
  else
    echo "Telegram delivery: FAILED"
    echo "$RESPONSE"
  fi
fi
```

Add expected output and troubleshooting guidance:

**Expected:** If Telegram is configured, a test message arrives in the chat. If not configured, this check is skipped.

**If Telegram test fails:**

- `"chat not found"` — the chat ID is wrong. See `docs/TELEGRAM.md` for getting the correct ID.
- `"Unauthorized"` — the bot token is wrong. Create a new bot via @BotFather.
- `"bot was blocked by the user"` — unblock the bot in Telegram.

### 5. `playbooks/07-verification.md` § 7.5 — verify daily report cron

Add a check that the daily report cron line exists (when Telegram is configured):

```bash
# Verify daily report cron entry (if Telegram configured)
grep 'host-alert.sh --report' /etc/cron.d/openclaw-alerts || echo "No daily report cron (Telegram not configured)"
```

### 6. `playbooks/08-post-deploy.md` § 8.6 — update deployment report

Update the Automated Jobs table to show the daily report:

```
| Host alerter | Every 15 minutes via Telegram | Active |
| Daily report | Daily at <HOSTALERT_DAILY_REPORT_TIME> via Telegram | Active |
```

When Telegram is not configured, show both as `Not configured`.

## Files modified

| File | Change |
|------|--------|
| `openclaw-config.env.example` | Add `HOSTALERT_DAILY_REPORT_TIME` |
| `deploy/host-alert.sh` | Add `--report` flag with full status summary |
| `playbooks/04-vps1-openclaw.md` § 4.8d | Add daily report cron entry |
| `playbooks/07-verification.md` § 7.5 | Add Telegram delivery test + daily report cron check |
| `playbooks/08-post-deploy.md` § 8.6 | Add daily report to Automated Jobs table |

## Verification

1. Run `scripts/telegram-test.sh` locally — confirms bot credentials work
2. After deployment, check `/etc/cron.d/openclaw-alerts` has both cron entries
3. Run `host-alert.sh --report` manually on VPS — confirms daily report sends and arrives in Telegram
4. Run § 7.5 verification — confirms Telegram delivery test passes
