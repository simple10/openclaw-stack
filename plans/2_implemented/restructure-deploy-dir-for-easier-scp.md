# Plan: Restructure deploy directory into three-tier layout

## Context

The current `deploy/` directory mixes container scripts, host cron scripts, deploy-time scripts, and config helpers in one flat directory. During pre-deploy, files get shuffled into `.deploy/deploy/`, which lands on VPS as `deploy/deploy/` — creating a confusing nested layout where `source-config.sh` can't be found by scripts that need it. The fix during the last deploy was a symlink, which is fragile.

**Goal:** Restructure so files are organized by tier (container, host, deploy-time, local-only). Pre-deploy assembles `.deploy/` as the single deployable artifact — a perfect mirror of VPS `INSTALL_DIR/`. Deployment is just `rsync .deploy/ → INSTALL_DIR/`.

## New Directory Structure

### Local repo

```
repo/
  .env                              ← secrets (gitignored)
  stack.yml                         ← stack config (gitignored)
  docker-compose.yml.hbs            ← compose template (stays at root)
  build/
    pre-deploy.ts                   ← build tooling
  openclaw/
    default/
      openclaw.jsonc                ← per-claw config template
      sandbox-toolkit.yaml
  playbooks/                        ← deployment docs
  scripts/                          ← LOCAL-ONLY utilities (tier 3)
    ssh-vps.sh
    health-check.sh
    openclaw.sh
    ... (16 scripts)
  deploy/                           ← EVERYTHING deployed to VPS
    openclaw-stack/                  ← CONTAINER bind mount (tier 1) → /app/openclaw-stack:ro
      entrypoint.sh                 ← was deploy/entrypoint-gateway.sh
      rebuild-sandboxes.sh
      parse-toolkit.mjs
      dashboard/                    ← full dashboard app
      plugins/                      ← telemetry, coordinator
    host/                           ← HOST-ONLY scripts (tier 2)
      source-config.sh              ← config resolver (was deploy/scripts/source-config.sh)
      backup.sh
      host-alert.sh
      host-maintenance-check.sh
      session-prune.sh
      build-openclaw.sh
      system-hardening.sh
      logrotate-openclaw
    setup/                           ← DEPLOY-TIME scripts (run once, not kept permanently)
      setup-infra.sh
      start-claws.sh
      verify-deployment.sh
      register-cron-jobs.sh
    vector/
      vector.yaml
```

### VPS layout (exact mirror of `.deploy/`)

```
<INSTALL_DIR>/                       ← /home/muxxibot/openclaw
  docker-compose.yml                 ← rendered compose file
  stack.env                          ← generated config
  stack.json                         ← generated config
  openclaw-stack/                    ← bind-mounted as /app/openclaw-stack:ro
    entrypoint.sh
    rebuild-sandboxes.sh
    parse-toolkit.mjs
    sandbox-toolkit.yaml             ← copied from stack.yml ref (if configured)
    dashboard/
    plugins/
  host/                              ← host cron scripts
    source-config.sh
    backup.sh
    host-alert.sh
    ...
  vector/
    vector.yaml
  instances/
    personal-claw/
      .openclaw/                     ← bind-mounted as /home/node/.openclaw
      docker/                        ← bind-mounted as /var/lib/docker
  source/
    openclaw/                        ← git clone
  logs/                              ← shared log dir
```

### Container view

```
/app/                                ← openclaw source (image)
  /app/openclaw-stack/               ← bind mount (ro) — our custom scripts
    entrypoint.sh
    rebuild-sandboxes.sh
    parse-toolkit.mjs
    sandbox-toolkit.yaml             ← if configured in stack.yml
    dashboard/
    plugins/
  /home/node/.openclaw/              ← bind mount (rw) — per-claw state
  /var/lib/docker/                   ← bind mount (rw) — nested Docker
```

## source-config.sh Discovery (Standardized)

Three standard patterns based on script location:

| Script location | Source line | Resolves to |
|---|---|---|
| `deploy/host/*.sh` | `source "$(dirname $0)/source-config.sh"` | Sibling in same dir |
| `deploy/setup/*.sh` | `source "$(dirname $0)/../host/source-config.sh"` | Sibling dir's parent |
| `scripts/*.sh` | `source "$(dirname $0)/../deploy/host/source-config.sh"` | Fixed relative path |

The walk-up inside `source-config.sh` then finds config:

- **Local:** walks up from `deploy/host/` → repo root → finds `.env` + `.deploy/`
- **VPS:** walks up from `<INSTALL_DIR>/host/` → `<INSTALL_DIR>/` → finds `stack.env` + `stack.json`

No symlinks. No hardcoded paths. No `scripts/source-config.sh` indirection.

## Key Changes

### 1. Rename/move files

| Old path | New path |
|---|---|
| `deploy/entrypoint-gateway.sh` | `deploy/openclaw-stack/entrypoint.sh` |
| `deploy/rebuild-sandboxes.sh` | `deploy/openclaw-stack/rebuild-sandboxes.sh` |
| `deploy/parse-toolkit.mjs` | `deploy/openclaw-stack/parse-toolkit.mjs` |
| `deploy/dashboard/` | `deploy/openclaw-stack/dashboard/` |
| `deploy/plugins/` | `deploy/openclaw-stack/plugins/` |
| `deploy/backup.sh` | `deploy/host/backup.sh` |
| `deploy/host-alert.sh` | `deploy/host/host-alert.sh` |
| `deploy/host-maintenance-check.sh` | `deploy/host/host-maintenance-check.sh` |
| `deploy/session-prune.sh` | `deploy/host/session-prune.sh` |
| `deploy/build-openclaw.sh` | `deploy/host/build-openclaw.sh` |
| `deploy/system-hardening.sh` | `deploy/host/system-hardening.sh` |
| `deploy/logrotate-openclaw` | `deploy/host/logrotate-openclaw` |
| `deploy/scripts/source-config.sh` | `deploy/host/source-config.sh` |
| `deploy/scripts/setup-infra.sh` | `deploy/setup/setup-infra.sh` |
| `deploy/scripts/start-claws.sh` | `deploy/setup/start-claws.sh` |
| `deploy/scripts/verify-deployment.sh` | `deploy/setup/verify-deployment.sh` |
| `deploy/scripts/register-cron-jobs.sh` | `deploy/setup/register-cron-jobs.sh` |
| `deploy/scripts/cf-tunnel-setup.sh` | `scripts/cf-tunnel-setup.sh` (local-only) |
| `deploy/vector/vector.yaml` | `deploy/vector/vector.yaml` |
| `scripts/lib/resolve-gateway.sh` | `scripts/lib/resolve-gateway.sh` (unchanged) |

### 2. Update docker-compose.yml.hbs

```yaml
# Old:
entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
volumes:
  - ./entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
  - ./deploy:/app/deploy:ro

# New:
entrypoint: ["/app/openclaw-stack/entrypoint.sh"]
volumes:
  - ./openclaw-stack:/app/openclaw-stack:ro
```

Two bind mounts become one. The entrypoint is inside the mount.

Vector volume also changes:

```yaml
# Old:
- {{stack.install_dir}}/deploy/vector/vector.yaml:/etc/vector/vector.yaml:ro

# New:
- ./vector/vector.yaml:/etc/vector/vector.yaml:ro
```

### 3. Update container-internal path references

All `/app/deploy/` references become `/app/openclaw-stack/`:

| File | Changes |
|---|---|
| `deploy/openclaw-stack/entrypoint.sh` | All `/app/deploy/` → `/app/openclaw-stack/` |
| `deploy/openclaw-stack/rebuild-sandboxes.sh` | `/app/deploy/` → `/app/openclaw-stack/` |
| `openclaw/default/openclaw.jsonc` | Plugin path `/app/deploy/plugins` → `/app/openclaw-stack/plugins` |

### 4. Update source-config.sh source lines

**Host scripts** (`deploy/host/*.sh`) — change from `scripts/source-config.sh` to sibling:

```bash
# Old: source "$(cd "$(dirname "$0")" && pwd)/scripts/source-config.sh"
# New: source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"
```

**Setup scripts** (`deploy/setup/*.sh`) — change to parent's sibling:

```bash
# Old: source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"  (was sibling in scripts/)
# New: source "$(cd "$(dirname "$0")" && pwd)/../host/source-config.sh"
```

**Local scripts** (`scripts/*.sh`) — change path:

```bash
# Old: source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"
# New: source "$SCRIPT_DIR/../deploy/host/source-config.sh"
```

**host-maintenance-check.sh** — add source-config.sh (currently uses hardcoded fallback):

```bash
# Old: INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"
# New: source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"
#      INSTALL_DIR="${STACK__STACK__INSTALL_DIR}"
```

### 5. Update build/pre-deploy.ts

Pre-deploy is the "brains" — it assembles `.deploy/` as the single deployable artifact that perfectly mirrors VPS `INSTALL_DIR/`. Deployment is just syncing this one directory to the VPS.

**What pre-deploy assembles:**

```
.deploy/                           ← mirrors VPS INSTALL_DIR exactly
  docker-compose.yml               ← rendered from docker-compose.yml.hbs
  stack.env                        ← generated from .env + stack.yml
  stack.json                       ← generated from stack.yml
  openclaw-stack/                  ← copied from deploy/openclaw-stack/
    entrypoint.sh
    rebuild-sandboxes.sh
    parse-toolkit.mjs
    sandbox-toolkit.yaml           ← copied from stack.yml reference (if configured)
    dashboard/
    plugins/
  host/                            ← copied from deploy/host/
    source-config.sh
    backup.sh
    ...
  setup/                           ← copied from deploy/setup/
  vector/                          ← copied from deploy/vector/
  openclaw/                        ← generated per-claw configs
    personal-claw/
      openclaw.json
```

**Key changes from current pre-deploy:**

- Copy `deploy/openclaw-stack/` → `.deploy/openclaw-stack/` (replaces old `deploy/<artifact>` → `.deploy/deploy/<artifact>` assembly)
- Copy `deploy/host/` → `.deploy/host/` (replaces individual script copies)
- Copy `deploy/setup/` → `.deploy/setup/`
- Copy `deploy/vector/` → `.deploy/vector/`
- If `stack.yml` references a `sandbox_toolkit` file, copy it to `.deploy/openclaw-stack/sandbox-toolkit.yaml`
- No more `DEPLOY_DIR/deploy/<artifact>` nesting — subdirectories copy directly

### 6. Update setup-infra.sh

The VPS directory structure changes:

- Compose root moves from `<INSTALL_DIR>/deploy/` to `<INSTALL_DIR>/`
- `openclaw-stack/`, `host/`, `vector/` are direct children of `<INSTALL_DIR>/`
- No more `deploy/deploy/` nesting

The staging-to-permanent copy step becomes simpler — just move the directories from staging to `<INSTALL_DIR>/` preserving structure.

### 7. Update all playbooks

All SSH command patterns change:

```bash
# Old:
sudo -u openclaw bash -c 'cd <INSTALL_DIR>/deploy && docker compose up -d'

# New:
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
```

Cron job paths change:

```bash
# Old: <INSTALL_DIR>/deploy/deploy/backup.sh
# New: <INSTALL_DIR>/host/backup.sh
```

### 8. Update CLAUDE.md

Service management commands, SSH quick reference, and template syntax sections all reference `deploy/` paths.

### 9. Update .gitignore

Ensure `.deploy/` is still gitignored. Remove any stale ignores. Add `deploy/openclaw-stack/sandbox-toolkit.yaml` if it's a generated/synced file.

## Files to modify

**Move/rename (git mv):**

- All files listed in the rename table above

**Edit (content changes):**

- `docker-compose.yml.hbs` — mount paths, entrypoint
- `build/pre-deploy.ts` — output structure, copy logic
- `deploy/openclaw-stack/entrypoint.sh` — all `/app/deploy/` refs
- `deploy/openclaw-stack/rebuild-sandboxes.sh` — all `/app/deploy/` refs
- `deploy/host/backup.sh` — source-config line
- `deploy/host/host-alert.sh` — source-config line
- `deploy/host/session-prune.sh` — source-config line
- `deploy/host/build-openclaw.sh` — source-config line
- `deploy/host/host-maintenance-check.sh` — add source-config, remove hardcoded fallback
- `deploy/setup/setup-infra.sh` — source-config line, directory structure
- `deploy/setup/start-claws.sh` — source-config line
- `deploy/setup/verify-deployment.sh` — source-config line
- `deploy/setup/register-cron-jobs.sh` — source-config line
- `scripts/cf-tunnel-setup.sh` — source-config line
- All 16+ `scripts/*.sh` — source-config path
- `openclaw/default/openclaw.jsonc` — plugin path
- `CLAUDE.md` — all path references
- `playbooks/*.md` — all path references
- `devutils/reset-ssh.sh` — source-config path

## Verification

1. **Local:** `bun run pre-deploy:dry` — verify `.deploy/` has correct structure
2. **Local:** `bun run pre-deploy` — full build succeeds
3. **Check:** `.deploy/` contains `openclaw-stack/`, `host/`, `setup/`, `vector/`, `docker-compose.yml`, `stack.env`, `stack.json`
4. **Check:** No `deploy/deploy/` nesting anywhere
5. **VPS test:** Fresh deploy using updated playbooks (or apply to existing VPS)
6. **Container test:** `docker exec openclaw-personal-claw ls /app/openclaw-stack/` shows entrypoint, dashboard, plugins
7. **Host test:** Run `sudo <INSTALL_DIR>/host/backup.sh` — should source config correctly
8. **Cron test:** All cron jobs point to `<INSTALL_DIR>/host/` paths
