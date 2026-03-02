
# Updating OpenClaw on Host (VPS)

## Current State

- In-container updates (just built): Per-claw opt-in, ephemeral — survives restart but not recreate
- Host-level updates: Fully manual — user runs scripts/update-openclaw.sh from their dev machine, which SSHes in, git
  pulls, rebuilds image, restarts containers
- Host alerter: Already monitors health + sends Telegram alerts (state-change + daily report)
- No version awareness: Nothing checks if a new OpenClaw release exists. Nobody gets told "you're outdated."

## The Gap

  There's no bridge between "a new version exists" and "the host gets updated." The user has to know to run
  update-openclaw.sh themselves.

## Ideas (escalating autonomy)

  1. Version check in daily report (lowest effort)

  Add a version check to host-maintenance-check.sh or a companion script. It does git fetch --tags in the openclaw repo,
   compares the running version against the latest stable tag, and writes the result to the existing maintenance.json.
  The daily report already reads that JSON — it would just gain a new line:

  📦 OpenClaw: v2026.2.25 → v2026.2.27 available

  Pros: Zero risk, fits existing infrastructure, per-stack (each INSTALL_DIR has its own repo)
  Cons: Notification only — user still has to act manually (SSH + run script)

  1. VPS-local update script (no dev machine needed)

  Right now scripts/update-openclaw.sh runs from the dev machine and SSHes in. Create a counterpart that lives on the
  VPS at ${INSTALL_DIR}/scripts/update-openclaw-stack.sh that can be invoked directly:

```bash
  sudo -u openclaw ${INSTALL_DIR}/scripts/update-openclaw-stack.sh

# or with the CLI wrapper

# openclaw-stack update  (new host command)
```

  Flow: git fetch --tags → resolve version → build-openclaw.sh → docker compose up -d → health check → report result to
  Telegram.

  This decouples updates from the dev machine. Combined with idea #1, the daily report could say "update available — run
   openclaw-stack update on the VPS."

  Pros: Self-contained on VPS, can be triggered by cron/agent/manual SSH
  Cons: Still requires human trigger (unless combined with #3 or #4)

  1. Scheduled auto-update cron (opt-in)

  New config vars:

  OPENCLAW_AUTO_UPDATE=false           # Enable automatic host-level updates
  OPENCLAW_AUTO_UPDATE_SCHEDULE="0 4 ** 1"  # When to check+update (default: 4 AM Monday)

  A cron job runs the VPS-local update script from #2. On completion, sends a Telegram summary:

  🔄 OpenClaw auto-updated: v2026.2.25 → v2026.2.27
    ✅ muxxibot: healthy (restarted in 8s)
    ✅ test-claw: healthy (restarted in 6s)

  Or if already current: no notification (like the health alerter's dedup).

  Pros: Fully hands-off, configurable schedule, scoped per INSTALL_DIR
  Cons: Brief downtime during rebuild (~30-60s per claw). Could break if upstream has breaking changes. Needs rollback
  strategy.

  1. Agent-driven update (via openclaw cron job)

  Instead of a host cron, use OpenClaw's own cron system. The Daily VPS Health Check agent already reads
  maintenance.json and has tool access. Add version info to the JSON, and give the agent a tool/instruction to trigger
  the update when:

- A new version is available
- The user has opted in (OPENCLAW_AUTO_UPDATE=true)
- Or the agent asks via Telegram: "v2026.2.27 is available. Update now?"

  Pros: Uses existing infrastructure, agent can make smart decisions (skip if high load, wait for quiet period),
  conversational UX
  Cons: Agent running the update means the gateway restarts while the agent is running — the agent would kill itself
  mid-update. Would need the update to be backgrounded or use a host-level trigger.

  1. Hybrid: notify + confirm via Telegram

  The daily report includes the update notification (#1). The user replies to the bot with something like "update" or
  taps an inline keyboard button. A lightweight Telegram bot listener (or webhook via the existing AI gateway) catches
  this and triggers the VPS-local update (#2).

  Pros: Best UX — user sees notification, confirms with one tap, gets result
  Cons: Requires a Telegram bot listener or webhook handler that doesn't exist today. More infrastructure.

  ---
  My recommendation

  Start with #1 + #2, make #3 easy to enable later.

- #1 is near-zero effort — just a git fetch --tags + version comparison added to the maintenance check, surfaced in
  the daily Telegram report
- #2 gives you a VPS-local script that can be run manually, by cron, or by any future automation
- #3 becomes trivial once #2 exists — it's just a cron entry that calls the script + a config flag

  The agent-driven (#4) and Telegram-interactive (#5) approaches are nice but add real complexity. They'd be good
  follow-ups once the foundation (#1 + #2) is solid.

  What do you think? Want to explore any of these directions further, or should I draft a plan around a specific
  combination?
