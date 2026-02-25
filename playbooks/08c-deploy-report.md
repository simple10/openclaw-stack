# 08c - Deployment Report

Generate and save the final deployment report.

## Prerequisites

- All previous playbooks completed
- Device pairing confirmed working (`08b-pair-devices.md`)

---

**IMPORTANT:** After the user confirms the chat interface is working, output a complete deployment report. This is the final step — do NOT skip it.

The report is saved to `.deploy-logs/<timestamp>/08-deploy-report.md` (same timestamp directory as the subagent logs) and displayed to the user. After outputting the report, include a clickable reference to the saved file.

Collect the following values and present them in a single, neatly formatted report:

## Values to collect

1. **User passwords** — these were generated and displayed during `02-base-setup.md` section 2.2. If you no longer have them in context (e.g., context was compressed), check the `# DEPLOYED:` lines in `openclaw-config.env` first (`grep 'DEPLOYED.*PASSWORD' openclaw-config.env`). If those are also empty, inform the user the passwords were displayed during base setup and can be reset via VNC/console access.

2. **Per-claw gateway tokens** — read from container env var (NOT openclaw.json):

   ```bash
   CLAWS=$(ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
     "sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' | sort")
   for CLAW in $CLAWS; do
     TOKEN=$(ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
       "sudo docker exec --user node $CLAW printenv OPENCLAW_GATEWAY_TOKEN")
     echo "$CLAW: $TOKEN"
   done
   ```

3. **Domain and URLs** — read `source-config.sh OPENCLAW_DOMAIN`, `source-config.sh OPENCLAW_DOMAIN_PATH`, `source-config.sh OPENCLAW_DASHBOARD_DOMAIN`, and per-claw tunnel routes.

## AI proxy status

Include the appropriate callout in the report based on `08a-configure-llm-proxy.md` outcome:

**If configured and working (Step 3 returned 200):**

> **AI Proxy:** Configured and verified.

**If configured but test failed (Step 3 returned an error):**

> **AI Proxy:** Anthropic API key is set but the test request failed. Check the key and provider billing. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for troubleshooting.

**If skipped (user chose to skip in Step 2):**

> **AI Proxy:** Not configured. See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) to add provider API keys.

## Report format

Output the report using exactly this structure:

```
## OpenClaw Deployment Report

**Date:** <current date>
**VPS IP:** <VPS1_IP>
**Domain:** <OPENCLAW_DOMAIN>

---

### VPS Users

| User | Password | Purpose |
|------|----------|---------|
| `adminclaw` | `<password>` | SSH admin, passwordless sudo |
| `openclaw` | `<password>` | App runtime, no SSH, no sudo |

> These passwords are for emergency VNC/console access only. Normal access is via SSH key.

---

### SSH Access

\`\`\`bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> adminclaw@<VPS1_IP>
\`\`\`

---

### Claw Access

| Claw | Chat URL | Control UI URL |
|------|----------|----------------|
| `<CLAW_NAME>` | `https://<CLAW_DOMAIN><PATH>/chat?token=<TOKEN>` | `https://<CLAW_DOMAIN><PATH>/?token=<TOKEN>` |

| Service | URL |
|---------|-----|
| **Dashboard** | `https://<OPENCLAW_DASHBOARD_DOMAIN><OPENCLAW_DASHBOARD_DOMAIN_PATH>/` |

All URLs are protected by Cloudflare Access.

---

### Workers

| Worker | URL |
|--------|-----|
| AI Gateway Proxy | `<AI_GATEWAY_WORKER_URL>` |
| Log Receiver | `<LOG_WORKER_URL without /logs suffix>` |

---

### Automated Jobs

| Job | Schedule | Status |
|-----|----------|--------|
| Backup | Daily at 3:00 AM UTC (30-day retention) | Active |
| Host alerter | Every 15 minutes via Telegram | <see note> |
| Daily report | Daily at <HOSTALERT_DAILY_REPORT_TIME> via Telegram | <see note> |
| Maintenance checker | Daily (30 min before daily report) | Active |
```

Read `source-config.sh HOSTALERT_TELEGRAM_BOT_TOKEN` and `source-config.sh HOSTALERT_TELEGRAM_CHAT_ID`.

**If both are set:** Host alerter and daily report are active. Show status as `Active` in both rows. For the daily report schedule, use the value of `HOSTALERT_DAILY_REPORT_TIME` (default: `9:00 AM UTC`).

**If either is empty:** Show status as `Not configured` for both rows and append:

> **Host alerter & daily report** are not configured. To enable disk/memory/CPU alerts and daily health reports via Telegram:
>
> 1. Follow [`docs/TELEGRAM.md`](../docs/TELEGRAM.md) to create a Telegram bot and get your chat ID
> 2. Tell Claude to update the host alerter with your bot token and chat ID

```

---

### Quick Reference

| Task | Command |
|------|---------|
| SSH to VPS | `./scripts/ssh-vps.sh` |
| SSH to claw container | `./scripts/ssh-openclaw.sh` |
| Claw logs | `./scripts/logs-openclaw.sh` |
| Health Checks | `./scripts/health-check.sh` |
| OpenClaw CLI | `./scripts/openclaw.sh [command]` or SSH to claw `openclaw` |
| Run backup | `claude "run the backup script on the vps"` |
| Update OpenClaw | `claude "update openclaw"` |
| Update Sandboxes | `claude "update ffmpeg in the sandbox toolkit"` |
```

> For additional AI provider configuration (OpenAI, Cloudflare AI Gateway, Claude Code subscription), see [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md).

> **Note:** If user passwords are no longer in the conversation context, check `openclaw-config.env` for `# DEPLOYED:` lines first (`grep 'DEPLOYED' openclaw-config.env`). These are written automatically during deployment as a safety net. If those are also empty, the passwords can be reset via VNC/console access.

## Save and display

1. **Save** the report to `.deploy-logs/<timestamp>/08-deploy-report.md` using the `Write` tool. Use the same `<timestamp>` directory as the subagent logs created during deployment (find it with `ls .deploy-logs/` and use the most recent directory). If no deploy-logs directory exists yet, create one with the current timestamp (`YYYYMMDD-HHMMSS`).

2. **Display** the full report to the user in the conversation.

3. **Reference the file** at the end:

   > Deployment report saved to `.deploy-logs/<timestamp>/08-deploy-report.md`
   >
   > Full deploy logs: `.deploy-logs/<timestamp>/`
