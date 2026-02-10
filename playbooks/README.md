# Playbooks

Deployment playbooks for Claude to execute. See `CLAUDE.md` for orchestration.

## User & Sudo

`adminclaw` user has passwordless sudo access.
Most setup commands will need to be executed via sudo.

`openclaw` user does not have passwordless sudo.

## Analysis Mode

For existing deployments, run `00-analysis-mode.md` first to verify current state before making changes.

## Execution Order

1. `01-workers.md` - Deploy Cloudflare Workers (AI Gateway + Log Receiver) — runs locally, triggered during config validation
2. `02-base-setup.md` - VPS-1
3. `03-docker.md` - VPS-1
4. `04-vps1-openclaw.md` - VPS-1
5. `06-backup.md` - VPS-1
6. Reboot VPS-1
7. `07-verification.md` - VPS-1 + Workers
8. `08-post-deploy.md` - First access & device pairing

## Maintenance

- `maintenance.md` - Token rotation schedules and procedures
