# Plan: Staged Config Merge for openclaw.json

## Context

`openclaw.json` is the gateway config. It's built from `openclaw/default/openclaw.jsonc` by `pre-deploy`, synced to VPS, then `$VAR` references are resolved by `envsubst` at container startup. Users modify it at runtime via `openclaw config set` (e.g., changing default model). But `sync-deploy.sh --instance` **overwrites** the live file, destroying runtime changes.

The key insight: `$VAR` references (like `$ANTHROPIC_BASE_URL`, `$ADMIN_TELEGRAM_ID`) are a natural marker for "template-controlled" fields. Everything else is potentially user-modified.

---

## Approach: Staged File + Entrypoint Merge

Sync writes `openclaw.json.staged` instead of overwriting `openclaw.json`. At container startup, the entrypoint merges staged into live:

| Staged value | Live value | Result |
|---|---|---|
| Contains `$VAR` | Any | **Use staged** (template-controlled) |
| New key | Missing | **Add from staged** (new template field) |
| Missing | Exists | **Preserve live** (runtime addition) |
| No `$VAR` | Exists | **Preserve live** (user may have modified) |
| Object | Object | **Recurse** |
| Array with `$VAR` | Any | **Use staged** |
| Array, no `$VAR` | Exists | **Preserve live** |

Then envsubst runs as before, resolving `$VAR` references in the merged output.

---

## 1. `scripts/sync-deploy.sh` — Stage instead of overwrite

Change the instance sync loop (lines 174-192). Normal syncs write to `openclaw.json.staged`; `--fresh` retains direct overwrite.

```bash
if $FRESH; then
  target_filename="openclaw.json"
else
  target_filename="openclaw.json.staged"
fi
do_rsync "$local_file" "${VPS}:.../instances/${name}/.openclaw/${target_filename}"
```

---

## 2. `deploy/openclaw-stack/merge-config.mjs` — Merge algorithm (new file)

~60-line Node.js script. Takes `--staged`, `--live`, `--output` args. Uses `/\$[A-Z_]{2,}/` to detect template-controlled values. Recursive deep-merge with arrays treated as atomic.

---

## 3. `deploy/openclaw-stack/entrypoint.sh` — Merge before envsubst

New section 1d (existing envsubst becomes 1e):

```bash
staged_file="/home/node/.openclaw/openclaw.json.staged"
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$staged_file" ]; then
  if [ -f "$config_file" ]; then
    cp "$config_file" "${config_file}.pre-merge.bak"
    node /app/openclaw-stack/merge-config.mjs \
      --staged "$staged_file" --live "$config_file" --output "$config_file"
  else
    mv "$staged_file" "$config_file"
  fi
  rm -f "$staged_file"
  chmod 600 "$config_file"; chown 1000:1000 "$config_file"
fi
```

Also: add `$OPENAI_CODEX_BASE_URL` to the ENVSUBST_VARS whitelist (existing bug — template has it but entrypoint doesn't resolve it).

---

## Behavior Matrix

| Command | openclaw.json behavior |
|---------|----------------------|
| `sync-deploy.sh` (no instance flags) | Not touched |
| `sync-deploy.sh --instance <name>` | Writes `.staged`, merged on next restart |
| `sync-deploy.sh --all` | Writes `.staged` for all instances |
| `sync-deploy.sh --fresh` | Direct overwrite (clean slate) |
| Container restart (no staged) | No change |
| Container restart (staged exists) | Merge → live, consume staged |

---

## Files Summary

| File | Change |
|------|--------|
| `scripts/sync-deploy.sh` | Write `.staged` instead of overwriting; `--fresh` retains direct overwrite |
| `deploy/openclaw-stack/merge-config.mjs` | **New** — merge algorithm (~60 lines) |
| `deploy/openclaw-stack/entrypoint.sh` | New merge section before envsubst; add `$OPENAI_CODEX_BASE_URL` to whitelist |

---

## Verification

1. **Preserves runtime changes:** Set model default via CLI, sync `--instance`, restart → model default preserved
2. **Propagates $VAR fields:** Change env var in docker-compose, sync `--instance`, restart → new value resolved
3. **New template fields added:** Add field to openclaw.jsonc, rebuild, sync, restart → field appears
4. **Fresh overwrite:** `sync-deploy.sh --fresh` → config matches template exactly
5. **No staged = no-op:** Restart without sync → existing behavior unchanged
6. **First deploy:** No live config → staged becomes live directly
