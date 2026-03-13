# Changelog

Breaking changes and migration steps for existing deployments. Entries are newest-first.

When deploying to a VPS that was set up before a breaking change, follow the **Migration** steps for each entry between the deployed version and the current version.

---

## 2026-03-14 — Rename VPS status report cron, fix bind mount path

The daily VPS status report cron job has been renamed and the sandbox bind mount path reverted from `/tmp/.host-status` to `/workspace/.host-status`. This avoids conflicts with OpenClaw's upstream "healthcheck" skill which was being incorrectly triggered by the old "Daily VPS Health Check" cron name and prompt.

**What changed:**
- `stack.yml.example`: `health_check_cron` renamed to `status_report_cron`
- `build/pre-deploy.mjs`: env var `HEALTH_CHECK_CRON` renamed to `STATUS_REPORT_CRON`
- `deploy/host/register-cron-jobs.sh`: cron renamed from "Daily VPS Health Check" to "Daily VPS Status Report", prompt reworded to avoid "health"/"check" language, file paths updated to `/workspace/.host-status/`
- `openclaw/*/openclaw.jsonc`: bind mount reverted from `/tmp/.host-status` to `/workspace/.host-status`, removed `dangerouslyAllowReservedContainerTargets`, kept `dangerouslyAllowExternalBindSources`

**Migration:**

1. Update `stack.yml` — rename the toggle:
   ```yaml
   defaults:
     status_report_cron: false    # was: health_check_cron

   claws:
     personal-claw:
       status_report_cron: true   # was: health_check_cron
   ```

2. Update `openclaw.jsonc` for each claw — change the sandbox docker bind:
   ```jsonc
   // In agents.main.sandbox.docker:
   "dangerouslyAllowExternalBindSources": true,
   "binds": [
     "/home/node/.openclaw/workspace/.host-status:/workspace/.host-status:ro"
   ]
   // Remove dangerouslyAllowReservedContainerTargets if present
   ```

3. Rebuild and deploy:
   ```bash
   npm run pre-deploy
   scripts/sync-deploy.sh --all --force
   ```

4. On the VPS, remove the old cron job and re-register:
   ```bash
   # Remove old cron (run inside the claw container or via openclaw CLI):
   openclaw --instance personal-claw cron remove --name "Daily VPS Health Check"

   # Re-register cron jobs:
   sudo bash /home/<project>/openclaw/host/register-cron-jobs.sh
   ```

5. Restart the claw container to pick up the new bind mount:
   ```bash
   sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d --force-recreate'
   ```

---

## 2026-03-13 — Host-side auto-update with per-claw versioning

**BREAKING:** In-container updates (`ALLOW_OPENCLAW_UPDATES`) are removed. Updates are now handled host-side by `build-openclaw.sh`. Each claw can run a different OpenClaw version via `openclaw_version` in `stack.yml`. `.git` is no longer included in the Docker image.

**What changed:**
- `build/pre-deploy.mjs`: per-claw `openclaw_version` + `openclaw_image_tag`, new `STACK__OPENCLAW_VERSIONS` env var, removed `STACK__STACK__IMAGE` + `allow_updates`
- `docker-compose.yml.hbs`: image tag moved from anchor to per-claw block, removed `ALLOW_OPENCLAW_UPDATES` + `OPENCLAW_SYSTEMD_UNIT`, added `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS`, `SHELL`, `TERM`
- `deploy/host/build-openclaw.sh`: rewritten for multi-version support — loops over unique specifiers, dual-tags (mutable specifier + immutable version), version state files
- `deploy/host/auto-update-openclaw.sh`: new daily cron script — checks for new versions, rebuilds changed specifiers, recreates containers
- `deploy/host/register-cron-jobs.sh`: added auto-update cron registration
- `deploy/openclaw-stack/entrypoint.sh`: removed section 1d (git/branch/exclude handling) — no-op without `.git`
- `stack.yml.example`: added `auto_update: true`, per-claw `openclaw_version` example, removed `allow_updates`

**Migration:**

1. Update `stack.yml`:
   ```yaml
   stack:
     openclaw:
       version: stable        # Stack-wide default
       auto_update: true      # Enable daily host-side update check

   defaults:
     # Remove allow_updates entirely (delete the line)

   claws:
     personal-claw:
       # No openclaw_version → inherits stack.openclaw.version (stable)
     # To pin a claw:
     # work-claw:
     #   openclaw_version: v2026.3.8
   ```

2. Rebuild and redeploy:
   ```bash
   npm run pre-deploy && scripts/sync-deploy.sh --all --force
   sudo -u openclaw <INSTALL_DIR>/host/build-openclaw.sh
   sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
   sudo bash <INSTALL_DIR>/host/register-cron-jobs.sh
   ```

**Verify:** `docker images | grep openclaw-` shows version-tagged images (e.g., `:stable`, `:v2026.3.12`). `cat <INSTALL_DIR>/.openclaw-versions/stable` shows resolved version. `cat /etc/cron.d/openclaw-auto-update` exists if auto-update enabled.

---

## 2026-03-13 — Pinned bridge subnet + cloudflared networking

**BREAKING:** The `openclaw-net` Docker bridge subnet is now pinned to `10.200.0.0/24` (was auto-assigned, typically `172.x.0.0/24`). Cloudflared reverted from `network_mode: host` to bridge networking with a static IP (`10.200.0.100`). Tunnel ingress routes must use Docker DNS container names (not `localhost`).

**What changed:**
- `docker-compose.yml.hbs`: openclaw-net pinned to `10.200.0.0/24`, cloudflared on bridge with `ipv4_address: 10.200.0.100`
- `openclaw.jsonc` (all configs): `trustedProxies` changed to `["10.200.0.100"]`
- `cf-tunnel-setup.sh`: generates routes using Docker DNS names (e.g., `http://<project>-openclaw-<claw>:18789`) instead of `localhost`
- Cloudflared hardened: `cap_drop: [ALL]`, `no-new-privileges`, `read_only`

**Migration:**

1. Update `trustedProxies` in each claw's `openclaw.jsonc` (live on VPS or local per-claw config):
   ```jsonc
   "trustedProxies": ["10.200.0.100"]
   ```

2. Update Cloudflare tunnel ingress routes to use Docker DNS names instead of `localhost`. Either:
   - Run `scripts/cf-tunnel-setup.sh setup-routes` (requires `CF_API_TOKEN`), or
   - Manually update in Cloudflare Dashboard: change `http://localhost:<port>` to `http://<project>-openclaw-<claw>:<port>` for each route

3. Recreate containers (network subnet change requires `down` + `up`):
   ```bash
   sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose down && docker compose up -d'
   ```

**Verify:** `sudo docker network inspect openclaw_openclaw-net --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` should return `10.200.0.0/24`. `sudo docker inspect <project>-cloudflared --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'` should return `10.200.0.100`.

---

## 2026-03-11 — Fix llmetry typo (59c276b)

**BREAKING:** Renamed `LLMTERY_*` env vars and config keys to `LLMETRY_*` (typo fix).

**Migration:** Update `.env` and `stack.yml` if you have the old `LLMTERY_` spelling. `npm run pre-deploy` will use the corrected names.
