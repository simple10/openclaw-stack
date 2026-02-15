# Plan: Sandbox image lifecycle — auto-rebuild, integrity checks, and update scripts

## Context

Sandbox images persist in `./data/docker` across gateway restarts. The entrypoint only rebuilds when an image is **missing** — there's no mechanism to detect stale configs, outdated apt packages, or tampered images. The existing TODO in `entrypoint-gateway.sh:166` flags the tampering risk. Users need a way to trigger sandbox rebuilds and OpenClaw updates outside of Claude sessions.

**Goals:**

1. Entrypoint auto-rebuilds sandbox-common when `sandbox-toolkit.yaml` changes
2. Entrypoint detects tampered images via digest verification
3. Images tagged with build date — 30-day staleness advisory
4. Two new local scripts: `update-openclaw.sh` and `update-sandboxes.sh`

---

## 1. Image labels for metadata

Embed metadata as Docker image labels during the sandbox-common build. Labels go in the final `docker build` Dockerfile (the custom tool install layer, entrypoint §2 around line 289):

```dockerfile
LABEL openclaw.toolkit-config="<comment-stripped config>"
LABEL openclaw.build-date="2026-02-11T10:30:00Z"
```

- **toolkit-config**: comment-stripped contents of `sandbox-toolkit.yaml` for config change detection
- **build-date**: ISO timestamp for staleness checks

---

## 2. Entrypoint changes (`deploy/entrypoint-gateway.sh`)

### 2a. Config change detection (sandbox-common, §2)

Replace the simple "image missing" check with:

```
1. Image missing                   → full rebuild
2. Image exists, config changed    → docker rmi + full rebuild
3. Image exists, config matches    → skip
```

**Config comparison:** Strip comments from current `sandbox-toolkit.yaml` using `parse-toolkit.mjs --strip`, read the stored config from the image label via `docker image inspect`, compare strings. Rebuild if different.

### 2b. Image integrity verification (§2, after dockerd ready)

Before the build-if-missing checks, for each existing sandbox image:

1. Read image digest (`docker image inspect --format '{{.Id}}'`)
2. Compare against a stored digest file (`/var/lib/docker/openclaw-image-digests.json`)
3. **First boot / after rebuild**: write the digests file
4. **Subsequent boots**: if digest mismatches → log `WARNING: sandbox image may have been tampered with`

Digests file lives in the persistent `/var/lib/docker` bind mount. Warnings are advisory (not auto-rebuild) — legitimate manual changes could cause false positives.

### 2c. Build-date label + staleness log

On startup, if image exists and config hasn't changed, read `openclaw.build-date` label:

- `<= 30 days`: `[entrypoint] Common sandbox image already exists (built 15 days ago)`
- `> 30 days`: `[entrypoint] WARNING: Common sandbox image is 45 days old — run update-sandboxes.sh for security patches`

### 2d. Remove the TODO comment (line 166-167)

Resolved by the integrity verification above.

---

## 3. `parse-toolkit.mjs` update

Add `--strip` flag: outputs comment-stripped, whitespace-normalized config content. Used by the entrypoint for config comparison and embedded in image labels.

```bash
CURRENT_CONFIG=$(node /app/deploy/parse-toolkit.mjs /app/deploy/sandbox-toolkit.yaml --strip)
```

Output: YAML with comment lines and blank lines removed — a canonical form for comparison.

---

## 4. New script: `scripts/update-sandboxes.sh`

Runs from the **local machine** via SSH (same pattern as `ssh-vps.sh`, `openclaw.sh`). Force-rebuilds sandbox images **without gateway downtime** — builds happen inside the running nested Docker.

```
1. Source openclaw-config.env for SSH config
2. SSH to VPS, docker exec into running gateway:
   a. Stop running sandbox containers (agents' sandboxes)
   b. Remove sandbox images (common + base; browser only with --all)
   c. Re-run the entrypoint's build logic inline:
      - Parse sandbox-toolkit.yaml
      - Build rooted intermediate → sandbox-common-setup.sh → tool installs → label
      - Rebuild base sandbox if removed
   d. Save new image digests
   e. Run verification (images exist, USER=1000, key binaries)
3. Report results — no gateway restart needed
```

New sandbox containers launched by agents automatically use the freshly built images. Existing running sandboxes are unaffected until they're pruned/stopped.

**Flags:**

- `--all` — also rebuild browser sandbox
- `--dry-run` — show what would be rebuilt

---

## 5. New script: `scripts/update-openclaw.sh`

Runs from the **local machine** via SSH. Pulls upstream OpenClaw + rebuilds gateway image. Brief downtime during container swap (the new image requires a container recreation).

```
1. Source openclaw-config.env for SSH config
2. SSH to VPS as openclaw user:
   a. cd /home/openclaw/openclaw && git pull  (downloads new upstream code)
   b. Run build-openclaw.sh                   (builds new openclaw:local image)
   c. docker compose up -d                    (recreates container with new image, minimal downtime)
3. Wait for gateway healthy (poll health endpoint)
4. Show openclaw --version
```

Note: `docker compose up -d` detects the new image and recreates the container — no explicit `down` needed. Downtime is the container swap (~5-10s).

---

## 6. Maintenance playbook update (`playbooks/maintenance.md`)

Add "Image Updates" section after Token Rotation:

- **Sandbox images**: `scripts/update-sandboxes.sh` — monthly, or when entrypoint logs staleness warning, or after editing `sandbox-toolkit.yaml` (auto-detected on restart)
- **OpenClaw gateway**: `scripts/update-openclaw.sh` — for upstream version updates

---

## 7. Verification section update (`playbooks/04-vps1-openclaw.md`)

Add image age check to the sandbox verification block: read `openclaw.build-date` label, warn if > 30 days.

---

## 8. Extract sandbox build logic (`deploy/rebuild-sandboxes.sh`)

The entrypoint's sandbox build logic (§2, lines 199-331) is complex. Rather than duplicating it in `update-sandboxes.sh`, extract it into a standalone script that:

- Runs **inside the gateway container** (has access to nested Docker + Node.js)
- Accepts flags: `--force` (remove and rebuild even if exists), `--all` (include browser)
- Handles: base build, common build (with toolkit config + labels), browser build
- Called by: entrypoint (on boot) and `update-sandboxes.sh` (via `docker exec`)

The entrypoint §2 simplifies to:

```bash
/app/deploy/rebuild-sandboxes.sh
```

And `update-sandboxes.sh` runs:

```bash
docker exec openclaw-gateway /app/deploy/rebuild-sandboxes.sh --force
```

This avoids code duplication and ensures both paths use identical build logic.

---

## Files to create/modify

| File | Change |
|------|--------|
| `deploy/entrypoint-gateway.sh` | Config change detection, integrity verification, staleness log, remove TODO, call rebuild-sandboxes.sh |
| `deploy/rebuild-sandboxes.sh` | **New** — extracted sandbox build logic with labels, runs inside container |
| `deploy/parse-toolkit.mjs` | Add `--strip` flag |
| `deploy/docker-compose.override.yml` | Mount `rebuild-sandboxes.sh` into container |
| `scripts/update-sandboxes.sh` | **New** — local script, SSH + docker exec to trigger rebuild |
| `scripts/update-openclaw.sh` | **New** — local script, SSH to pull upstream + rebuild gateway |
| `playbooks/maintenance.md` | Add image update section |
| `playbooks/04-vps1-openclaw.md` | Add age check to verification |

## Verification

1. Change a **comment** in `sandbox-toolkit.yaml` → restart → should NOT rebuild (comments stripped)
2. Change a **package** in `sandbox-toolkit.yaml` → restart → should auto-rebuild sandbox-common
3. Image labels present: `docker inspect` shows `openclaw.toolkit-config` and `openclaw.build-date`
4. Digest file written: `cat /var/lib/docker/openclaw-image-digests.json`
5. `scripts/update-sandboxes.sh` from local → sandbox rebuilt, verification passes
6. `scripts/update-sandboxes.sh --dry-run` → shows plan without executing
7. `scripts/update-openclaw.sh` from local → gateway updated, healthy
8. Staleness warning: image > 30 days → warning in entrypoint logs
