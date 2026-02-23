# Parallelize worker deployment with base setup

## Context

During a fresh deploy, worker deployment (01-workers) runs ~5+ minutes locally via wrangler while the VPS sits idle. Base setup (02-base-setup) runs ~10 minutes on the VPS via SSH with no dependency on worker outputs. These can run simultaneously, saving ~5 minutes of wall-clock time.

Dependency analysis:

- 01-workers: local only (wrangler), produces `AI_GATEWAY_WORKER_URL`, `AI_GATEWAY_AUTH_TOKEN`, `LOG_WORKER_URL`, `LOG_WORKER_TOKEN`
- 02-base-setup: VPS only (SSH), needs `VPS1_IP`, `SSH_*`, `CF_TUNNEL_TOKEN` — no worker values
- 03-docker: VPS only, depends on 02 only
- 04-vps1-openclaw: needs outputs from BOTH 01 (worker URLs/tokens) AND 03 (Docker installed)

## Changes

### 1. Update execution order — `CLAUDE.md`

Change the execution order diagram from sequential to show parallel execution:

```
Current:
  1. Validate config (+ auto worker deployment)
  2. Execute 02-base-setup
  3. Execute 03-docker
  4. Execute 04-vps1-openclaw
  ...

New:
  1. Validate config
  2. In parallel:
     a. Deploy workers (01-workers) — local machine
     b. Execute 02-base-setup — VPS
  3. Execute 03-docker — VPS (after 2b)
  4. Execute 04-vps1-openclaw — VPS (after both 2a and 3)
  ...
```

Also update the paragraph below the list that says "All steps are sequential on a single VPS" to note the workers parallelization.

### 2. Update deployment overview — `playbooks/00-fresh-deploy-setup.md` § 0.7

Update the deployment plan display to show the parallel structure:

```
Deployment Plan:
  1. [Parallel]
     a. Deploy Cloudflare Workers (01-workers.md) — local    ~5 min
     b. Base setup & hardening (02-base-setup.md) — VPS      ~10 min
  2. Docker installation (03-docker.md)
  3. OpenClaw deployment (04-vps1-openclaw.md)
  4. Backup configuration (06-backup.md)
  5. Reboot & verification (07-verification.md)
  6. Post-deploy (08-post-deploy.md)
```

Update the automation directive to describe how to launch both as parallel subagents and synchronize before step 4.

### 3. Update context window management table — `playbooks/00-fresh-deploy-setup.md` § 0.7

The table already lists 01-workers and 02-base-setup sections as subagent candidates. Add a note that these should be launched as parallel subagents in a single message (multiple Task tool calls). The synchronization point is before 04-vps1-openclaw: both subagents must have returned their values before proceeding.

## Files to modify

1. `CLAUDE.md` — execution order section (~lines 66-78)
2. `playbooks/00-fresh-deploy-setup.md` — § 0.7 deployment overview, automation directive, and context window management

## Verification

- Read updated CLAUDE.md execution order and confirm parallel step is clear
- Read updated 00-fresh-deploy-setup.md § 0.7 and confirm the deployment plan, automation directive, and context table all reflect parallelization
- Confirm no other playbooks reference a strict sequential ordering that would conflict
