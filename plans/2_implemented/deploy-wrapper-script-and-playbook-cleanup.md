# Plan: deploy.sh wrapper + cleanup

## Context

The current deploy workflow requires 3-4 manual steps: `npm run pre-deploy`, `sync-deploy.sh`, manual restart, `tag-deploy.sh`. The user wants a single `deploy.sh` entry point that handles everything except tagging (which stays manual, post-verification). Also cleaning up the dead `sync-configs.sh` and updating playbooks so Claude knows to use `deploy.sh`.

## Files

| File | Action |
|------|--------|
| `scripts/deploy.sh` | **New** — orchestrator script |
| `scripts/sync-configs.sh` | **Delete** — dead artifact (syncs to unused `synced/` dir) |
| `scripts/sync-deploy.sh` | **Modify** — remove workspace sync reminder (deploy.sh handles it) |
| `playbooks/maintenance.md` | **Modify** — update deploy patterns to use `deploy.sh` |
| `playbooks/00-fresh-deploy-setup.md` | **Modify** — add workspace sync + down-sync to fresh deploy sequence |

## Design: deploy.sh

### What it does (in order)

1. `npm run pre-deploy` — build deployment artifacts
2. `scripts/sync-deploy.sh` — push stack artifacts + configs to VPS (with drift detection)
3. `scripts/sync-workspaces.sh up` — push workspace files (--ignore-existing by default)
4. Check `.deploy/.restart-required` — if it exists, auto-restart affected claw services via SSH
5. Clean up `.restart-required`
6. Print summary

### Flags

```
scripts/deploy.sh                        # Deploy everything (all claws)
scripts/deploy.sh --instance <claw>      # Deploy one claw only
scripts/deploy.sh --force                # Overwrite VPS configs + workspaces
scripts/deploy.sh --no-restart           # Skip auto-restart
scripts/deploy.sh -n | --dry-run         # Preview only
```

- `--instance` passes through to both sync-deploy.sh and sync-workspaces.sh
- `--force` passes through to both sub-scripts
- `--no-restart` skips step 4 (prints the warning instead, like sync-deploy.sh does today)
- `--dry-run` passes to sync-deploy.sh, skips workspace sync and restart

### Auto-restart logic

```bash
# Read .restart-required (format: "instance:key1,key2\n...")
# Map instance names to compose service names:
#   ${STACK__STACK__PROJECT_NAME}-openclaw-${instance_name}
# Run: docker compose up -d --force-recreate <service1> <service2> ...
# via SSH: ${SSH_CMD} ${VPS} "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && ...'"
```

When `--instance` is set, only restart that instance (even if `.restart-required` lists others).

### What it does NOT do

- **No fresh deploy support.** Fresh deploys have their own flow (setup-infra, start-claws, etc). Use `sync-deploy.sh --fresh` directly for those.
- **No auto-tagging.** `tag-deploy.sh` stays manual after verification.
- **No down-sync.** `deploy.sh` is always "up" direction. Down-sync (`sync-workspaces.sh down`, `sync-down-configs.sh`) remain separate commands.

## Playbook changes

### maintenance.md

Replace the manual 3-step pattern (pre-deploy → sync-deploy → restart) with `deploy.sh` in these sections:

- "Bind-Mounted Deploy Files" (~line 254)
- "Updating a Single Claw's Configuration" (~line 288)
- "Adding a New Claw" (~line 307)

Add a new section "Deploying Changes" near the top of the update patterns that explains:

- `scripts/deploy.sh` is the standard way to push local changes to VPS
- It runs pre-deploy, syncs configs + workspaces, and auto-restarts if needed
- After deploy, verify with § 7.1 then tag with `scripts/tag-deploy.sh`

### 00-fresh-deploy-setup.md

In § 0.7 step 2, after `sync-deploy.sh --fresh`:

- Add `scripts/sync-workspaces.sh up --force` (seed all workspace files on VPS)

In § 0.7, after step 6 (verification) or step 4 (OpenClaw deployment), add:

- `scripts/sync-workspaces.sh down --all` (pull back any files OpenClaw generated on first start)

## Delete sync-configs.sh

Confirmed dead:

- Syncs to `synced/` directory (gitignored, not used anywhere)
- Uses stale `STACK__STACK__INSTANCES_DIR` variable
- Functionality fully replaced by `sync-down-configs.sh` (configs) and `sync-workspaces.sh` (workspaces)
- Not referenced in any playbook or script

## Verification

1. Run `scripts/deploy.sh -n` — should show dry-run output from pre-deploy + sync-deploy
2. Run `scripts/deploy.sh --instance <claw>` — should build, sync configs, sync workspaces, auto-restart if needed
3. Verify `.restart-required` is cleaned up after restart
4. Check that `sync-configs.sh` is gone
5. Read updated playbook sections for correctness
