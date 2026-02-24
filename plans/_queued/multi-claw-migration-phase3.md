# Always Multi-Claw Architecture (Phase 3: Docs, Playbooks & Telemetry)

## Context

Phase 1 established the always-multi-claw architecture. Phase 2 updated all scripts and CLI code to dynamically resolve container names. Container names are now `openclaw-<dirname>` (e.g., `openclaw-main-claw`), not `openclaw-gateway`.

**Problem:** 56 container-name references to `openclaw-gateway` remain across playbooks, docs, and one runtime plugin. These cause confusion during deployments (copy-pasting commands that reference a non-existent container) and make the telemetry service name inaccurate.

**This phase updates all active documentation and fixes the one remaining runtime code reference.** Historical plans (`plans/2_implemented/`) are NOT touched — they document what was true at the time.

---

## Scope

| Category | Files | Container Refs | Action |
|----------|-------|---------------|--------|
| Active playbooks | 4 | 41 | UPDATE |
| Active docs | 6 | 12 | UPDATE |
| Deploy code (telemetry plugin) | 1 | 1 | UPDATE (runtime fix) |
| Deploy code (coordinator README) | 1 | 1 | UPDATE |
| Implemented plans | 36 | 123 | DO NOT TOUCH |
| Consideration/abandoned plans | 9 | 33 | DO NOT TOUCH |
| Notes | 6 | 13 | DO NOT TOUCH |
| Network name (`openclaw-gateway-net`) | cross-cutting | 19 | DO NOT TOUCH |

**Total work: 12 files, ~55 replacements.**

---

## Key Design Decisions

**Container name in commands** — Replace `openclaw-gateway` with `openclaw-main-claw` in all commands. This is the default claw name. Multi-claw users know to substitute their claw name.

**`docker compose restart openclaw-gateway`** → `docker compose restart openclaw-main-claw` or just `docker compose restart` (restarts all services). Prefer the latter where the command isn't targeting a specific service.

**The `openclaw` CLI wrapper on the VPS host** already handles multi-claw resolution (Phase 1). Commands like `openclaw health` work without specifying a container. Prefer showing the `openclaw` wrapper where possible, falling back to `docker exec openclaw-main-claw` only when necessary.

**`openclaw-gateway-net`** is the Docker network name — it stays as-is. It's infrastructure, not tied to any single container.

**Telemetry `serviceName`** — Change from hardcoded `'openclaw-gateway'` to using the container hostname (`os.hostname()`), which Docker sets to the container name. This gives each claw its own identity in telemetry (e.g., `openclaw-main-claw`, `openclaw-test-claw`).

---

## Implementation

### 1. Fix runtime code: `deploy/plugins/telemetry/index.js`

This is the only runtime code change — all others are documentation.

```javascript
// Line 169 — replace hardcoded serviceName:
// Before:
serviceName: 'openclaw-gateway',
// After:
serviceName: hostname || 'openclaw',
```

The `hostname` parameter already exists and is passed through from config. Docker sets the container hostname to the container name (e.g., `openclaw-main-claw`), so this gives accurate per-claw telemetry identity with no config changes needed.

Also update the event sender's similar pattern if applicable.

### 2. Update `CLAUDE.md`

**Line 40** — Update the docker exec example:
```
# Before:
sudo docker exec --user node openclaw-gateway openclaw <subcommand>
# After:
sudo docker exec --user node openclaw-main-claw openclaw <subcommand>
```

### 3. Update `README.md`

**Line 203** — ASCII architecture diagram:
```
# Before:
|  +-- openclaw-gateway (Sysbox) ----------+   |
# After:
|  +-- openclaw-main-claw (Sysbox) --------+   |
```

**Line 339** — Docker compose command:
```
# Before:
docker compose restart openclaw-gateway
# After:
docker compose restart openclaw-main-claw
```

### 4. Update `docs/DASHBOARD.md`

7 references — all `docker exec openclaw-gateway` commands. Replace with `docker exec openclaw-main-claw`.

### 5. Update `docs/TESTING.md`

**Line 192** — `docker compose logs --tail 50 openclaw-gateway` → `openclaw-main-claw`

### 6. Update `docs/SANDBOX-TOOLKIT.md`

**Line 206** — `docker exec openclaw-gateway docker run...` → `openclaw-main-claw`

### 7. Update `playbooks/maintenance.md` (3 refs)

**Lines 35, 53** — `docker compose up -d openclaw-gateway` → `docker compose up -d`
**Line 163** — `docker compose restart openclaw-gateway` → `docker compose restart openclaw-main-claw`

### 8. Update `playbooks/04-vps1-openclaw.md` (17 container refs)

This is the largest file. All `openclaw-gateway` container references → `openclaw-main-claw`. The 2 network name references (`openclaw-gateway-net`, lines 653-654) stay as-is.

Pattern replacements:
- `sudo docker logs openclaw-gateway` → `sudo docker logs openclaw-main-claw`
- `sudo docker exec openclaw-gateway` → `sudo docker exec openclaw-main-claw`
- `sudo docker inspect ... openclaw-gateway` → `... openclaw-main-claw`
- `docker compose up -d openclaw-gateway` → `docker compose up -d`
- `grep openclaw-gateway` → `grep openclaw-main-claw`

### 9. Update `playbooks/07-verification.md` (13 refs)

Same pattern as above. All `openclaw-gateway` → `openclaw-main-claw`.

### 10. Update `playbooks/08-post-deploy.md` (8 refs)

Same pattern. Additionally:
- `grep openclaw-gateway` → `grep openclaw-main-claw`
- `docker compose restart openclaw-gateway` → `docker compose restart openclaw-main-claw`

### 11. Update `deploy/plugins/coordinator/README.md` (1 ref)

**Line 87** — `docker exec openclaw-gateway sh -c '...'` → `openclaw-main-claw`

---

## Files to Modify

| File | Action | Refs |
|------|--------|------|
| `deploy/plugins/telemetry/index.js` | **MODIFY** | 1 (runtime fix) |
| `CLAUDE.md` | **MODIFY** | 1 |
| `README.md` | **MODIFY** | 2 |
| `docs/DASHBOARD.md` | **MODIFY** | 7 |
| `docs/TESTING.md` | **MODIFY** | 1 |
| `docs/SANDBOX-TOOLKIT.md` | **MODIFY** | 1 |
| `playbooks/maintenance.md` | **MODIFY** | 3 |
| `playbooks/04-vps1-openclaw.md` | **MODIFY** | 17 |
| `playbooks/07-verification.md` | **MODIFY** | 13 |
| `playbooks/08-post-deploy.md` | **MODIFY** | 8 |
| `deploy/plugins/coordinator/README.md` | **MODIFY** | 1 |

**NOT changing:**
- `plans/2_implemented/*` — historical records
- `plans/3_consideration/*`, `plans/4_abandoned/*`, `plans/_brainstorming/*` — inactive plans
- `notes/*` — historical notes
- Any `openclaw-gateway-net` references (Docker network name, unchanged)
- `deploy/scripts/openclaw-multi.sh` — the `openclaw-gateway:` service definition intentionally disables the upstream compose service name
- `deploy/scripts/setup-infra.sh` — only has network name reference
- `REQUIREMENTS.md` — only has network name reference

---

## Verification

1. `grep -r 'openclaw-gateway' playbooks/ docs/ CLAUDE.md README.md deploy/plugins/` returns only:
   - Network name references (`openclaw-gateway-net`)
   - No container name references
2. Telemetry plugin uses dynamic hostname
3. All playbook commands reference `openclaw-main-claw` (or use `openclaw` CLI wrapper)
