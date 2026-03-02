# Fix Remaining Deploy Script Bugs + Comprehensive Code Scan

## Context

First VPS deployment on Feb 28 revealed 7 critical issues (already fixed and committed). Post-deploy audit found additional bugs in deploy scripts that weren't exercised during manual deployment but would break automated/playbook-driven deploys. This plan fixes those remaining issues and scans the full codebase for other bugs.

---

## Part A: Deploy Script Fixes

### A1. Fix `deploy/scripts/start-claws.sh`

**File:** `deploy/scripts/start-claws.sh`

5 bugs:

| Line | Bug | Fix |
|------|-----|-----|
| 22-24 | Instance discovery looks in `deploy/openclaw/*/` — wrong path, instances are in `instances/*/` | Change to `${STACK__STACK__INSTANCES_DIR}` (= `${INSTALL_DIR}/instances`) |
| 34 | Build script path `${OPENCLAW_HOME}/scripts/build-openclaw.sh` — should be `${OPENCLAW_HOME}/deploy/deploy/build-openclaw.sh` (VPS layout: deploy files are under `deploy/deploy/`) | Fix path |
| 40, 44 | Compose dir `${OPENCLAW_HOME}/openclaw` — should be `${OPENCLAW_HOME}/deploy` | Fix path |
| 48-50 | Vector started via separate compose in `${OPENCLAW_HOME}/vector` — Vector is now in main compose | Remove separate Vector start block (Vector starts with `docker compose up -d`) |
| 11 | Comment references old `ENABLE_VECTOR_LOG_SHIPPING` | Update comment to `STACK__STACK__LOGGING__VECTOR` |

### A2. Fix `deploy/scripts/setup-infra.sh`

**File:** `deploy/scripts/setup-infra.sh`

This script is **largely obsolete** — it creates infrastructure that pre-deploy + compose now handles. However, it's still referenced by playbook 04 and may be useful for fresh VPS setup. Targeted fixes:

| Line | Bug | Fix |
|------|-----|-----|
| 125 | Writes `.env` to `${INSTALL_DIR}/openclaw/.env` — wrong location, compose doesn't read this | Remove Part 4 entirely (gateway tokens + .env are now in stack.yml + docker-compose.yml) |
| 13-17 | Interface docs list old env vars (`AI_GATEWAY_WORKER_URL`, etc.) | Update interface docs or mark script as needing redesign |
| 26-32 | Validates env vars that are no longer passed this way | Remove validation block (config comes from source-config.sh) |
| 46-56 | Creates Docker networks with custom subnets — compose creates `openclaw-net` automatically | Remove network creation (compose `networks:` section handles this) |
| 154-155 | Hardcodes single-instance paths (`${INSTALL_DIR}/.openclaw`) | Already uses per-instance in Part 2, but Part 4 still has old paths |

**Approach:** Strip setup-infra.sh down to just Part 2 (directory structure) + Part 3 (git clone). Parts 1, 4 are obsolete.

### A3. Fix `deploy/backup.sh`

**File:** `deploy/backup.sh`

| Line | Bug | Fix |
|------|-----|-----|
| 7 | `INSTALL_DIR` hardcoded fallback — should source `source-config.sh` | Add `source "$(cd "$(dirname "$0")" && pwd)/scripts/source-config.sh"` and use `STACK__STACK__INSTALL_DIR` |
| 58-59 | Unquoted `$INSTALL_DIR` in `[ -f ${INSTALL_DIR}/... ]` and `cp ${INSTALL_DIR}/...` | Quote: `"${INSTALL_DIR}/..."` |
| 58-63 | Backs up `${INSTALL_DIR}/openclaw/.env` — this file no longer exists (config is in compose) | Remove shared .env backup block, or change to back up `${INSTALL_DIR}/deploy/docker-compose.yml` |
| 61 | Uses `-printf` (GNU find) — may not be portable | Keep as-is (VPS is Debian, has GNU find) |

### A4. Fix `deploy/build-openclaw.sh` version resolution

**File:** `deploy/build-openclaw.sh`

| Line | Bug | Fix |
|------|-----|-----|
| 76 | `node -e "console.log(require('./package.json').version)"` — `node` is not installed on VPS host (it's inside the container) | Use `python3 -c "import json; print(json.load(open('package.json'))['version'])"` or `jq -r .version package.json` (jq is installed on VPS) |

### A5. Fix `deploy/scripts/verify-deployment.sh`

**File:** `deploy/scripts/verify-deployment.sh`

| Line | Bug | Fix |
|------|-----|-----|
| 85 | `grep -oP '0\.0\.0\.0:\K\d+'` uses Perl regex — may fail on some systems, but also uses `\| head -1 \|\| true` so low risk | Keep as-is (VPS has GNU grep) |
| 97 | Vector container name check uses `^vector$` — container is actually named `<project>-vector` (e.g., `muxxibot-vector`) | Change to `grep -q 'vector$'` or use `STACK__STACK__PROJECT_NAME` |
| 15 | Still reads `OPENCLAW_DOMAIN_PATH` from env — should source `source-config.sh` | Add source line, read domain path from stack config |

### A6. Update `playbooks/04-vps1-openclaw.md`

Stale references to update:

- Compose dir path: `openclaw/` → `deploy/`
- Build script path: `scripts/build-openclaw.sh` → `deploy/deploy/build-openclaw.sh`
- Remove references to `sync-sandbox-images.sh` (doesn't exist yet — sandbox images are built in-container)
- Entrypoint path: update any old entrypoint references
- Add git identity setup step before build: `sudo -u openclaw git config --global user.email/name`

### A7. Healthcheck `start_period`

**File:** `docker-compose.yml.hbs` line 88

Current: `start_period: 300s` (5 min). First boot sandbox builds take 15-25 min. Gateway only becomes healthy after sandbox build completes.

**Fix:** Increase to `start_period: 1800s` (30 min) for first-boot safety. Subsequent boots (images cached) start in ~30s, so this only affects the initial grace period.

---

## Part B: Comprehensive Code Scan

Systematic scan of all code for bugs that could surface during deployment or operation.

### B1. Shell safety scan

Scan all `.sh` files for common bash pitfalls:

- Unquoted variable expansions (word splitting/globbing)
- Pipelines without `|| true` under `set -eo pipefail` where grep/commands may return non-zero
- Missing `set -euo pipefail` in scripts that should have it
- Unescaped `$` in Docker Compose / heredocs
- Missing quotes around paths that could contain spaces

### B2. Path consistency scan

Verify all scripts use correct VPS directory layout:

- `${INSTALL_DIR}/deploy/` for compose + config (not `openclaw/`)
- `${INSTALL_DIR}/deploy/deploy/` for deploy scripts (not `scripts/`)
- `${INSTALL_DIR}/instances/<name>/` for per-claw data
- `${INSTALL_DIR}/openclaw/` for git repo only

### B3. Config variable scan

Grep for any remaining references to old config system:

- `openclaw-config.env` (removed)
- `openclaws/` directory (removed)
- `models.json` as separate file (merged into openclaw.jsonc)
- Old variable names: `VPS1_IP`, `SSH_KEY_PATH`, `OPENCLAWS_DIR`, `OPENCLAW_IMAGE`
- Direct `.env` reads from deploy scripts (should use `source-config.sh`)

### B4. Template / generated file consistency

- Verify `docker-compose.yml.hbs` renders correctly for edge cases (empty values, missing optional fields)
- Check `pre-deploy.ts` handles missing/undefined stack.yml fields gracefully
- Verify `.deploy/` output matches what VPS scripts expect

### B5. Playbook accuracy scan

Scan all playbooks for stale paths, commands, and references that don't match the new config architecture.

---

## Execution Order

1. **A1** — Fix start-claws.sh (critical — automated deploys broken)
2. **A2** — Fix setup-infra.sh (strip obsolete parts)
3. **A3** — Fix backup.sh (cron job, silent failures)
4. **A4** — Fix build-openclaw.sh version resolution
5. **A5** — Fix verify-deployment.sh
6. **A6** — Update playbook 04
7. **A7** — Increase healthcheck start_period
8. **B1-B5** — Code scan (parallel agents, report findings)

---

## Verification

1. `shellcheck deploy/scripts/start-claws.sh deploy/backup.sh deploy/scripts/setup-infra.sh` — no errors
2. Grep for old references: `grep -r 'openclaw-config\.env\|OPENCLAWS_DIR\|VPS1_IP\|SSH_KEY_PATH' deploy/ scripts/` returns zero matches
3. Deploy to VPS: `bun run pre-deploy` then sync and test start-claws.sh
4. Verify backup.sh runs without errors: `sudo -u openclaw bash deploy/backup.sh`
5. Verify build-openclaw.sh resolves version correctly on VPS
