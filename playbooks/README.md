# Playbooks

Deployment playbooks for Claude to execute. See `CLAUDE.md` for orchestration.

## User & Sudo

`adminclaw` user has passwordless sudo access.
Most setup commands will need to be executed via sudo.

`openclaw` user does not have passwordless sudo.

## Analysis Mode

For existing deployments, run `00-analysis-mode.md` first to verify current state before making changes.

## Execution Order

See `00-fresh-deploy-setup.md` § 0.7 for the authoritative execution order with automation directives and context window management. Quick reference:

0. `00-fresh-deploy-setup.md` — config validation
1. `01-workers.md` + `02-base-setup.md` — **parallel** (workers local, base setup VPS)
2. `03-docker.md` → `04-vps1-openclaw.md` → `06-backup.md` — sequential on VPS
3. Reboot → `07-verification.md` → `08-post-deploy.md`

## Maintenance

- `maintenance.md` — token rotation, image updates, bind-mount file updates
