# Split Vector into Standalone Docker Compose Project

## Context

Vector (log shipper) is currently defined as a service in `deploy/docker-compose.override.yml` alongside the OpenClaw gateway overrides. This couples their lifecycle — `docker compose down` stops both, and Vector must be managed through the gateway's compose project. Since Vector is completely independent (reads Docker logs via socket, ships over HTTPS to Cloudflare Worker), it should be its own compose project so it can be started/stopped independently and optionally skipped entirely.

## Directory Structure

**Before:**

```
deploy/
├── docker-compose.override.yml   # gateway overrides + Vector service + network
├── vector.yaml                    # Vector config
└── ...

# On VPS:
/home/openclaw/openclaw/
├── .env                           # all env vars (gateway + Vector)
├── vector.yaml                    # Vector config
└── data/vector/                   # Vector checkpoint state
```

**After:**

```
deploy/
├── docker-compose.override.yml   # gateway overrides only + network
├── vector/
│   ├── docker-compose.yml         # Vector service (standalone)
│   └── vector.yaml                # Vector config (moved from deploy/)
└── ...

# On VPS:
/home/openclaw/
├── openclaw/                      # gateway env vars only (LOG_WORKER_* removed)
│   ├── .env
│   └── data/                      # no more vector/ subdir
├── vector/                        # sibling to openclaw repo — truly independent
│   ├── docker-compose.yml
│   ├── vector.yaml
│   ├── .env                       # LOG_WORKER_URL, LOG_WORKER_TOKEN, VPS1_IP
│   └── data/                      # Vector checkpoint state (moved from openclaw/data/vector/)
```

## Changes

### 1. Create `deploy/vector/docker-compose.yml`

New file — standalone Vector compose project:

```yaml
# Vector log shipper — ships Docker container logs to Cloudflare Log Receiver Worker
# Independent of the OpenClaw gateway. Start/stop separately.

services:
  vector:
    image: timberio/vector:0.43.1-alpine
    container_name: vector
    restart: always
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./vector.yaml:/etc/vector/vector.yaml:ro
      - ./data:/var/lib/vector
    environment:
      - LOG_WORKER_URL=${LOG_WORKER_URL}
      - LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
      - VPS1_IP=${VPS1_IP}
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 128M
```

Key differences from current:

- No `networks:` — Vector doesn't need `openclaw-gateway-net`. Default bridge + Docker socket is sufficient.
- Data volume: `./data` (relative to `vector/` dir) instead of `./data/vector`
- Self-contained `.env` for its 3 env vars

### 2. Move `deploy/vector.yaml` → `deploy/vector/vector.yaml`

`git mv deploy/vector.yaml deploy/vector/vector.yaml` — no content changes needed.

### 3. Update `deploy/docker-compose.override.yml`

Remove the entire Vector service block (lines 127-145). Keep the `networks:` section since the gateway still uses `openclaw-gateway-net`.

**Remove:**

```yaml
  vector:
    image: timberio/vector:0.43.1-alpine
    ...entire block...

```

**Also remove** the comment on line 30 (`# vector needs ~128M, system needs ~500M`) — update to just reference gateway+system memory.

### 4. Update `openclaw-config.env.example`

Mark `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` as optional, add note about separate Vector project:

```bash
# === LOG SHIPPING (optional — only needed if deploying Vector) ===
LOG_WORKER_URL=https://log-receiver.<account>.workers.dev/logs
LOG_WORKER_TOKEN=<generated-token>
```

### 5. Update `playbooks/04-vps1-openclaw.md`

**§ 4.7 Vector setup** — Change from writing `vector.yaml` to the gateway project root to setting up the standalone Vector project:

- Create `/home/openclaw/vector/` directory (sibling to the openclaw repo, not inside it)
- Write `vector.yaml` there
- Create `docker-compose.yml` from `deploy/vector/docker-compose.yml`
- Create `.env` with `LOG_WORKER_URL`, `LOG_WORKER_TOKEN`, `VPS1_IP`
- Create `data/` directory
- Start Vector: `cd /home/openclaw/vector && docker compose up -d`

**§ 4.x .env section** — Remove `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` from the gateway `.env` heredoc (they only belong in `vector/.env` now).

**§ Verification** — Update `docker compose ps vector` to `cd vector && docker compose ps`.

**§ Troubleshooting** — Update all `docker compose ... vector` commands to use `cd /home/openclaw/vector && docker compose ...`.

### 6. Update `playbooks/07-verification.md`

**§ 7.2 Vector verification** — Update commands:

- `cd /home/openclaw/vector && docker compose ps` (instead of gateway project)
- `docker logs vector` stays the same (container name unchanged)
- Checkpoint data path: `vector/data/` instead of `data/vector/`

### 7. Update `playbooks/01-workers.md`

Update the "after deploying log worker, update VPS" section — Vector restart command changes to:

```bash
cd /home/openclaw/vector && docker compose up -d
```

### 8. Update `playbooks/maintenance.md`

**§ Log Worker Token rotation** — Step 4 changes from:

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d vector'
```

to:

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
```

### 9. Update `scripts/health-check.sh`

Line 82: Vector is no longer in the gateway compose project. Change the health check to inspect the Vector container directly (container name is still `vector`, so `docker inspect` still works — no change needed for the container check itself). But update any `docker compose` restart suggestions in the script's output to reference the vector project.

### 10. Update `CLAUDE.md`

- Line 9: Keep "Vector (log shipper)" in the VPS-1 component list
- Line 124: Update service management example — note Vector is managed separately:

  ```
  # Vector (separate compose project):
  sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
  ```

### 11. Update `README.md`

- Architecture description: Note Vector is optional/separate
- Directory tree: Move `vector.yaml` under `deploy/vector/`, add `docker-compose.yml`

### 12. Update docs

**`docs/TESTING.md`** — Update Vector verification commands if present.

**`REQUIREMENTS.md`** — Update architecture table and any Vector references.

### 13. Update `notes/`

**`notes/active-issues/sandbox-file-permissions/sandbox-bind-mounts-overview.md`** — No change needed (Vector isn't bind-mounted into sandboxes).

## VPS Deployment

After code changes, deploy to VPS:

1. Create `/home/openclaw/vector/` directory on VPS (sibling to `openclaw/` repo)
2. SCP `deploy/vector/docker-compose.yml` and `deploy/vector/vector.yaml` to `/home/openclaw/vector/`
3. Create `/home/openclaw/vector/.env` with the 3 env vars (read values from current `openclaw/.env`)
4. Move checkpoint data: `mv openclaw/data/vector vector/data`
5. Remove `LOG_WORKER_URL` and `LOG_WORKER_TOKEN` from `openclaw/.env`
6. Update `openclaw/docker-compose.override.yml` (remove Vector service)
7. Recreate gateway: `cd openclaw && docker compose up -d openclaw-gateway` (picks up override change)
8. Start Vector from new project: `cd /home/openclaw/vector && docker compose up -d`
9. Verify both running independently

## Files Modified

| File | Change Type |
|------|------------|
| `deploy/vector/docker-compose.yml` | **New** — standalone Vector compose |
| `deploy/vector.yaml` → `deploy/vector/vector.yaml` | **Move** (git mv) |
| `deploy/docker-compose.override.yml` | Remove Vector service block |
| `openclaw-config.env.example` | Mark LOG_WORKER vars as optional |
| `playbooks/04-vps1-openclaw.md` | Vector setup → separate project |
| `playbooks/07-verification.md` | Vector check commands |
| `playbooks/01-workers.md` | Vector restart command |
| `playbooks/maintenance.md` | Token rotation restart command |
| `scripts/health-check.sh` | Update Vector references |
| `CLAUDE.md` | Service management note |
| `README.md` | Directory tree + architecture note |
| `REQUIREMENTS.md` | Architecture references |
| `docs/TESTING.md` | Vector verification commands |

## Verification

1. `grep -r 'docker compose.*vector' playbooks/ CLAUDE.md` — all should reference `cd .../vector && docker compose` (not the gateway project)
2. On VPS: `cd /home/openclaw/vector && docker compose ps` — Vector running
3. On VPS: gateway compose has no Vector: `cd /home/openclaw/openclaw && docker compose ps` — only gateway listed
4. `docker logs vector` — no errors, logs shipping
5. Stop gateway, verify Vector keeps running: `cd /home/openclaw/openclaw && docker compose stop openclaw-gateway` then `docker inspect -f '{{.State.Status}}' vector` — still running
6. Restart Vector independently: `cd /home/openclaw/vector && docker compose restart` — no effect on gateway
