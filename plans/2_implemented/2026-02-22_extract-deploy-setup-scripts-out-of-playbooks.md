# Plan: Extract Inline Scripts from Playbook 04

## Context

Playbook 04 sections 4.2 and 4.3 contain ~120 and ~200 lines of inline bash that Claude reads into context, holds, and sends as SSH heredocs during deployment. This has two costs:

1. **Context bloat** — ~350 lines of bash in main context (or subagent context), risking mid-deploy compaction
2. **Reliability** — constructing 200-line heredocs over SSH is fragile (shell quoting, variable expansion, escaping)

Extracting these to standalone `deploy/scripts/` files means Claude just SCPs them to the VPS and runs them — the script contents never enter any context window.

## New Files

### `deploy/scripts/setup-infra.sh` (from section 4.2)

Creates Docker networks, directories, clones repo, generates `.env` with random GATEWAY_TOKEN.

**Interface:**

- Env vars in: `AI_GATEWAY_WORKER_URL`, `AI_GATEWAY_AUTH_TOKEN`, `OPENCLAW_TELEGRAM_BOT_TOKEN`, `HOSTALERT_TELEGRAM_BOT_TOKEN`, `HOSTALERT_TELEGRAM_CHAT_ID`, `OPENCLAW_DASHBOARD_DOMAIN_PATH`, `OPENCLAW_DOMAIN_PATH`
- Stdout: single line `OPENCLAW_GENERATED_TOKEN=<hex>` (all other output → stderr)
- Exit: 0 success, 1 failure

### `deploy/scripts/deploy-config.sh` (from section 4.3)

Copies files from staging, substitutes templates, sets permissions, creates crons, deploys plugins.

**Interface:**

- Env vars in: `OPENCLAW_DOMAIN_PATH`, `YOUR_TELEGRAM_ID`, `OPENCLAW_INSTANCE_ID`, `VPS_HOSTNAME`, `ENABLE_EVENTS_LOGGING`, `ENABLE_LLEMTRY_LOGGING`, `LOG_WORKER_TOKEN`, `LOG_WORKER_URL`, `AI_GATEWAY_WORKER_URL`, `ENABLE_VECTOR_LOG_SHIPPING`, `VPS1_IP`, `CRON_MINUTE`, `CRON_HOUR`, `CRON_MAINTENANCE_MINUTE`, `CRON_MAINTENANCE_HOUR`, `HOSTALERT_TELEGRAM_BOT_TOKEN`, `HOSTALERT_TELEGRAM_CHAT_ID`
- Reads `GATEWAY_TOKEN` from `.env` on VPS (not passed in)
- Stdout: `DEPLOY_CONFIG_OK` on success (progress → stderr)
- Exit: 0 success, 1 failure (e.g. unsubstituted `{{VAR}}` found)

Both scripts use `set -euo pipefail` and retain all explanatory comments from the current inline code.

## Playbook Changes

### Section 4.2 — Infrastructure Setup

**Before:** ~120-line inline bash block + troubleshooting
**After:** SCP commands + SSH invocation (~20 lines) + troubleshooting

The SCP of `deploy/` moves here (from 4.3 step 1) since `setup-infra.sh` now lives in the staging dir. Flow:

1. SCP `deploy/` → `/tmp/deploy-staging/` (shared — also used by 4.3)
2. `ssh ... "env VARS... bash /tmp/deploy-staging/scripts/setup-infra.sh"`
3. Capture `OPENCLAW_GENERATED_TOKEN` from stdout
4. Record token locally (unchanged)

### Section 4.3 — Deploy Configuration

**Before:** SCP step + ~200-line inline bash block + cron rules + plugin docs
**After:** Timezone query + SSH invocation (~25 lines) + cron rules + plugin docs

Flow:

1. Query server timezone: `ssh ... "timedatectl show -p Timezone --value"`
2. Claude computes `CRON_MINUTE`/`CRON_HOUR`/`CRON_MAINTENANCE_MINUTE`/`CRON_MAINTENANCE_HOUR`
3. `ssh ... "env VARS... bash /tmp/deploy-staging/scripts/deploy-config.sh"`

The cron generation rules documentation stays in the playbook (Claude needs it to compute values). The file manifest and template variables tables stay too.

### Cron conditional logic

The deploy-config.sh script handles the conditional daily report cron line internally: if both `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` are non-empty, include the `--report` cron line; otherwise omit it.

## Files to Modify

1. **`deploy/scripts/setup-infra.sh`** — New file, extracted from 4.2 inline script
2. **`deploy/scripts/deploy-config.sh`** — New file, extracted from 4.3 inline script
3. **`playbooks/04-vps1-openclaw.md`** — Replace inline scripts with invocations
4. **`deploy/README.md`** — Add `scripts/` section documenting deployment-time scripts
5. **`playbooks/00-fresh-deploy-setup.md`** — Update subagent delegation example (simpler now — pass env vars, run script)

## Verification

- Read the two new scripts to verify all operations from the inline versions are present
- Read the updated playbook sections to verify invocation commands reference correct env vars
- Grep for `<CRON_MINUTE>` style placeholders — should only appear in playbook documentation, not in scripts (scripts use `${CRON_MINUTE}`)
- Grep for `{{` in scripts — should not exist (template substitution uses `sed` at runtime)
- Verify `deploy/scripts/` is included in the SCP command
