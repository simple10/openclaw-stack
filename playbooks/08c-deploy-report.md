# 08c - Deployment Report

Generate and save the final deployment report.

## Prerequisites

- All previous playbooks completed
- Device pairing confirmed working (`08b-pair-devices.md`)

---

**IMPORTANT:** After the user confirms the chat interface is working, output a complete deployment report. This is the final step — do NOT skip it.

The report is saved to `.deploy-logs/<timestamp>/08-deploy-report.md` (same timestamp directory as the subagent logs) and displayed to the user. After outputting the report, include a clickable reference to the saved file.

Collect the following values and present them in a single, neatly formatted report:

> **SSH auth convention:** Examples below may show `ssh -i <SSH_KEY> ...`. If you use agent-based auth, omit `-i <SSH_KEY>` and rely on your SSH config or add `-o IdentityAgent=<SSH_IDENTITY_AGENT>`.

## Values to collect

1. **User passwords** — source `scripts/lib/source-config.sh` to get `ADMINCLAW_PASSWORD` and `OPENCLAW_PASSWORD`. These are auto-generated and persisted in `.env`.

2. **Per-claw gateway tokens** — read from container env var (NOT openclaw.json):

   ```bash
   CLAWS=$(ssh -i <SSH_KEY> -p <SSH_PORT> <SSH_USER>@<VPS_IP> \
     "sudo docker ps --format '{{.Names}}' --filter 'name=-openclaw-' | sort")
   for CLAW in $CLAWS; do
     TOKEN=$(ssh -i <SSH_KEY> -p <SSH_PORT> <SSH_USER>@<VPS_IP> \
       "sudo docker exec --user node $CLAW printenv OPENCLAW_GATEWAY_TOKEN")
     echo "$CLAW: $TOKEN"
   done
   ```

3. **Domain and URLs** — read from `.deploy/stack.json` (`claws.<name>.domain`, `claws.<name>.domain_path`) for the resolved values as actually deployed.

## AI proxy status

Include the config URL and credential status in the report:

> **AI Proxy Config:** `https://<AI_GATEWAY_WORKER_URL>/config`
>
> Provider credentials can be added or updated at any time via the config UI using the gateway token.

**If the user added credentials during `08a`:**

> **AI Proxy:** Provider credentials configured.

**If skipped:**

> **AI Proxy:** Deployed but no provider credentials configured yet. Visit the config URL above to add API keys.

## Report format

Output the report using exactly this structure:

```
## OpenClaw Deployment Report

**Date:** <current date>
**VPS IP:** <VPS_IP>
**Domain:** <OPENCLAW_DOMAIN>

---

### VPS Users

| User | Password | Purpose |
|------|----------|---------|
| `adminclaw` | `<password>` | SSH admin, passwordless sudo, use for emergency KVM login |
| `openclaw` | `<password>` | App runtime, no SSH, no sudo |

> These passwords are for emergency VNC/console access only. Normal access is via SSH key.

---

### SSH Access

\`\`\`bash
ssh -i <SSH_KEY> -p <SSH_PORT> adminclaw@<VPS_IP>
\`\`\`

---

### Claw Access

| Claw | Chat URL | Control UI URL |
|------|----------|----------------|
| `<CLAW_NAME>` | `https://<CLAW_DOMAIN><PATH>/chat?token=<TOKEN>` | `https://<CLAW_DOMAIN><PATH>/?token=<TOKEN>` |

| Service | URL |
|---------|-----|
| **Dashboard** | `https://<CLAW_DOMAIN><DASHBOARD_BASE_PATH>/` |

All URLs are protected by Cloudflare Access.

---

### Workers

| Worker | URL |
|--------|-----|
| AI Gateway Proxy | `<AI_GATEWAY_WORKER_URL>` |
| AI Gateway Config | `<AI_GATEWAY_WORKER_URL>/config` |
| Log Receiver | `<LOG_WORKER_URL>` |
| Egress Proxy | `<EGRESS_PROXY_URL>` (if configured) |

| Secret | Value |
|--------|-------|
| AI Gateway Admin Token | `<AI_WORKER_ADMIN_AUTH_TOKEN>` |

> **Keep the admin token safe** — it controls user creation, deletion, and credential access for the AI Gateway.

---

### Automated Jobs

| Job | Schedule | Status |
|-----|----------|--------|
| Backup | Daily at 3:00 AM UTC (30-day retention) | Active |
| Host alerter | Every 15 minutes via Telegram | <see note> |
| Daily report | Daily at <HOSTALERT_DAILY_REPORT_TIME> via Telegram | <see note> |
| Maintenance checker | Daily (30 min before daily report) | Active |
```

Read `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` from `.env`.

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

> To add or update provider API keys, visit the AI Gateway Config URL above. For advanced configuration (Cloudflare AI Gateway, Claude Code subscription), see [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md).

> **Note:** User passwords and the AI Gateway admin token are always available via `source scripts/lib/source-config.sh` (stored in `.env`).

## Save and display

1. **Save** the report to `.deploy-logs/<timestamp>/08-deploy-report.md` using the `Write` tool. Use the same `<timestamp>` directory as the subagent logs created during deployment (find it with `ls .deploy-logs/` and use the most recent directory). If no deploy-logs directory exists yet, create one with the current timestamp (`YYYYMMDD-HHMMSS`).

2. **Display** the full report to the user in the conversation.

3. **Reference the file** at the end:

   > Deployment report saved to `.deploy-logs/<timestamp>/08-deploy-report.md`
   >
   > Full deploy logs: `.deploy-logs/<timestamp>/`
