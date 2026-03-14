# Deploy Files

Authoritative source files for VPS deployment, organized into three tiers.

## Directory Structure

```
deploy/
  openclaw-stack/     <- Container bind mount (tier 1) -> /app/openclaw-stack:ro
    entrypoint.sh       Gateway entrypoint script
    rebuild-sandboxes.sh Sandbox image builder
    parse-toolkit.mjs   Toolkit config parser
    dashboard/          Dashboard web app
    plugins/            Coordinator plugin
  host/               <- Host-only scripts (tier 2) -- cron jobs, config
    source-config.sh    Config resolver (sources stack.env)
    backup.sh           Backup all claw instances
    build-openclaw.sh   Build gateway image with auto-patching
    start-claws.sh      Build image and start containers
    host-alert.sh       Host resource monitoring + Telegram alerts
    host-maintenance-check.sh  OS update/reboot checker
    session-prune.sh    Session transcript cleanup
    register-cron-jobs.sh Install all crons + logrotate + OpenClaw CLI crons
    openclaw-wrapper.sh OpenClaw CLI wrapper for host
    logrotate-openclaw  Logrotate config ({{INSTALL_DIR}} resolved by pre-deploy)
  setup/              <- Deploy-time scripts (tier 3) -- run once during setup
    system-hardening.sh SSH/UFW/fail2ban hardening
    setup-infra.sh      Create directories, clone repo
    verify-deployment.sh Verify sandbox images, binaries, health
  vector/             <- Vector log shipper config
    vector.yaml
```

## Convention

When a playbook bash block contains:

```
# SOURCE: deploy/<tier>/<file> -> /vps/target/path
```

The executor reads `deploy/<tier>/<file>` from this repo and deploys its contents to the target path on the VPS.

## source-config.sh Discovery

Scripts source config based on their tier location:

| Script location | Source line | Resolves to |
|---|---|---|
| `deploy/host/*.sh` | `source "$(dirname $0)/source-config.sh"` | Sibling in same dir |
| `deploy/setup/*.sh` | `source "$(dirname $0)/../host/source-config.sh"` | Up one, into host/ |
| `scripts/*.sh` | `source "$SCRIPT_DIR/../deploy/host/source-config.sh"` | Fixed relative path |
