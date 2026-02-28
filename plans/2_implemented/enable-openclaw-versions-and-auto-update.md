# Version-Aware OpenClaw Build with Auto-Update Support (v2)

## Context

OpenClaw containers currently can't auto-update because:

1. `.git` is excluded from the Docker image by `.dockerignore` — the update engine detects `not-git-install` and skips
2. The build script always builds from whatever branch/commit the host checkout is on (currently `main`), with no way to target a specific version tag
3. Build patches create a dirty git tree inside the container, causing the update engine to skip with `reason: "dirty"`

We investigated runtime `.git` injection (`docker cp`) but Sysbox prevents `chown` of root-owned files. The solution is to include `.git` at image build time via the existing `COPY --chown=node:node . .` directive.

**Goal**: Enable the native `openclaw update` command to work inside containers by:

- Adding `OPENCLAW_VERSION` config to control which version/tag to build from
- Committing patches to a `vps-patch/<version>` branch so the container's `.git` has a clean working tree
- Including `.git` in the Docker image with correct `node:node` ownership
- Per-claw opt-in via `ALLOW_OPENCLAW_UPDATES` env var (updates disabled by default)
- Entrypoint handles all runtime git setup: branch switching, exclude rules, or `.git` removal

**Scope**: Updates survive `docker restart` (overlay filesystem persists) but NOT `docker compose up -d --force-recreate` (which resets to the base image). Container recreation requires a host-level rebuild.

**Update channel behavior**: The entrypoint switches the `.git` to a detached HEAD on the version tag (e.g. `v2026.2.26`). OpenClaw's channel resolver auto-detects `"stable"` channel from the tag — no `update.channel` config in `openclaw.json` needed. This means users can freely edit/reset `openclaw.json` without accidentally changing update behavior.

**VPS patches are build-time only**: Patches are committed to `vps-patch/<version>` for a clean build, but are not needed at runtime. When `openclaw update` runs, it does `git checkout --detach <new-tag>`, which moves to the unpatched upstream tag — this is expected and correct. Patches only matter for Docker image builds on the host.

## Changes

### 1. Add config variables

**File**: `openclaw-config.env.example` (after `INSTALL_DIR` section)

```env
# === OPENCLAW VERSION ===
OPENCLAW_VERSION=                  # Version to build. "stable" = latest stable tag, "" or "latest" = main branch, or specific tag (e.g., v2026.2.26)
# Per-claw override in openclaws/<name>/config.env:
# ALLOW_OPENCLAW_UPDATES=true      # Enable in-container auto-updates for this claw (default: disabled)
```

**File**: `deploy/scripts/source-config.sh`

- Add defaults: `OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"` and `ALLOW_OPENCLAW_UPDATES="${ALLOW_OPENCLAW_UPDATES:-false}"`

### 2. Rewrite build-openclaw.sh for version-aware builds

**File**: `deploy/build-openclaw.sh`

New flow (replaces current script):

```
 1. Read OPENCLAW_VERSION from env (default: "latest")
 2. Resolve version:
    - "latest" or "" → stay on current branch (main)
    - "stable"       → git fetch --tags, find latest v20XX.X.X non-beta tag
    - "vXXXX.X.X"   → git fetch --tags, checkout that specific tag
 3. Record resolved version (from package.json after checkout)
 4. Create+checkout vps-patch/<version> branch from the resolved ref
 5. Apply patches (same 5 patches, auto-skipping as today)
 6. Commit all changes to vps-patch branch ("VPS patches for <version>")
 7. Comment out .git line in .dockerignore (so COPY picks up .git)
 8. docker build -t openclaw:local .
    └─ At this point the HOST repo is on vps-patch/<version> with a CLEAN
       working tree (patches committed in step 6). The Dockerfile's
       COPY --chown=node:node . .  copies this clean .git into the image.
       The image is now frozen — container's .git starts on branch
       vps-patch/<version>. The entrypoint handles switching to the
       correct detached tag for the update engine.
 9. Restore HOST only: checkout main, restore .dockerignore
    └─ This only affects the host filesystem. The built image is immutable.
10. Cleanup: add trap handler for steps 7-9 so interrupted builds
    don't leave the host repo in a dirty state.
```

**Key differences from current script:**

- Version checkout before patching (step 2-3)
- Patches committed to a named branch → clean tree in container (step 4-6)
- `.git` included in Docker image (step 7) — Dockerfile's existing `COPY --chown=node:node . .` handles ownership
- `.git-info` generation removed from build script — now handled by entrypoint/dashboard (see changes 3-4)
- Cleanup restores host to `main` regardless of what was built (step 9)
- Trap handler ensures host repo is restored even if build fails (step 10)
- `vps-patch/<version>` branches accumulate on host as an audit trail
- Remote is already HTTPS (from initial `git clone`) — no SSH key changes needed

### 3. Entrypoint: conditional .git handling

**File**: `deploy/entrypoint-gateway.sh` (new section §1d, after §1c ownership fix, before §1e symlink)

The entrypoint handles two scenarios based on `ALLOW_OPENCLAW_UPDATES`:

**When updates are disabled (default):**

- Cache git log to `.git-info-<version>` for the dashboard
- Delete `.git` — causes update engine to detect `not-git-install` for both the background scheduler AND the UI update button

**When updates are enabled:**

- Switch from the build-time `vps-patch/<version>` branch to a detached HEAD on the version tag
- This makes the channel resolver auto-detect `"stable"` channel (no config needed)
- Populate `.git/info/exclude` with paths that would otherwise show as untracked and cause the dirty check to skip updates
- The exclude list is generated dynamically from `git status --porcelain` so it's future-proof — any bind-mounted or generated files get excluded automatically

```bash
# ── 1d. Conditional update support + git-info cache ──────────────
if [ -d /app/.git ]; then
  VERSION=$(node -e "console.log(require('/app/package.json').version)" 2>/dev/null || echo "unknown")

  if [ "${ALLOW_OPENCLAW_UPDATES}" = "true" ]; then
    # ── Switch to detached tag for stable channel auto-detection ──
    # The image was built on vps-patch/<version> branch (for clean patched build).
    # The update engine's channel resolver detects:
    #   - Named branch → "dev" channel (heavy: preflight builds, rebase)
    #   - Detached tag  → "stable" channel (light: fetch tags, checkout new tag)
    # Detach onto the version tag so updates use the simpler stable path.
    TAG="v${VERSION}"
    if git -C /app tag --list "$TAG" | grep -q "$TAG"; then
      git -C /app checkout --detach "$TAG" 2>/dev/null
      echo "[entrypoint] Updates enabled — detached HEAD at ${TAG} (stable channel)"
    else
      echo "[entrypoint] Updates enabled — tag ${TAG} not found, staying on current branch"
    fi

    # ── Exclude bind-mounted and generated files from git dirty check ──
    # The update engine runs: git status --porcelain -- :!dist/control-ui/
    # Any untracked files cause it to skip with reason: "dirty".
    # Bind mounts (deploy/, scripts/entrypoint-gateway.sh) and generated files
    # (.git-info*) appear as untracked. Rather than hardcoding paths, discover
    # them dynamically so new bind mounts are auto-excluded.
    EXCLUDE_FILE="/app/.git/info/exclude"
    echo "# Auto-generated by entrypoint — excludes bind-mounted/generated files" > "$EXCLUDE_FILE"
    git -C /app status --porcelain 2>/dev/null | grep '^??' | awk '{print $2}' >> "$EXCLUDE_FILE"
    EXCLUDE_COUNT=$(wc -l < "$EXCLUDE_FILE")
    echo "[entrypoint] Added $((EXCLUDE_COUNT - 1)) paths to .git/info/exclude"

  else
    # ── Updates disabled: cache git log, then remove .git ──
    if [ -d /app/.git ]; then
      git -C /app log --format='%h%x09%s%x09%aI' -50 > "/app/.git-info-${VERSION}" 2>/dev/null || true
      rm -rf /app/.git
      echo "[entrypoint] Updates disabled — removed .git, cached git-info for v${VERSION}"
    fi
  fi
fi
```

**Why dynamic excludes over a hardcoded list:**

- Bind mounts are defined in `openclaw-multi.sh` and may change over time
- New deploy files (plugins, configs) may be added without updating the exclude list
- `git status --porcelain | grep '^??'` captures exactly what git considers untracked right now
- `.git/info/exclude` is git's built-in local ignore — not tracked, no dirty tree, survives git operations

**Why detached tag over config patching:**

- `update.channel` in `openclaw.json` can be accidentally deleted by users editing config
- Environment variables for channel control don't exist in OpenClaw (no `OPENCLAW_UPDATE_CHANNEL`)
- A detached tag is self-describing — the channel resolver reads it directly from git state
- After `openclaw update` runs, it does `git checkout --detach <new-tag>` which maintains the same pattern

### 4. Dashboard: self-healing versioned git-info

**File**: `deploy/dashboard/data/stats.mjs` — rewrite `getGit()` function (lines 466-478) and update `getVersion()` (lines 391-398)

Current `getGit()` reads a static `/app/.git-info` file. New behavior:

```javascript
// getVersion() — always read live from package.json so updates are detected
function getVersion() {
  try {
    return JSON.parse(readFileSync('/app/package.json', 'utf8')).version || '—'
  } catch { return '—' }
}

// getGit() — versioned cache with live .git fallback
function getGit() {
  const version = getVersion()
  const cacheFile = `/app/.git-info-${version}`

  // 1. Try versioned cache (written by entrypoint or previous dashboard run)
  try {
    return parseGitInfo(readFileSync(cacheFile, 'utf8'))
  } catch { /* no cache */ }

  // 2. Try live git (available when ALLOW_OPENCLAW_UPDATES=true)
  try {
    const out = execFileSync('git', ['log', '--format=%h%x09%s%x09%aI', '-50'], { cwd: '/app' })
    // Cache for next time
    writeFileSync(cacheFile, out)
    return parseGitInfo(out.toString())
  } catch { /* no .git */ }

  // 3. Fallback: legacy .git-info (pre-update builds)
  try {
    return parseGitInfo(readFileSync('/app/.git-info', 'utf8'))
  } catch { return [] }
}
```

**Self-healing flow after in-container update:**

1. OpenClaw updates from v2026.2.25 → v2026.2.26
2. `package.json` now says `2026.2.26`
3. Dashboard's `getVersion()` returns new version (reads live)
4. `getGit()` looks for `.git-info-2026.2.26` → miss
5. Falls back to `git log` against updated `.git` → generates + caches `.git-info-2026.2.26`
6. Subsequent calls use the cache

### 5. Pass ALLOW_OPENCLAW_UPDATES to per-claw containers

**File**: `deploy/scripts/openclaw-multi.sh` (compose generation)

Add `ALLOW_OPENCLAW_UPDATES` to the per-claw environment section in the generated docker-compose override. Value sourced from per-claw `config.env` (e.g., `openclaws/muxxibot/config.env`).

## File Summary

| File | Action |
|------|--------|
| `openclaw-config.env.example` | Add `OPENCLAW_VERSION` and `ALLOW_OPENCLAW_UPDATES` fields |
| `deploy/scripts/source-config.sh` | Add defaults for both new vars |
| `deploy/build-openclaw.sh` | Rewrite: version checkout → vps-patch branch → commit patches → include .git → trap cleanup |
| `deploy/entrypoint-gateway.sh` | Add §1d: detach to tag + dynamic excludes (updates on) or cache + rm .git (updates off) |
| `deploy/dashboard/data/stats.mjs` | Rewrite `getGit()` with versioned cache + live fallback; `getVersion()` reads live |
| `deploy/scripts/openclaw-multi.sh` | Pass `ALLOW_OPENCLAW_UPDATES` env to per-claw containers |

## Security Notes

- `.git` in the container exposes full commit history. If a container is compromised, an attacker gets the complete source tree. This is acceptable because OpenClaw is open source — the history contains no secrets beyond what's publicly available. The `ALLOW_OPENCLAW_UPDATES=false` default (which deletes `.git` at startup) minimizes exposure for most containers.
- `.git/info/exclude` entries are auto-discovered from `git status` at startup. A malicious bind mount could add unexpected files, but the exclude file only affects git's ignore list — it doesn't grant access or modify tracked files.
- The HTTPS remote (already configured from initial clone) means no SSH keys are needed or exposed in containers.

## Verification

After rebuilding and deploying:

**Claw with `ALLOW_OPENCLAW_UPDATES=true`:**

1. Container logs show: `[entrypoint] Updates enabled — detached HEAD at v<version> (stable channel)`
2. Container logs show: `[entrypoint] Added N paths to .git/info/exclude`
3. `git -C /app status --porcelain -- :!dist/control-ui/` → empty (clean tree)
4. `git -C /app describe --tags --exact-match` → `v<version>` (on a tag)
5. `openclaw update --json` → `mode: "git"`, channel should resolve to `"stable"`
6. Dashboard git log section shows commits

**Claw with updates disabled (default):**
7. Container logs show: `[entrypoint] Updates disabled — removed .git, cached git-info for v<version>`
8. `ls /app/.git` → "No such file or directory"
9. `ls /app/.git-info-*` → `.git-info-<version>` exists
10. `openclaw update --json` → `reason: "not-git-install"`
11. Dashboard git log section still shows commits (from cached `.git-info-<version>`)

**Host state:**
12. `git branch` in openclaw dir → `vps-patch/<version>` branch exists alongside `main`
13. Host is on `main` branch after build completes
14. `.dockerignore` is restored (`.git` line uncommented)
