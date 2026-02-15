# Plan: Install Docker Inside Gateway Container for Sandbox & Browser

## Context

The OpenClaw gateway runs in a Docker container with `runtime: sysbox-runc`. Sysbox provides the *capability* for Docker-in-Docker (user namespace isolation, /proc+/sys virtualization) but does NOT provide Docker itself. The container image currently lacks `docker`, `dockerd`, and `containerd` binaries.

**Result:** The gateway runs in "direct mode" — no sandbox isolation, no browser tool. With `sandbox.mode: "all"`, every incoming message triggers `spawn("docker", ...)` → EACCES → crash. We reverted to `"non-main"` as a workaround.

**Goal:** Install Docker inside the gateway image so the nested Docker daemon works, enabling sandboxed code execution and the Chromium browser tool.

## Root Cause Analysis

Three compose settings block Docker-in-Docker:

| Setting | Current Value | Problem |
|---------|--------------|---------|
| `user` | `"1000:1000"` | dockerd needs root (uid 0) to start |
| `read_only` | `true` | Sysbox auto-mounts `/var/lib/docker` and `/var/lib/containerd`, but other paths (e.g., `/var/log`) may need writes |
| Missing packages | — | No `docker`, `dockerd`, `containerd` binaries in image |

## Approach

1. Install `docker.io` + `gosu` in the gateway image via build script patch
2. Change compose to `user: "0:0"` so entrypoint runs as root
3. Entrypoint: start dockerd → wait → build sandbox images → `exec gosu node "$@"` to drop privileges
4. Keep `read_only: true` with additional tmpfs for `/var/log` (Sysbox auto-mounts Docker data dirs)
5. Change `sandbox.mode` to `"all"` in `openclaw.json`

---

## Files to Modify

### 1. `scripts/build-openclaw.sh` — New patch #5

Add between current patch #4 (Claude Code CLI) and the build step:

```bash
# ── 5. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  # Insert before USER node so it runs as root
  # docker.io includes: docker CLI, dockerd, containerd, runc
  # gosu: drop-in replacement for su/sudo that doesn't spawn subshell (proper PID 1 signal handling)
  # usermod: add node user to docker group for socket access after privilege drop
  sed -i '/^USER /i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu && \
    usermod -aG docker node && \
    rm -rf /var/lib/apt/lists/*' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
fi
```

Renumber: build → #6, restore → #7. Add `Dockerfile` to the restore list (already there).

### 2. `playbooks/04-vps1-openclaw.md` — Section 4.6 (docker-compose.override.yml)

Three changes to the gateway service:

**a) Change user from `"1000:1000"` to `"0:0"`:**

```yaml
    # Run as root inside container so entrypoint can start dockerd
    # Sysbox maps root (uid 0) to unprivileged user on host
    # Entrypoint drops to node user via gosu before starting gateway
    user: "0:0"
```

**b) Add `/var/log` tmpfs** (dockerd writes logs there):

```yaml
    tmpfs:
      - /tmp:size=1G,mode=1777
      - /var/tmp:size=200M,mode=1777
      - /run:size=100M,mode=755
      - /var/log:size=100M,mode=755
```

**c) Keep `read_only: true`** — Sysbox auto-provisions writable mounts for `/var/lib/docker` and `/var/lib/containerd` at `/var/lib/sysbox/docker/<container-id>/` on the host.

### 3. `playbooks/04-vps1-openclaw.md` — Section 4.8c (entrypoint)

Replace the entrypoint with this updated version:

```bash
#!/bin/bash
set -euo pipefail

# ── 1a. Clean stale lock files ──────────────────────────────────────
lock_dir="/home/node/.openclaw"
if compgen -G "${lock_dir}/gateway.*.lock" > /dev/null 2>&1; then
  echo "[entrypoint] Removing stale lock files:"
  ls -la "${lock_dir}"/gateway.*.lock
  rm -f "${lock_dir}"/gateway.*.lock
  echo "[entrypoint] Lock files cleaned"
else
  echo "[entrypoint] No stale lock files found"
fi

# ── 1b. Fix openclaw.json permissions (security audit CRITICAL) ─────
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$config_file" ]; then
  current_perms=$(stat -c '%a' "$config_file" 2>/dev/null || stat -f '%Lp' "$config_file" 2>/dev/null)
  if [ "$current_perms" != "600" ]; then
    chmod 600 "$config_file"
    echo "[entrypoint] Fixed openclaw.json permissions: ${current_perms} -> 600"
  fi
fi

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# Sysbox auto-provisions /var/lib/docker and /var/lib/containerd as
# writable mounts. We just need to start dockerd.
if command -v dockerd > /dev/null 2>&1; then
  if ! docker info > /dev/null 2>&1; then
    echo "[entrypoint] Starting nested Docker daemon..."
    dockerd --host=unix:///var/run/docker.sock \
            --storage-driver=overlay2 \
            --log-level=warn \
            --group="$(getent group docker | cut -d: -f3)" \
            > /var/log/dockerd.log 2>&1 &

    # Wait for Docker daemon to be ready
    echo "[entrypoint] Waiting for nested Docker daemon..."
    timeout=30
    elapsed=0
    while ! docker info > /dev/null 2>&1; do
      if [ "$elapsed" -ge "$timeout" ]; then
        echo "[entrypoint] WARNING: Docker daemon not ready after ${timeout}s"
        echo "[entrypoint] dockerd log:"
        tail -20 /var/log/dockerd.log 2>/dev/null || true
        break
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
  fi

  if docker info > /dev/null 2>&1; then
    echo "[entrypoint] Nested Docker daemon ready (took ${elapsed:-0}s)"

    # Build sandbox images if missing
    if ! docker image inspect openclaw-sandbox > /dev/null 2>&1; then
      echo "[entrypoint] Sandbox image not found, building..."
      if [ -f /app/sandbox/Dockerfile ]; then
        docker build -t openclaw-sandbox /app/sandbox/
        echo "[entrypoint] Sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: /app/sandbox/Dockerfile not found"
      fi
    else
      echo "[entrypoint] Sandbox image already exists"
    fi

    if ! docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
      echo "[entrypoint] Common sandbox image not found, building..."
      if [ -f /app/scripts/sandbox-common-setup.sh ]; then
        /app/scripts/sandbox-common-setup.sh
        echo "[entrypoint] Common sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: sandbox-common-setup.sh not found"
      fi
    else
      echo "[entrypoint] Common sandbox image already exists"
    fi

    if ! docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
      echo "[entrypoint] Browser sandbox image not found, building..."
      if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
        /app/scripts/sandbox-browser-setup.sh
        echo "[entrypoint] Browser sandbox image built successfully"
      else
        echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found"
      fi
    else
      echo "[entrypoint] Browser sandbox image already exists"
    fi
  fi
else
  echo "[entrypoint] Docker not installed, skipping sandbox bootstrap"
fi

# ── 3. Drop privileges and exec gateway ─────────────────────────────
# gosu drops from root to node user without spawning a subshell,
# preserving PID structure for proper signal handling via tini
echo "[entrypoint] Executing as node: $*"
exec gosu node "$@"
```

Key differences from current entrypoint:

- **Starts dockerd** before the wait loop (line ~20)
- **`--group` flag** sets Docker socket group to `docker` group, which node user belongs to
- **`exec gosu node "$@"`** instead of `exec "$@"` — drops from root to node user
- **Logs dockerd output** to `/var/log/dockerd.log` (on tmpfs) for debugging
- **`command -v dockerd` guard** — entrypoint still works if Docker isn't installed (graceful fallback)

### 4. `playbooks/04-vps1-openclaw.md` — Section 4.8 (openclaw.json)

Change `sandbox.mode` from `"non-main"` to `"all"` in both Cloudflare Tunnel and Caddy variants:

```json
"mode": "all"
```

This means all agents (including main) run in sandboxes. With Docker now available, `spawn("docker", ...)` succeeds instead of crashing.

### 5. `playbooks/04-vps1-openclaw.md` — Section 4.8a (build script reference)

Update the embedded build script to include patch #5 and renumbered sections.

### 6. `playbooks/extras/sandbox-and-browser.md`
