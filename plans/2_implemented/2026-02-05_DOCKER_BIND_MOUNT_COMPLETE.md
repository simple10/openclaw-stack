# Plan: Complete Bind Mount Migration in Playbooks

## Context

The `plans/DOCKER_BIND_MOUNT.md` plan was implemented for the core playbooks (04, 05, 06), but a full scan reveals two remaining files need bind-mount-related fixes.

---

## Changes Required

### 1. `playbooks/networking/caddy.md` — Convert Caddy named volumes to bind mounts

**Lines 140-151** (VPS-1 Step 4) and **Lines 258-269** (VPS-2 Step 4) both have:

```bash
    -v caddy_data:/data \
    -v caddy_config:/config \
```

**Fix:** Since Caddy is run via `docker run` (not compose), and the config/certs already live under `/etc/caddy/`, use bind mounts under `/etc/caddy/data` and `/etc/caddy/config`:

```bash
    -v /etc/caddy/data:/data \
    -v /etc/caddy/config:/config \
```

Also add a `mkdir -p` step before each `docker run` to create these directories. This keeps Caddy data on the host filesystem for easy backup/inspection.

Additionally, the "Switching to Cloudflare Tunnel" section (lines 395-408) should add cleanup of these directories.

### 2. `playbooks/06-backup.md` — Add `promtail-positions/` to backup tar command

**Lines 46-52** (section 6.1): The tar command doesn't include `openclaw/promtail-positions/` despite it being listed in the "What Gets Backed Up" table (line 134).

**Fix:** Add `openclaw/promtail-positions` to the tar command:

```bash
tar -czf "${BACKUP_FILE}" \
    -C /home/openclaw \
    .openclaw/openclaw.json \
    .openclaw/credentials \
    .openclaw/workspace \
    openclaw/.env \
    openclaw/promtail-positions \
    2>/dev/null || true
```

---

## Files to Modify

| File | Change |
|------|--------|
| `playbooks/networking/caddy.md` lines 147-148 | `caddy_data:/data` → `/etc/caddy/data:/data`, `caddy_config:/config` → `/etc/caddy/config:/config` |
| `playbooks/networking/caddy.md` lines 265-266 | Same as above (VPS-2 section) |
| `playbooks/networking/caddy.md` before each docker run | Add `sudo mkdir -p /etc/caddy/data /etc/caddy/config` |
| `playbooks/06-backup.md` lines 46-52 | Add `openclaw/promtail-positions \` to tar command |

---

## No Changes Needed

| File | Reason |
|------|--------|
| `playbooks/05-vps2-observability.md` | Already converted (all 5 services use `./data/<service>` bind mounts) |
| `playbooks/04-vps1-openclaw.md` | Already has `./promtail-positions:/tmp` bind mount |
| `playbooks/networking/cloudflare-tunnel.md` line 191 | `docker volume rm caddy_data caddy_config` is cleanup of old volumes — acceptable |
| `CLAUDE.md` | Rule already documented (lines 42 and 416) |

---

## Verification

After changes:

```bash
# Confirm no named volume references remain (excluding cleanup commands)
grep -rn '_data:\|_config:' playbooks/ | grep -v 'volume rm'
# Should return zero results
```
