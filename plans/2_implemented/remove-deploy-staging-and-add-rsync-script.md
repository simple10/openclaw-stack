# Plan: Replace `.deploy-staging` with rsync-based `sync-deploy.sh`

## Context

The current deploy flow uses a staging directory (`.deploy-staging`) on the VPS: SCP everything to a temp location, manually copy files to final paths (with path remapping), then clean up. This adds unnecessary complexity — 3 steps where 1 suffices. The `.deploy/` output from `pre-deploy.mjs` is *almost* a 1:1 mirror of the VPS `INSTALL_DIR`, except per-claw configs output to `.deploy/openclaw/<name>/` instead of `.deploy/instances/<name>/.openclaw/`. Fixing that path and using rsync directly eliminates the staging concept entirely.

The existing `scripts/sync-configs.sh` (VPS→local pull) provides the exact SSH/rsync pattern to follow.

---

## Changes

### 1. Fix output path in `build/pre-deploy.mjs`

**File:** `build/pre-deploy.mjs` (lines 533-557)

Change per-claw output from `.deploy/openclaw/<name>/openclaw.json` to `.deploy/instances/<name>/.openclaw/openclaw.json` so `.deploy/` mirrors VPS layout exactly.

Also update:

- Line 546: success message
- Line 557: "Next:" hint → reference `scripts/sync-deploy.sh` instead of `cd .deploy && git add && git push`
- Lines 475-484: Remove the `.git` preservation logic (the deploy-as-git-repo approach is being replaced by rsync)

### 2. Create `scripts/sync-deploy.sh`

New script following the same patterns as `scripts/sync-configs.sh` (sources `source-config.sh`, uses `ENV__*` and `STACK__*` vars).

**Interface:**

```
scripts/sync-deploy.sh [OPTIONS]

  (no args)          Sync stack-level files only (safe default for updates)
  --all              Stack files + all instance configs
  --instance <name>  Stack files + one instance's config
  --fresh            Implies --all, prints post-sync next-steps
  -n, --dry-run      Preview without transferring
```

**Sync strategy — multiple targeted rsyncs:**

| Target | `--delete`? | Ownership | Why |
|--------|-------------|-----------|-----|
| Root files (compose, stack.env, stack.json) | No | `openclaw:openclaw` | Can't --delete at root (would nuke openclaw/, instances/) |
| `host/` | Yes | `openclaw:openclaw` | Deploy-managed, remove stale scripts |
| `openclaw-stack/` | Yes | `openclaw:openclaw` | Deploy-managed, remove stale files |
| `setup/` | Yes | `openclaw:openclaw` | Deploy-managed |
| `vector/vector.yaml` | No | `openclaw:openclaw` | Single file, protect vector/data/ |
| `instances/<name>/.openclaw/openclaw.json` | No | `1000:1000` | Single file per instance, protect runtime siblings |

Uses `--rsync-path="sudo rsync"` (same pattern as `sync-configs.sh`) to write as root, then fixes ownership via SSH chown commands.

### 3. Update `playbooks/04-vps1-openclaw.md`

Replace all `.deploy-staging` references (~12 occurrences):

- **Section 4.2 Steps 1**: Replace `mkdir .deploy-staging` + SCP with `scripts/sync-deploy.sh --fresh`
- **Section 4.2 Step 2**: Change `bash ${INSTALL_DIR}/.deploy-staging/setup/setup-infra.sh` → `bash ${INSTALL_DIR}/setup/setup-infra.sh`
- **Section 4.3 Step 1**: Remove the manual `cp` from staging to final locations (rsync already placed files directly)
- **Section 4.4**: Change `.deploy-staging/setup/start-claws.sh` → `${INSTALL_DIR}/setup/start-claws.sh`
- **Section 4.5**: Change `.deploy-staging/setup/verify-deployment.sh` and `register-cron-jobs.sh` paths
- **Section 4.6**: Remove the "Clean Up Staging" section entirely
- **File manifest table**: Update `.deploy/claws/<name>/` → `.deploy/instances/<name>/.openclaw/`

### 4. Update `playbooks/maintenance.md`

- **Single claw config update** (~line 241): Replace SCP command with `scripts/sync-deploy.sh --instance <name>`
- **Adding a new claw** (~lines 240-248): Replace SCP + staging + manual cp with `scripts/sync-deploy.sh --all`

### 5. Update `openclaw/default/README.md`

Line 6: Change `.deploy/openclaw/<name>/openclaw.json` → `.deploy/instances/<name>/.openclaw/openclaw.json`

---

## Files Modified

| File | Change |
|------|--------|
| `build/pre-deploy.mjs` | Output path, remove .git preservation, update "Next:" hint |
| `scripts/sync-deploy.sh` | **New file** — rsync wrapper |
| `playbooks/04-vps1-openclaw.md` | Replace ~12 staging references with sync script + final paths |
| `playbooks/maintenance.md` | Replace ~3 staging references |
| `openclaw/default/README.md` | Update output path reference |

---

## Verification

1. `npm run pre-deploy` — confirm `.deploy/instances/personal-claw/.openclaw/openclaw.json` exists (not `.deploy/openclaw/personal-claw/`)
2. `scripts/sync-deploy.sh --dry-run` — verify rsync commands target correct paths with correct excludes
3. `scripts/sync-deploy.sh --dry-run --all` — verify instance configs are included
4. `grep -r deploy-staging playbooks/` — confirm zero remaining references
