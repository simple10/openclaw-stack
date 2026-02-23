# Plan: Move gateway resource limits to openclaw-config.env

## Context

Gateway CPU/memory limits are hardcoded in `deploy/docker-compose.override.yml`. Different VPS deployments have different hardware, so these values change per-deploy and cause git conflicts. Move them to `openclaw-config.env` (gitignored, per-deploy) and use Docker Compose's native env var interpolation.

## Changes

### 1. `deploy/docker-compose.override.yml` — use env vars with defaults

Replace hardcoded limits with interpolated vars:

```yaml
cpus: "${GATEWAY_CPUS:-6}"
memory: ${GATEWAY_MEMORY:-10.5G}
```

Defaults (6 CPUs, 10.5G) are conservative and safe for small VPSes. Reservations stay hardcoded (scheduling minimums, rarely need changing).

### 2. `openclaw-config.env.example` — add new vars

Add `GATEWAY_CPUS` and `GATEWAY_MEMORY` in a new section near the top (after SSH, before domain config). Include comments explaining the auto-detection in step 0.4.

### 3. `openclaw-config.env` — add current values

Add `GATEWAY_CPUS=12` and `GATEWAY_MEMORY=45G` (current VPS values).

### 4. `deploy/scripts/setup-infra.sh` — write to VPS .env

Add `GATEWAY_CPUS` and `GATEWAY_MEMORY` to the `.env` file generation block so Docker Compose can read them at runtime.

### 5. `playbooks/00-fresh-deploy-setup.md` § 0.4 — write to config, not compose file

Update the "Action" section: instead of editing `docker-compose.override.yml`, write recommended values to `openclaw-config.env`. The compose file no longer needs per-deploy edits.

### 6. `playbooks/04-vps1-openclaw.md` § 4.2 — pass new vars via SSH

Add `GATEWAY_CPUS` and `GATEWAY_MEMORY` to the `env` block in the setup-infra.sh SSH invocation.

### 7. `playbooks/07-verification.md` § 7.5c — update verification

Resource limit check should compare against env vars (from config), not hardcoded compose values.

## Files modified

| File | Change |
|------|--------|
| `deploy/docker-compose.override.yml` | Replace hardcoded cpus/memory with `${VAR:-default}` |
| `openclaw-config.env.example` | Add GATEWAY_CPUS, GATEWAY_MEMORY vars |
| `openclaw-config.env` | Add current values (12, 45G) |
| `deploy/scripts/setup-infra.sh` | Write vars to VPS .env |
| `playbooks/00-fresh-deploy-setup.md` | § 0.4: write to config instead of compose file |
| `playbooks/04-vps1-openclaw.md` | § 4.2: add vars to SSH env pass-through |
| `playbooks/07-verification.md` | § 7.5c: check env vars not hardcoded values |

## Verification

1. `docker compose config` locally with env vars set — confirm limits resolve correctly
2. `docker compose config` locally without env vars — confirm defaults apply (6 CPUs, 10.5G)
3. Grep for hardcoded CPU/memory values in compose file — should find only defaults in `${:-}` syntax
