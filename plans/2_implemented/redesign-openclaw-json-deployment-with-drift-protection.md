# Plan: OpenClaw Config Deployment Redesign

## Context

The current openclaw.json deployment flow has three problems:

1. **Redundant envsubst**: The entrypoint runs shell `envsubst` to resolve `$VAR` references, but OpenClaw already has native `${VAR}` substitution (`src/config/env-substitution.ts`) that resolves at load time in memory without rewriting the file. The shell envsubst rewrites the file, destroying `$VAR` references and making drift detection impossible.

2. **Merge-on-startup causes config surprises**: The staging + merge pattern (`openclaw.json.staged` → `merge-config.mjs` → live) was designed to preserve user modifications, but it also preserves deleted entries (e.g., removing an agent from the template doesn't remove it from live config). Users expect deployed config to match what they committed.

3. **No drift detection**: There's no way to know if the live config was modified (via UI, agent, etc.) since the last deploy. Deploying blindly either overwrites user changes (full replace) or silently preserves stale entries (merge).

**Goal**: Per-claw local files as source of truth, with drift detection for safety and OpenClaw's native `${VAR}` substitution replacing shell envsubst.

---

## Changes

### 1. Switch template syntax: `$VAR` → `${VAR}`

**File**: `openclaw/default/openclaw.jsonc` and  `openclaw/default/openclaw.router.jsonc`

Change all 13 `$VAR` references to `${VAR}` so OpenClaw's native substitution resolves them:

```
$OPENCLAW_DOMAIN_PATH      → ${OPENCLAW_DOMAIN_PATH}
$OPENCLAW_ALLOWED_ORIGIN   → ${OPENCLAW_ALLOWED_ORIGIN}
$OPENCLAW_INSTANCE_ID      → ${OPENCLAW_INSTANCE_ID}
$VPS_HOSTNAME              → ${VPS_HOSTNAME}
$ENABLE_EVENTS_LOGGING     → ${ENABLE_EVENTS_LOGGING}
$EVENTS_URL                → ${EVENTS_URL}
$LOG_WORKER_TOKEN          → ${LOG_WORKER_TOKEN}
$ENABLE_LLMETRY_LOGGING    → ${ENABLE_LLMETRY_LOGGING}
$LLMETRY_URL               → ${LLMETRY_URL}
$ANTHROPIC_BASE_URL        → ${ANTHROPIC_BASE_URL}
$OPENAI_CODEX_BASE_URL     → ${OPENAI_CODEX_BASE_URL}
$OPENAI_BASE_URL           → ${OPENAI_BASE_URL}
$ADMIN_TELEGRAM_ID         → ${ADMIN_TELEGRAM_ID}
```

Update the header comment (line 32): `// ${VAR} references are resolved at startup by OpenClaw's native env var substitution.`

All these vars are already set as container environment variables via `docker-compose.yml.hbs` (lines 47-78). No changes to the compose template needed.

### 2. Remove envsubst from entrypoint

**File**: `deploy/openclaw-stack/entrypoint.sh`

**Remove section 1e entirely** (lines 62-75) — the `envsubst` block that rewrites openclaw.json on disk. OpenClaw's native substitution handles this in memory at config load time.

### 3. Remove config staging from entrypoint entirely

**File**: `deploy/openclaw-stack/entrypoint.sh`

**Remove section 1d entirely** (lines 38-60) — the staged config merge block. Since sync-deploy now always uploads directly as `openclaw.json`, the staging mechanism (`openclaw.json.staged` → merge → live) serves no purpose and would only cause confusion.

Delete the entire block from `# ── 1d. Merge staged config` through the closing `fi` and `rm -f "$staged_file"` / `chmod`/`chown` lines.

The `merge-config.mjs` file stays in the repo untouched for now (no longer referenced by anything).

### 4. Add drift detection to sync-deploy.sh

**File**: `scripts/sync-deploy.sh`

Add `--force` flag to args parsing:

```bash
FORCE=false
# In case block:
--force)  FORCE=true; shift ;;
```

Replace the per-instance config sync loop (lines 174-200) with drift-aware logic:

```bash
DRIFT_DETECTED=false

for name in $INSTANCE_LIST; do
  local_file="${INSTANCES_DIR}/${name}/.openclaw/openclaw.json"
  if [ ! -f "$local_file" ]; then
    echo "Warning: No openclaw.json for instance '${name}', skipping." >&2
    continue
  fi

  remote_dir="${INSTALL_DIR}/instances/${name}/.openclaw"

  # Ensure remote directory exists
  ${SSH_CMD} "${VPS}" "sudo mkdir -p ${remote_dir}"

  # Check if remote config exists (first deploy detection)
  remote_exists=$(${SSH_CMD} "${VPS}" "[ -f ${remote_dir}/openclaw.json ] && echo yes || echo no")

  if [ "$remote_exists" = "yes" ] && ! $FRESH && ! $FORCE; then
    # Drift detection: compare deployed hash vs current live hash
    # NOTE: if sha256 is found to be unreliable in the future, try
    # comparing meta.lastTouchedAt in openclaw.json instead
    deployed_hash=$(${SSH_CMD} "${VPS}" "cat ${remote_dir}/openclaw.json.sha256 2>/dev/null || echo none")
    if [ "$deployed_hash" != "none" ]; then
      live_hash=$(${SSH_CMD} "${VPS}" "sha256sum ${remote_dir}/openclaw.json | cut -d' ' -f1")
      if [ "$deployed_hash" != "$live_hash" ]; then
        warn "Config drift detected for '${name}'!"
        warn "  Live config was modified since last deploy."
        warn "  Run:  scripts/sync-down-configs.sh --instance ${name}"
        warn "  Then: diff <your-source> openclaw/${name}/openclaw.live-version.jsonc"
        warn "  Re-run sync-deploy.sh with --force to overwrite."
        DRIFT_DETECTED=true
        continue
      fi
    fi
  fi

  # Upload config (always as openclaw.json — no staging)
  info "Syncing instance config: ${name}..."
  do_rsync "$local_file" "${VPS}:${remote_dir}/openclaw.json"
  ${SSH_CMD} "${VPS}" "sudo chown 1000:1000 ${remote_dir}/openclaw.json"

  # Write deploy hash for future drift detection
  local_hash=$(sha256sum "$local_file" | cut -d' ' -f1)
  ${SSH_CMD} "${VPS}" "echo ${local_hash} | sudo tee ${remote_dir}/openclaw.json.sha256 > /dev/null && sudo chown 1000:1000 ${remote_dir}/openclaw.json.sha256"
  success "instances/${name}/.openclaw/openclaw.json (hash: ${local_hash:0:12}...)"
done

if $DRIFT_DETECTED; then
  err "Deploy aborted — config drift detected (see warnings above)."
  exit 1
fi
```

Key behaviors:

- **First deploy** (no remote `openclaw.json`): uploads directly, writes hash — no interaction
- **No prior hash** (first deploy after migration): uploads directly, writes hash — no interaction
- **No drift** (hash matches): uploads directly, updates hash
- **Drift detected**: aborts, tells user to run `sync-down-configs.sh` and review
- **`--force`**: skips drift check, uploads directly, updates hash
- **`--fresh`**: skips drift check (implies first deploy)

Also remove the `$FRESH` conditional for `target_filename` (lines 182-187) since we always upload as `openclaw.json` now.

### 5. New script: `scripts/sync-down-configs.sh`

Downloads live openclaw.json from VPS for each claw, saving as `openclaw/<claw>/openclaw.live-version.jsonc` for local inspection and diffing.

```bash
#!/usr/bin/env bash
# sync-down-configs.sh — Download live openclaw.json configs from VPS
#
# Usage:
#   ./scripts/sync-down-configs.sh                    # All instances
#   ./scripts/sync-down-configs.sh --instance <name>  # One instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

SYNC_INSTANCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) SYNC_INSTANCE="$2"; shift 2 ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

INSTALL_DIR="$STACK__STACK__INSTALL_DIR"
SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }

# Discover instances from .deploy/ or stack config
CLAWS_IDS="$STACK__CLAWS__IDS"
if [ -n "$SYNC_INSTANCE" ]; then
  INSTANCE_LIST="$SYNC_INSTANCE"
else
  INSTANCE_LIST=$(echo "$CLAWS_IDS" | tr ',' ' ')
fi

for name in $INSTANCE_LIST; do
  remote_file="${INSTALL_DIR}/instances/${name}/.openclaw/openclaw.json"
  local_dir="${REPO_ROOT}/openclaw/${name}"
  local_file="${local_dir}/openclaw.live-version.jsonc"

  mkdir -p "$local_dir"

  info "Downloading live config for ${name}..."
  rsync -avz -e "${SSH_CMD}" --rsync-path='sudo rsync' \
    "${VPS}:${remote_file}" "$local_file" 2>/dev/null

  if [ $? -eq 0 ]; then
    success "→ ${local_file}"
  else
    warn "No live config found for ${name} (not yet deployed?)"
    continue
  fi
done

echo ""
echo "Review changes with:"
for name in $INSTANCE_LIST; do
  live_file="openclaw/${name}/openclaw.live-version.jsonc"
  [ -f "${REPO_ROOT}/${live_file}" ] || continue
  # Find the source config for this claw
  if [ -f "${REPO_ROOT}/openclaw/${name}/openclaw.jsonc" ]; then
    echo "  diff openclaw/${name}/openclaw.jsonc ${live_file}"
  else
    echo "  diff openclaw/default/openclaw.jsonc ${live_file}"
  fi
done
```

Add `openclaw/*/openclaw.live-version.jsonc` to `.gitignore`.

### 6. Remove dead code from pre-deploy.mjs

**File**: `build/pre-deploy.mjs`

Remove the unused `ENVSUBST_VARS` constant (lines 347-361) and its comment header. This list was informational only — never referenced in the build pipeline.

### 7. Update comments in docker-compose.yml.hbs

**File**: `docker-compose.yml.hbs`

Update comments that reference envsubst:

- Line 69: `# ── Identity (used by openclaw.json at runtime via envsubst) ──` → `# ── Identity (resolved by OpenClaw native ${VAR} substitution) ──`
- Line 72: `# ── Telemetry (used by openclaw.json at runtime via envsubst) ──` → `# ── Telemetry (resolved by OpenClaw native ${VAR} substitution) ──`

### 8. Update CLAUDE.md template syntax note

**File**: `CLAUDE.md`

Update the Template syntax bullet to reflect the change:

- Remove: `$VAR` in `openclaw.jsonc` (resolved by `envsubst` at container startup)
- Add: `${VAR}` in `openclaw.jsonc` (resolved by OpenClaw's native env var substitution at config load time)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `openclaw/default/openclaw.jsonc` | **Modify** | `$VAR` → `${VAR}` syntax (13 references) |
| `openclaw/default/openclaw.router.jsonc` | **Modify** | `$VAR` → `${VAR}` syntax (same 13 references) |
| `deploy/openclaw-stack/entrypoint.sh` | **Modify** | Remove section 1d (staging/merge) and section 1e (envsubst) |
| `scripts/sync-deploy.sh` | **Modify** | Add `--force`, drift detection, always upload as `openclaw.json` |
| `scripts/sync-down-configs.sh` | **New** | Download live configs for drift review |
| `build/pre-deploy.mjs` | **Modify** | Remove dead `ENVSUBST_VARS` constant |
| `docker-compose.yml.hbs` | **Modify** | Update envsubst comments |
| `CLAUDE.md` | **Modify** | Update template syntax reference |
| `.gitignore` | **Modify** | Add `openclaw/*/openclaw.live-version.jsonc` |

**Not modified** (intentionally kept):

- `deploy/openclaw-stack/merge-config.mjs` — kept in repo, just no longer called by entrypoint

---

## Deployment Flow (After)

```
Fresh deploy:
  pre-deploy → sync-deploy --fresh → OpenClaw loads ${VAR} natively

Subsequent deploy:
  pre-deploy → sync-deploy --all
    → per-claw: check drift (deployed hash vs live hash)
    → no drift: upload directly, update hash
    → drift detected: abort, prompt sync-down-configs + --force

Drift recovery:
  sync-down-configs.sh → review diff → edit local → sync-deploy --force
```

---

## Verification

1. `npm run pre-deploy` — confirm `.deploy/instances/*/openclaw.json` has `${VAR}` syntax (not `$VAR`)
2. Deploy to VPS with `sync-deploy.sh --all` — verify:
   - First deploy (no hash file): uploads directly, creates `.sha256` sidecar
   - Config on disk has `${VAR}` references (not resolved)
3. Restart containers — verify:
   - Entrypoint logs show no merge/envsubst steps
   - OpenClaw starts correctly with `${VAR}` resolved via native substitution
   - Check gateway logs: config loaded, vars resolved
4. Run `sync-deploy.sh --all` again (no changes) — verify no drift, clean upload
5. Modify live config via OpenClaw UI (e.g., change a setting)
6. Run `sync-deploy.sh --all` — verify drift detected, deploy aborted
7. Run `sync-down-configs.sh` — verify live config downloaded to `openclaw/<claw>/openclaw.live-version.jsonc`
8. Run `sync-deploy.sh --all --force` — verify override works, hash updated
