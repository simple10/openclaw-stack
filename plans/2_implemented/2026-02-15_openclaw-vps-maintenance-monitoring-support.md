# Plan: VPS maintenance monitoring via OpenClaw

## Context

Two gaps in the current monitoring setup:

1. **No maintenance visibility.** `host-alert.sh` monitors real-time health (disk, memory, load, Docker) but doesn't check for pending OS maintenance — outdated packages, security updates, required reboots. These are slow-burn issues that eventually cause problems.

2. **No fallback without Telegram.** If Telegram is never configured, `host-alert.sh` silently exits — zero monitoring. Disk can fill up, security updates can pile up, and nobody knows until something breaks.

**Solution:** Host cron scripts write machine-readable status files to a location OpenClaw agents can read. OpenClaw's built-in cron tool (currently denied — needs enabling) lets the user configure a daily check. The agent reads the files, evaluates them, and notifies the user if anything needs attention. Works independently of Telegram.

## Architecture

```
Host cron (every 15 min)            Host cron (daily)
  host-alert.sh                       host-maintenance-check.sh
    │                                   │
    ├→ Telegram alerts (if configured)  │
    └→ health.json ──────┐              └→ maintenance.json ──────┐
                          │                                        │
         /home/openclaw/.openclaw/host-status/  (host filesystem)
                          │
         /home/node/.openclaw/host-status/  (gateway container, via OPENCLAW_CONFIG_DIR mount)
                          │
         /workspace/host-status/  (agent sandbox, via new bind mount)
                          │
         OpenClaw cron tool → agent reads files → notifies user
```

**With Telegram:** Daily report includes health + maintenance. Real-time alerts fire on breaches.
**Without Telegram:** OpenClaw evaluates the files via its cron tool and notifies the user during conversations.

---

## Changes

### 1. `deploy/host-alert.sh` — write health JSON every run

Add a JSON write **before** the Telegram check (so it runs even without Telegram credentials). Place after metric collection, before state comparison.

```bash
# Write health snapshot for OpenClaw (always, regardless of Telegram config)
mkdir -p /home/openclaw/.openclaw/host-status
cat > /home/openclaw/.openclaw/host-status/health.json << HEALTHEOF
{
  "timestamp": "$(date -Iseconds)",
  "disk_pct": ${disk_pct},
  "disk_threshold": ${DISK_THRESHOLD},
  "memory_pct": ${mem_pct},
  "memory_threshold": ${MEMORY_THRESHOLD},
  "load_avg": "${load_avg}",
  "cpu_count": ${cpu_count},
  "docker_ok": ${docker_ok},
  "gateway_ok": ${gateway_ok},
  "crashed": "${crashed}",
  "backup_ok": ${backup_ok},
  "backup_age_hours": "${backup_age_hours:-null}"
}
HEALTHEOF
chmod 644 /home/openclaw/.openclaw/host-status/health.json
```

**Key change:** The metric collection block (disk, memory, load, Docker, gateway, containers, backup) must run before the Telegram early-exit. Currently the script exits at line 22 if Telegram isn't configured, before collecting any metrics. The refactor moves metric collection above the Telegram check, and the Telegram check only gates the alert-sending logic.

### 2. `deploy/host-maintenance-check.sh` — new script

Runs daily via cron as root. Checks OS-level maintenance items:

- **Security updates** — `apt-get -s upgrade` filtered for `-security`
- **Total upgradable packages** — `apt list --upgradable`
- **Reboot required** — `/var/run/reboot-required`
- **Failed systemd services** — `systemctl --failed`
- **System uptime** — from `/proc/uptime`

Writes to `/home/openclaw/.openclaw/host-status/maintenance.json`.

### 3. `deploy/openclaw.json` — enable `cron` tool, add sandbox bind

**Move `cron` from deny to allow:**

```jsonc
"tools": {
  "sandbox": {
    "tools": {
      "allow": [
        // ...existing tools...
        "cron"           // Enable for host status monitoring
      ],
      "deny": [
        "canvas",
        "nodes",
        // "cron",       // Moved to allow
        "discord",
        "gateway"
      ]
    }
  }
}
```

**Add host-status bind to sandbox defaults:**

```jsonc
"binds": [
  "/opt/skill-bins:/opt/skill-bins:ro",
  "/app/docs:/workspace/docs:ro",
  "/app/docs:/app/docs:ro",
  "/home/node/.openclaw/host-status:/workspace/host-status:ro"  // Host health & maintenance data
]
```

### 4. `deploy/host-alert.sh --report` — add maintenance section

In report mode, read `maintenance.json` (if it exists) and append a maintenance section to the Telegram daily report:

```
🖥️ hostname: Daily Status
  ...existing health lines...
  Uptime: 15d 3h

  Maintenance:
  Security updates: 3 ⚠️
  Packages upgradable: 12
  Reboot required: no ✅
  Failed services: none ✅
```

If `maintenance.json` doesn't exist or is stale (>26h), note it in the report.

### 5. Playbook: `04-vps1-openclaw.md`

**§ 4.3** — Create `host-status` directory:

```bash
sudo -u openclaw mkdir -p /home/openclaw/.openclaw/host-status
sudo chown 1000:1000 /home/openclaw/.openclaw/host-status
```

Wait — cron runs as root and needs to write here, but the container reads as uid 1000. Use root ownership with `644` permissions on files, and `755` on the directory. The `mkdir` stays in 4.3 but owned by root:

```bash
sudo mkdir -p /home/openclaw/.openclaw/host-status
sudo chmod 755 /home/openclaw/.openclaw/host-status
```

**§ 4.8d** — Deploy maintenance checker alongside host-alert.sh:

```bash
# SOURCE: deploy/host-maintenance-check.sh → /home/openclaw/scripts/host-maintenance-check.sh
sudo tee /home/openclaw/scripts/host-maintenance-check.sh << 'SCRIPTEOF'
# <<< deploy/host-maintenance-check.sh >>>
SCRIPTEOF
sudo chmod +x /home/openclaw/scripts/host-maintenance-check.sh

# Maintenance checker cron — runs daily, 30 min before daily report
sudo tee /etc/cron.d/openclaw-maintenance << 'EOF'
# OpenClaw host maintenance checker — detects pending OS updates
# Runs 30 min before daily report so data is fresh
<CRON_MINUTE> <CRON_HOUR> * * * root /home/openclaw/scripts/host-maintenance-check.sh
EOF
sudo chmod 644 /etc/cron.d/openclaw-maintenance
```

Schedule: 30 minutes before `HOSTALERT_DAILY_REPORT_TIME`. Always runs (not gated on Telegram) since the JSON is needed by OpenClaw.

### 6. Playbook: `07-verification.md`

Add to § 7.5:

```bash
# Verify maintenance checker
sudo /home/openclaw/scripts/host-maintenance-check.sh
cat /home/openclaw/.openclaw/host-status/maintenance.json

# Verify health JSON is written (run alerter first)
sudo /home/openclaw/scripts/host-alert.sh
cat /home/openclaw/.openclaw/host-status/health.json

# Verify status files are readable from agent sandbox
sudo docker exec openclaw-gateway docker run --rm \
  -v /home/node/.openclaw/host-status:/workspace/host-status:ro \
  openclaw-sandbox:bookworm-slim cat /workspace/host-status/health.json

# Verify maintenance cron
cat /etc/cron.d/openclaw-maintenance
```

### 7. Playbook: `08-post-deploy.md`

Add to Automated Jobs table:

```
| Maintenance checker | Daily (30 min before daily report) | Active |
```

---

## Files

| File | Change |
|------|--------|
| `deploy/host-alert.sh` | Move metric collection before Telegram check; write `health.json`; read `maintenance.json` in `--report` |
| `deploy/host-maintenance-check.sh` | **New** — daily OS maintenance checker |
| `deploy/openclaw.json` | Enable `cron` tool; add `host-status` sandbox bind |
| `playbooks/04-vps1-openclaw.md` | Create `host-status` dir (§ 4.3); deploy maintenance script + cron (§ 4.8d) |
| `playbooks/07-verification.md` | Verify JSON files, sandbox bind, maintenance cron |
| `playbooks/08-post-deploy.md` | Add maintenance checker to Automated Jobs |

## Verification

1. Run `host-alert.sh` on VPS → confirm `host-status/health.json` written (even without Telegram)
2. Run `host-maintenance-check.sh` on VPS → confirm `host-status/maintenance.json` written
3. Verify sandbox can read the files via `docker exec` test
4. Run `host-alert.sh --report` → confirm maintenance section in Telegram
5. Verify cron entries: `cat /etc/cron.d/openclaw-maintenance`
6. After enabling cron tool: user configures OpenClaw to check files daily via conversation
