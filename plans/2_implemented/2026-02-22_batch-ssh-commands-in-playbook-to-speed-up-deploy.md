# Plan: Restructure Playbook 04 for Batched Execution

## Context

Playbook 04 currently has 17 sections (4.1-4.17), each written as individual SSH commands. During deployment, this results in 15+ separate SSH connections with per-connection overhead (TCP handshake, key exchange, authentication). The playbook should be restructured to batch operations into minimal SSH sessions and note parallelism opportunities.

Additionally, section 4.15 (Deploy Managed Hooks) is no longer relevant — the `deploy/hooks/` directory is empty and no hook subdirectories exist.

## New Section Structure

Collapse 17 sections → 5 sections:

### 4.1 Install Sysbox Runtime (unchanged)

- Standalone SSH session (needs `apt`/`dpkg`, can't batch with later steps)
- No changes needed

### 4.2 Infrastructure Setup (merge old 4.2 + 4.3 + 4.4 + 4.5)

- **Single SSH session** that runs all four operations sequentially:
  - Create Docker networks (old 4.2)
  - Create directory structure (old 4.3)
  - Clone OpenClaw repo (old 4.4)
  - Generate .env file with GATEWAY_TOKEN (old 4.5)
- Returns: GATEWAY_TOKEN (must be saved to local config before proceeding)

### 4.3 Deploy Configuration (merge old 4.6-4.14, remove old 4.15)

- **Step 1 (SCP)**: Bulk-copy `deploy/` directory to `/tmp/deploy-staging/` on VPS
- **Step 2 (Single SSH session)**: One script that does everything:
  - Copy docker-compose.override.yml into place (old 4.6)
  - Set up Vector: dirs, compose file, config, .env (old 4.7)
  - Template-substitute and deploy openclaw.json (old 4.8)
  - Template-substitute and deploy models.json for all agents (old 4.8)
  - Create agent session dirs and sessions.json (old 4.8)
  - Copy build-openclaw.sh (old 4.9)
  - Copy entrypoint-gateway.sh (old 4.10)
  - Copy host-alert.sh + host-maintenance-check.sh (old 4.11)
  - Create cron entries for alerter + maintenance (old 4.11)
  - Create CLI wrapper at /usr/local/bin/openclaw (old 4.12)
  - Move plugins into place, set ownership to 1000:1000 (old 4.13)
  - Copy logrotate config (old 4.14)
  - Set all file permissions
  - Verify no `{{VAR}}` placeholders remain
  - Clean up staging directory
- Section documents which files are templates vs static, and lists all template variables

### 4.4 Build, Start, and Verify (old 4.16 + verification)

- Build OpenClaw Docker image
- Start gateway + Vector containers
- Wait for sandbox builds with progress polling
- Fix .openclaw ownership
- Verify CLI access
- Sandbox image verification

### 4.5 Deploy OpenClaw Cron Jobs (old 4.17)

- Requires running gateway
- Deploy health check cron via `openclaw cron add`

## Files to Modify

1. **`playbooks/04-vps1-openclaw.md`** — Full restructure (the main change)
2. **`playbooks/00-fresh-deploy-setup.md`** — Update context window management table:
   - Old: "04: Sysbox + setup (4.1–4.4)" → "04: Sysbox + infra (4.1–4.2)"
   - Old: "04: File deployments (4.6–4.15)" → "04: Deploy configuration (4.3)"
   - Old: "04: OpenClaw Docker build (4.16)" → "04: Build + start (4.4)"
   - Update section references in subagent example
3. **`playbooks/07-verification.md`** — Update cross-references:
   - "section 4.16" → "section 4.4"
   - "§ 4.8" → "§ 4.3"

## Approach for the Restructured 4.3

The key design decision: **SCP raw files + server-side template substitution**.

For the SSH script in 4.3 Step 2:

- Static files: `sudo cp` from staging to final location
- Template files (openclaw.json, models.json): Use `sed` substitution on the VPS after copying from staging
- The script is a single heredoc that the deployer passes config values into as shell variables at the top

Template variables are passed as shell variables at the top of the SSH heredoc, then `sed` or `envsubst` replaces `{{VAR}}` patterns in the template files. This keeps the playbook instructions clean and avoids creating temp files locally.

## Verification

After restructuring:

- Read through the new playbook to verify all file deployments from old sections are accounted for
- Verify section numbering is sequential
- Verify all cross-references in 00-fresh-deploy-setup.md and 07-verification.md are updated
- Verify no mention of section 4.15 or "managed hooks" remains
