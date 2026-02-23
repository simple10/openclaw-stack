# Fix deploy/ bind mounts and deployment gaps

## Context

During fresh deployment, 4 files/directories under `deploy/` were bind-mounted individually in `docker-compose.override.yml` but never copied to the VPS by `deploy-config.sh`. Docker created empty directories as mount targets, causing: sandbox builds to use a stale fallback package list (which includes `npm` — broken in Debian bookworm with NodeSource), no dashboard server, and entrypoint warnings about missing toolkit config.

## Changes

### 1. Simplify bind mounts — `deploy/docker-compose.override.yml`

Replace 5 individual `./deploy/*` bind mounts with one directory mount:

```yaml
# Before (lines 50-59): 5 separate mounts + comments
- ./deploy/plugins:/app/deploy/plugins:ro
- ./deploy/sandbox-toolkit.yaml:/app/deploy/sandbox-toolkit.yaml:ro
- ./deploy/parse-toolkit.mjs:/app/deploy/parse-toolkit.mjs:ro
- ./deploy/rebuild-sandboxes.sh:/app/deploy/rebuild-sandboxes.sh:ro
- ./deploy/dashboard:/app/deploy/dashboard:ro

# After: single directory mount
- ./deploy:/app/deploy:ro
```

Keep all other volume mounts unchanged (entrypoint, sandboxes-home, data/docker).

### 2. Add missing file copies — `deploy/scripts/deploy-config.sh`

After the plugins section (section 9, line 240), add a new section that copies:

- `sandbox-toolkit.yaml` → `/home/openclaw/openclaw/deploy/`
- `parse-toolkit.mjs` → `/home/openclaw/openclaw/deploy/`
- `rebuild-sandboxes.sh` → `/home/openclaw/openclaw/deploy/` (with +x)
- `dashboard/` → `/home/openclaw/openclaw/deploy/dashboard/`

Ownership: `openclaw:openclaw` (these are read-only in container via bind mount; the container's node user reads them fine since they're world-readable).

### 3. Update file manifest — `playbooks/04-vps1-openclaw.md`

Add 4 rows to the manifest table (after plugins row, line 181):

| Source | Destination | Type | Notes |
|--------|------------|------|-------|
| `deploy/sandbox-toolkit.yaml` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/parse-toolkit.mjs` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/rebuild-sandboxes.sh` | `/home/openclaw/openclaw/deploy/` | static | Bind-mounted into container |
| `deploy/dashboard/*` | `/home/openclaw/openclaw/deploy/dashboard/` | static | Bind-mounted into container |

### 4. Fix fallback package list — `deploy/rebuild-sandboxes.sh`

Line 341: Remove `npm` from the fallback package list. With NodeSource 24.x, `npm` is bundled with the `nodejs` package — installing it separately from Debian repos causes broken dependency errors. The fallback should only trigger if toolkit YAML is missing, but removing `npm` prevents a hard failure if it ever does.

## Files to modify

1. `deploy/docker-compose.override.yml` — simplify volumes
2. `deploy/scripts/deploy-config.sh` — add 4 file copies
3. `playbooks/04-vps1-openclaw.md` — update manifest table
4. `deploy/rebuild-sandboxes.sh` — remove `npm` from fallback

## Verification

After changes, grep to confirm:

- No individual `./deploy/` file mounts remain in docker-compose.override.yml (only `./deploy:/app/deploy:ro`)
- `deploy-config.sh` references sandbox-toolkit.yaml, parse-toolkit.mjs, rebuild-sandboxes.sh, dashboard
- Fallback package list in rebuild-sandboxes.sh no longer contains `npm`
- Playbook manifest table has 15 rows (was 11)
