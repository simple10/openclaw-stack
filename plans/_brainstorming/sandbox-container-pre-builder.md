# Plan: Sandbox Pre-Builder Container

## Context

Fresh deploys take ~45 min because sandbox image building (~15 min) runs serially inside the gateway container's entrypoint, starting ~25 min into the deploy. By running sandbox builds in a separate Sysbox container immediately after config deployment (t=17), overlapping with the openclaw image build (t=18-25), total deploy time drops to ~32 min.

The existing `rebuild-sandboxes.sh` already handles pre-built images gracefully — `image_exists()` checks skip builds, and `seed_agent_homes()` auto-skips when `/home/node/sandboxes-home` doesn't exist. No modifications to existing scripts needed.

## New Timeline

```
t=0    01-workers + 02-base-setup (parallel)        [unchanged]
t=10   03-docker install                             [unchanged]
t=13   04.1 sysbox install                           [unchanged]
t=15   04.2 SCP + setup-infra.sh                     [unchanged]
t=17   04.3 deploy-config.sh                         [unchanged]
t=18   Build sandbox-prebuilder image (~1 min)        NEW
t=19   Start sandbox-prebuilder (background, ~15 min) NEW
t=19   [parallel] build-openclaw.sh (~7 min)          MOVED EARLIER
t=26   openclaw:local ready
t=34   sandbox-prebuilder finishes
t=34   docker compose up -d                           MOVED LATER (waits for builder)
t=35   gateway ready (sandbox builds skipped)          WAS t=45
```

## Changes

### 1. New file: `deploy/sandbox-prebuilder.sh`

Wrapper script that runs inside the builder container. Starts dockerd, runs `rebuild-sandboxes.sh`, cleanly stops dockerd.

```bash
#!/bin/bash
set -euo pipefail

# Start nested dockerd (Sysbox provides isolation)
dockerd --host=unix:///var/run/docker.sock \
        --storage-driver=overlay2 \
        --log-level=warn \
        > /var/log/dockerd.log 2>&1 &

# Wait for ready
timeout=30; elapsed=0
while ! docker info > /dev/null 2>&1; do
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "[sandbox-prebuilder] ERROR: Docker daemon not ready after ${timeout}s" >&2
    cat /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 1; elapsed=$((elapsed + 1))
done
echo "[sandbox-prebuilder] Docker daemon ready (took ${elapsed}s)"

# Build all sandbox images
# seed_agent_homes() auto-skips: /home/node/sandboxes-home not mounted
/app/deploy/rebuild-sandboxes.sh
BUILD_EXIT=$?

# Clean shutdown — critical for /var/lib/docker integrity
echo "[sandbox-prebuilder] Stopping Docker daemon..."
if [ -f /var/run/docker.pid ]; then
  kill "$(cat /var/run/docker.pid)" 2>/dev/null || true
  timeout 30 bash -c 'while [ -f /var/run/docker.pid ]; do sleep 1; done' 2>/dev/null || true
fi

echo "[sandbox-prebuilder] Done (exit code: $BUILD_EXIT)"
exit $BUILD_EXIT
```

### 2. Modify: `deploy/scripts/deploy-config.sh`

Add copy of `sandbox-prebuilder.sh` alongside the other deploy/ files in section 10 (after line 232).

```bash
sudo -u openclaw cp "${STAGING}/sandbox-prebuilder.sh" /home/openclaw/openclaw/deploy/sandbox-prebuilder.sh
sudo chmod +x /home/openclaw/openclaw/deploy/sandbox-prebuilder.sh
```

Update the echo on line 235 to include the new file:

```
echo "Deployed sandbox toolkit, rebuild script, prebuilder, and dashboard." >&2
```

### 3. Modify: `playbooks/04-vps1-openclaw.md` section 4.3

Add `sandbox-prebuilder.sh` to the file manifest table:

```
| `deploy/sandbox-prebuilder.sh` | `/home/openclaw/openclaw/deploy/` | static | Sandbox pre-build wrapper |
```

### 4. Modify: `playbooks/04-vps1-openclaw.md` section 4.4

Replace the current serial flow (build image → start gateway → wait for sandbox builds) with a parallel flow. The new section 4.4 structure:

**Step 1: Build sandbox-prebuilder image + start pre-build (background)**

Build a minimal image with Node.js + Docker, then launch the prebuilder:

```bash
#!/bin/bash
# Build lightweight prebuilder image (~1 min)
printf 'FROM node:24-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*\n' \
  | sudo docker build -t sandbox-prebuilder -

# Start sandbox pre-build (background) — writes images to data/docker
sudo docker run --rm --runtime sysbox-runc \
  --name sandbox-prebuilder \
  -v /home/openclaw/openclaw:/app:ro \
  -v /home/openclaw/openclaw/data/docker:/var/lib/docker \
  sandbox-prebuilder \
  bash /app/deploy/sandbox-prebuilder.sh
```

The `docker run` should be launched in background (via `run_in_background: true` in the playbook automation). The prebuilder container:

- Mounts the cloned repo at `/app:ro` (upstream Dockerfiles + scripts + our deploy/ files)
- Mounts `data/docker` at `/var/lib/docker` (shared image store with gateway)
- Does NOT mount `sandboxes-home` → `seed_agent_homes()` auto-skips
- Runs with `sysbox-runc` for nested Docker isolation

**Step 2: Build openclaw:local image (parallel with pre-build)**

```bash
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
```

This runs in parallel with the prebuilder. No conflicts — host Docker builds `openclaw:local` using host's `/var/lib/docker`, while the prebuilder's nested Docker uses `data/docker`.

**Step 3: Wait for prebuilder to finish**

Poll prebuilder logs for progress:

```bash
sudo docker logs sandbox-prebuilder 2>&1 | grep '\[sandbox-builder\]' | tail -1
```

Wait for the container to exit:

```bash
# Container exits when builds complete (--rm auto-removes it)
sudo docker wait sandbox-prebuilder 2>/dev/null || true
```

**Step 4: Start gateway + verify**

```bash
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
```

The gateway's entrypoint runs `rebuild-sandboxes.sh` which finds all images pre-built → logs "already exists" for each → skips to `seed_agent_homes()` → drops to node in ~30s instead of ~15 min.

**Step 5: Cleanup prebuilder image**

```bash
sudo docker rmi sandbox-prebuilder 2>/dev/null || true
```

Optionally remove the `node:24-bookworm-slim` base image too, but it's small (~200MB) and may be useful.

**Fallback:** If the prebuilder fails or is skipped, the gateway's entrypoint builds sandboxes normally (existing behavior, unchanged). The `start_period: 300s` healthcheck is kept for this case.

### 5. Modify: `playbooks/04-vps1-openclaw.md` section 4.4 "Wait for full startup"

Update the wait instructions. The current 15-min wait with progress polling is replaced with a much shorter wait (~30s) for the gateway to start. Keep the existing polling pattern as fallback documentation in case the prebuilder was skipped.

### 6. Modify: `playbooks/00-fresh-deploy-setup.md` section 0.7

Update the deployment plan presented to the user:

```
3. OpenClaw deployment (04-vps1-openclaw.md)
   - Sysbox + infra + config
   - Sandbox pre-build + image build (parallel)         UPDATED
   - Gateway start (sandbox images pre-built)            UPDATED
```

Update the context window management table — the sandbox build wait is no longer a 15-min background task in main context. The prebuilder runs inside the 4.4 subagent.

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `deploy/sandbox-prebuilder.sh` | **Create** | Wrapper: start dockerd, run rebuild-sandboxes.sh, stop dockerd |
| `deploy/scripts/deploy-config.sh` | Edit (line ~232) | Add copy of sandbox-prebuilder.sh to VPS |
| `playbooks/04-vps1-openclaw.md` | Edit (§4.3 manifest, §4.4 flow) | Add file to manifest, rewrite build+start as parallel flow |
| `playbooks/00-fresh-deploy-setup.md` | Edit (§0.7) | Update timeline and context management table |

## What stays unchanged

- `deploy/rebuild-sandboxes.sh` — no modifications; `image_exists()` checks and `seed_agent_homes()` auto-skip already handle the pre-built case
- `deploy/entrypoint-gateway.sh` — no modifications; calls `rebuild-sandboxes.sh` which auto-skips
- `deploy/docker-compose.override.yml` — no modifications; same `data/docker:/var/lib/docker` bind mount

## Verification

1. **Unit test the prebuilder script locally** (requires Sysbox on a test VPS):
   - Run the prebuilder container manually
   - Verify all 4 sandbox images are built in `data/docker`
   - Verify dockerd shuts down cleanly (no stale pid/lock files)
   - Start the gateway container and verify `rebuild-sandboxes.sh` logs "already exists" for all images

2. **Full deploy test:**
   - Run a fresh deploy end-to-end
   - Verify prebuilder and `build-openclaw.sh` run in parallel
   - Verify gateway starts with pre-built images (~30s, not ~15 min)
   - Verify sandbox functionality: create a session, confirm sandbox container spawns correctly

3. **Fallback test:**
   - Delete `data/docker` contents, start gateway without prebuilder
   - Verify entrypoint builds sandboxes normally (existing behavior)
