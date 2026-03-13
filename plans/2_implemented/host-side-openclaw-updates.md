# Host-Side Auto-Update with Per-Claw Versioning

## Context

The in-container update mechanism is fundamentally broken — the multi-stage Docker build produces a lean runtime image that lacks the full dev environment needed by the update engine. After 5+ patch layers, we're replacing it with host-side updates.

At the same time, we're adding per-claw version pinning so individual claws can run different OpenClaw versions (e.g., one on `stable`, another pinned to `v2026.3.8` for testing).

---

## Key Design Decision: Image Tag Scheme

The compose template uses the version **specifier** as the Docker image tag:

```yaml
# Claw using stable:
image: openclaw-muxxibot:stable

# Claw pinned to specific version:
image: openclaw-muxxibot:v2026.3.8
```

The build script resolves each specifier (e.g., `stable` → `v2026.3.12`), builds the image, and tags it with **both** the specifier and the resolved version:

- `openclaw-muxxibot:stable` → current latest (mutable, updated by cron)
- `openclaw-muxxibot:v2026.3.12` → same image, immutable version tag (for rollback)

This means `docker compose up -d` doesn't need re-rendering when versions update — only the Docker image behind `:stable` changes.

---

## Changes

### 1. Per-claw version in `stack.yml`

**`stack.yml.example`:**

```yaml
stack:
  openclaw:
    version: stable              # Stack-wide default: stable | latest | v2026.X.Y
    auto_update: true            # Daily host-side rebuild when new stable tag available
    source: https://github.com/openclaw/openclaw.git

defaults:
  # Remove allow_updates entirely — host handles updates now
  # Per-claw openclaw_version falls back to stack.openclaw.version

claws:
  personal-claw:
    # No openclaw_version → inherits stack.openclaw.version (stable)

  work-claw:
    openclaw_version: v2026.3.8  # Pinned — auto-update skips pinned versions
```

### 2. Pre-deploy: resolve per-claw image tags

**`build/pre-deploy.mjs`:**

In `computeDerivedValues()` or claw merge loop (~line 589-596):

- For each claw: `claw.openclaw_version = claw.openclaw_version ?? config.stack.openclaw.version ?? 'stable'`
- Compute image tag: `claw.openclaw_image_tag = 'openclaw-' + projectName + ':' + claw.openclaw_version`

In `generateStackEnv()` (~line 526-538):

- Add: `STACK__CLAWS__<CLAW>__OPENCLAW_VERSION=<specifier>` per claw
- Add: `STACK__OPENCLAW_VERSIONS=stable,v2026.3.8` (deduplicated list of all unique version specifiers across claws — consumed by build script)
- Remove: `STACK__STACK__IMAGE` (no longer a single image — replaced by per-claw tags)
- Add: `STACK__STACK__OPENCLAW__AUTO_UPDATE=true|false`

Remove `allow_updates` from per-claw env generation and from all processing.

### 3. Compose template: per-claw image

**`docker-compose.yml.hbs`:**

Move `image:` out of the `&claw` anchor and into each claw's service block:

```yaml
x-openclaw-claw: &claw
  # image removed from anchor — varies per claw
  runtime: sysbox-runc
  ...

{{#each claws}}
  {{../stack.project_name}}-openclaw-{{@key}}:
    <<: *claw
    image: {{this.openclaw_image_tag}}
    container_name: {{../stack.project_name}}-openclaw-{{@key}}
    ...
    environment:
      - NODE_ENV=production
      - CI=true
      - TZ={{this.timezone}}
      # Remove OPENCLAW_SYSTEMD_UNIT — no in-container updates
      # Remove ALLOW_OPENCLAW_UPDATES — removed entirely
      ...
{{/each}}
```

### 4. Build script: multi-version support

**`deploy/host/build-openclaw.sh`:**

Major restructuring — loop over unique version specifiers instead of building one image:

```
Flow:
1. Read STACK__OPENCLAW_VERSIONS (e.g., "stable,v2026.3.8")
2. For each unique version specifier:
   a. Resolve specifier → git ref (same logic as today)
   b. Checkout, create vps-patch branch, apply patches
   c. docker build -t openclaw-<project>:<specifier>
   d. Also tag with resolved version: openclaw-<project>:v2026.3.12
   e. Write resolved version to $INSTALL_DIR/.openclaw-versions/<specifier>
   f. Restore host to main
3. Prune old version-tagged images (keep current + 1 previous per specifier)
```

**Patches simplified:**

- Keep patches 4a (Docker+gosu), 4b (jiti cache), 4c (.dockerignore)
- **Remove patch 4d** (no more .git / full node_modules in runtime stage)
- **Remove step 6** (no more .dockerignore .git hack)

**Version state files:**

- `$INSTALL_DIR/.openclaw-versions/stable` → contains `2026.3.12`
- `$INSTALL_DIR/.openclaw-versions/v2026.3.8` → contains `2026.3.8`
- Used by auto-update cron to compare without re-parsing git

### 5. New script: `deploy/host/auto-update-openclaw.sh`

Daily cron script:

```
Flow:
1. Source source-config.sh
2. Read STACK__OPENCLAW_VERSIONS
3. For each unique specifier:
   - If pinned (starts with 'v') → skip
   - If 'stable':
     a. git fetch --tags in openclaw source dir
     b. Find latest stable tag
     c. Read current from $INSTALL_DIR/.openclaw-versions/stable
     d. If same → skip
     e. If newer → rebuild this specifier only (call build function)
   - If 'latest':
     a. git fetch origin in openclaw source dir
     b. Compare HEAD with current
     c. If same → skip
     d. If newer → rebuild
4. If any version was rebuilt:
   a. docker compose up -d (recreates only changed containers)
   b. Health-check containers (poll for 5 min)
   c. Send Telegram notification
5. If nothing changed → exit silently
```

Key: `docker compose up -d` only recreates containers whose image changed. Claws on an unchanged pinned version won't restart.

### 6. Register cron in `deploy/host/register-cron-jobs.sh`

Add Section 5 after existing cron sections:

- Schedule: `0 4 * * *` (4 AM, after backup/prune, before daily report)
- Runs as `openclaw` user
- Gated on `STACK__STACK__OPENCLAW__AUTO_UPDATE`
- Logs to `$INSTALL_DIR/logs/auto-update.log`

### 7. Start script: `deploy/host/start-claws.sh`

Update to call `build-openclaw.sh` which now handles multiple versions internally. The interface stays the same (build script reads env vars from source-config.sh).

### 8. Simplify entrypoint

**`deploy/openclaw-stack/entrypoint.sh`:**

The entire section 1d (`.git` handling, branch deletion, tag checkout, exclude logic) becomes dead code since `.git` is no longer in the image. The `if [ -d /app/.git ]` check evaluates to false and skips everything.

Options:

- **Minimal change:** Leave the code — it's a no-op and doesn't hurt
- **Clean up:** Replace section 1d with a comment explaining host-side updates

I'd go minimal — leave the code so `allow_updates` can be re-enabled per-claw if someone needs it for debugging.

### 9. Logrotate

**`deploy/host/logrotate-openclaw`:** Add stanza for `$INSTALL_DIR/logs/auto-update.log`

---

## Files Modified

| File | Change |
|------|--------|
| `deploy/host/build-openclaw.sh` | Multi-version loop, version tags, remove patch 4d + step 6, version state files |
| `deploy/host/auto-update-openclaw.sh` | **New** — daily update check per specifier |
| `deploy/host/register-cron-jobs.sh` | Add Section 5: auto-update cron |
| `deploy/host/start-claws.sh` | Minor — build interface unchanged |
| `build/pre-deploy.mjs` | Per-claw `openclaw_version`, `openclaw_image_tag`, `STACK__OPENCLAW_VERSIONS`, remove `allow_updates` + `STACK__STACK__IMAGE` |
| `docker-compose.yml.hbs` | Move `image:` to per-claw block, remove `ALLOW_OPENCLAW_UPDATES`, remove `OPENCLAW_SYSTEMD_UNIT` |
| `stack.yml.example` | Add `auto_update`, per-claw `openclaw_version` example, remove `allow_updates` |
| `deploy/host/logrotate-openclaw` | Add auto-update log rotation |

## Not Changed

| File | Why |
|------|-----|
| `deploy/openclaw-stack/entrypoint.sh` | Section 1d is a no-op without `.git` — leave for potential re-enable |
| `openclaw.jsonc` (`update.channel`) | Defer UI suppression to later |

---

## Implementation Order

1. **`build/pre-deploy.mjs`** — Per-claw version resolution, new env vars, remove `allow_updates`
2. **`stack.yml.example`** — Document new config shape
3. **`docker-compose.yml.hbs`** — Per-claw image tags, remove defunct env vars
4. **`deploy/host/build-openclaw.sh`** — Multi-version build loop, remove in-container patches
5. **`deploy/host/auto-update-openclaw.sh`** — New auto-update script
6. **`deploy/host/register-cron-jobs.sh`** — Register auto-update cron
7. **`deploy/host/logrotate-openclaw`** — Log rotation
8. **`deploy/host/start-claws.sh`** — Verify works with new build script

## Migration (existing VPS)

1. Update `stack.yml`: remove `allow_updates`, optionally add `auto_update: true` and per-claw `openclaw_version`
2. `npm run pre-deploy && scripts/sync-deploy.sh --all --force`
3. On VPS: `sudo -u openclaw $INSTALL_DIR/host/build-openclaw.sh` (builds version-tagged images)
4. `sudo -u openclaw bash -c 'cd $INSTALL_DIR && docker compose up -d'` (recreates containers with new images)
5. `sudo bash $INSTALL_DIR/host/register-cron-jobs.sh` (installs auto-update cron)

## Verification

1. `npm run pre-deploy` → stack.env has `STACK__OPENCLAW_VERSIONS`, per-claw `OPENCLAW_VERSION`
2. `docker images | grep openclaw` → version-tagged images exist (e.g., `:stable`, `:v2026.3.12`)
3. `cat $INSTALL_DIR/.openclaw-versions/stable` → resolved version
4. Run `auto-update-openclaw.sh` manually → "Already up to date"
5. Fake an older version in state file → re-run → triggers rebuild + Telegram notification
6. Container health check passes after recreate
7. Pinned claw container NOT restarted when stable claw updates
