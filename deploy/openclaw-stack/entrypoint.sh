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

# ── 1c. Fix .openclaw dir ownership (Sysbox uid remapping) ──────────
# Gateway config/state dir: bind mount arrives with host uid which Sysbox remaps.
# Some files (identity/, memory/) may be created by root before gosu drops privs.
# Chown to node (1000) so gateway process can read/write after privilege drop.
openclaw_dir="/home/node/.openclaw"
if [ -d "$openclaw_dir" ]; then
  root_files=$(find "$openclaw_dir" -not -user 1000 2>/dev/null | head -1)
  if [ -n "$root_files" ]; then
    chown -R 1000:1000 "$openclaw_dir"
    echo "[entrypoint] Fixed .openclaw ownership to node (1000)"
  fi
fi

# ── 1d. Configure npm global prefix for skill installs ─────────────
# Gateway runs as node (uid 1000) after gosu drops privileges.
# npm install -g (used by skills.install) needs a writable global prefix.
# Default /usr/local/lib/node_modules is owned by root — redirect to user dir.
npm_global="/home/node/.npm-global"
mkdir -p "$npm_global"
chown 1000:1000 "$npm_global"
echo "prefix=$npm_global" > /home/node/.npmrc
# Add to PATH so globally installed binaries are found.
# Also include /app/node_modules/.bin — the update engine runs pnpm install after
# checking out new versions, and some git-hosted deps need build tools (vite, tsdown)
# that are installed in the project's node_modules but not available in pnpm's temp dirs.
export PATH="$npm_global/bin:/app/node_modules/.bin:$PATH"
echo "[entrypoint] npm global prefix set to $npm_global"

# ── 1g. Auto-generate gateway shims from sandbox-toolkit.yaml ──────
# Shims satisfy the gateway's load-time skill binary preflight checks.
# Real binaries live in sandbox images — shims are gateway-only (not bind-mounted).
SKILL_BINS="/opt/skill-bins"
mkdir -p "$SKILL_BINS"

TOOLKIT_CONFIG="/app/openclaw-stack/sandbox-toolkit.yaml"
TOOLKIT_PARSER="/app/openclaw-stack/parse-toolkit.mjs"

if [ -f "$TOOLKIT_CONFIG" ] && [ -f "$TOOLKIT_PARSER" ]; then
  TOOLKIT_JSON=$(node "$TOOLKIT_PARSER" "$TOOLKIT_CONFIG")

  for bin in $(echo "$TOOLKIT_JSON" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).allBins.join(' ')))"); do
    if [ ! -f "$SKILL_BINS/$bin" ]; then
      cat > "$SKILL_BINS/$bin" << 'SHIM'
#!/bin/sh
# Gateway shim — satisfies preflight check. Real binary is in sandbox image.
echo "ERROR: $(basename "$0") is a gateway shim — run inside sandbox" >&2
exit 1
SHIM
      chmod +x "$SKILL_BINS/$bin"
    fi
  done
  # Symlink shims into /usr/local/bin so they're on the default PATH
  # for all contexts — gateway process, docker exec sessions, openclaw doctor.
  for shim in "$SKILL_BINS"/*; do
    bin_name=$(basename "$shim")
    [ ! -L "/usr/local/bin/$bin_name" ] && ln -sf "$shim" "/usr/local/bin/$bin_name"
  done
  echo "[entrypoint] Auto-shimmed $(ls "$SKILL_BINS" | wc -l) binaries from sandbox-toolkit.yaml"
else
  echo "[entrypoint] WARNING: sandbox-toolkit.yaml or parser not found, skipping shim generation"
fi

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# /var/lib/docker is a persistent bind mount from host (./data/docker),
# so sandbox images survive container restarts (no ~5min rebuild).
# rebuild-sandboxes.sh handles: config change detection (auto-rebuild when
# sandbox-toolkit.yaml changes), integrity verification (digest comparison),
# and staleness warnings (>30 days).

# Compute sandbox registry URL (used by dockerd --insecure-registry and rebuild-sandboxes.sh)
REGISTRY_URL=""
if [ -n "${SANDBOX_REGISTRY_URL:-}" ]; then
  REGISTRY_URL="$SANDBOX_REGISTRY_URL"
elif [ -n "${SANDBOX_REGISTRY_PORT:-}" ]; then
  # ip may not be installed; fall back to /proc/net/route (|| true for pipefail)
  HOST_GW=$(ip route 2>/dev/null | awk '/default/ {print $3}' || true)
  if [ -z "$HOST_GW" ] && [ -f /proc/net/route ]; then
    HOST_GW=$(awk '$2 == "00000000" {h=$3; printf "%d.%d.%d.%d", "0x"substr(h,7,2), "0x"substr(h,5,2), "0x"substr(h,3,2), "0x"substr(h,1,2); exit}' /proc/net/route)
  fi
  REGISTRY_URL="${HOST_GW}:${SANDBOX_REGISTRY_PORT}"
fi

if command -v dockerd > /dev/null 2>&1; then
  if ! docker info > /dev/null 2>&1; then
    echo "[entrypoint] Starting nested Docker daemon..."
    DOCKERD_ARGS="--host=unix:///var/run/docker.sock --storage-driver=overlay2 --log-level=warn"
    DOCKERD_ARGS="$DOCKERD_ARGS --group=$(getent group docker | cut -d: -f3)"
    if [ -n "$REGISTRY_URL" ]; then
      DOCKERD_ARGS="$DOCKERD_ARGS --insecure-registry=$REGISTRY_URL"
      echo "[entrypoint] Sandbox registry: ${REGISTRY_URL} (--insecure-registry)"
    fi
    dockerd $DOCKERD_ARGS > /var/log/dockerd.log 2>&1 &

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

    # ── 2a-pre. Login to sandbox registry ──────────────────────────
    if [ -n "$REGISTRY_URL" ] && [ -n "${SANDBOX_REGISTRY_TOKEN:-}" ]; then
      echo "[entrypoint] Logging into sandbox registry at ${REGISTRY_URL}..."
      echo "$SANDBOX_REGISTRY_TOKEN" | docker login "$REGISTRY_URL" \
        -u "${SANDBOX_REGISTRY_USER:-openclaw}" --password-stdin 2>/dev/null || \
        echo "[entrypoint] WARNING: Registry login failed (registry may not be ready yet)"
    fi

    # Export registry URL for rebuild-sandboxes.sh
    export SANDBOX_REGISTRY_URL="$REGISTRY_URL"

    # ── 2a. Load pre-built sandbox images from archive ──────────────
    # Optional optimization: pre-built sandbox images can be saved as a tar
    # archive and loaded into each instance's nested Docker on first boot.
    # This reduces first-boot time from ~15min (build) to ~30s (load).
    # rebuild-sandboxes.sh still runs after and verifies/rebuilds if needed.
    # Check both locations:
    #   /app/openclaw-stack/sandbox-images.tar      — read-only deploy mount (pre-packaged)
    #   /var/lib/docker/sandbox-images.tar  — writable per-claw dir (placed by sync-images)
    for SANDBOX_ARCHIVE in "/app/openclaw-stack/sandbox-images.tar" "/var/lib/docker/sandbox-images.tar"; do
      if [ -f "$SANDBOX_ARCHIVE" ]; then
        if ! docker image inspect openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
          echo "[entrypoint] Loading pre-built sandbox images from ${SANDBOX_ARCHIVE}..."
          docker load < "$SANDBOX_ARCHIVE"
          echo "[entrypoint] Sandbox images loaded"
        else
          echo "[entrypoint] Sandbox images already present, skipping archive load"
        fi
        # Clean up writable archive after loading (don't delete read-only deploy mount copy)
        if [ "$SANDBOX_ARCHIVE" = "/var/lib/docker/sandbox-images.tar" ]; then
          rm -f "$SANDBOX_ARCHIVE"
          echo "[entrypoint] Cleaned up sandbox archive from Docker data dir"
        fi
        break  # Only load from first found archive
      fi
    done

    # Sandbox builds are non-fatal — gateway starts even if builds fail.
    # Failures are logged but don't prevent the gateway from running.
    # Missing images will surface during deployment verification or when agents run.
    (
      set +e
      /app/openclaw-stack/rebuild-sandboxes.sh
    ) || true
  fi
else
  echo "[entrypoint] Docker not installed, skipping sandbox bootstrap"
fi

# ── 2b. Start dashboard server ───────────────────────────────────────
# Exposes browser sessions, media files, and dashboard features on a fixed port.
# Reads browsers.json dynamically to discover sandbox browser containers and their mapped ports.
# Run as node to avoid creating root-owned jiti cache files in /tmp/jiti/
# that would block the gateway (also node) from writing cache entries.
DASHBOARD_SERVER="/app/openclaw-stack/dashboard/server.mjs"
if [ -f "$DASHBOARD_SERVER" ]; then
  # Supervisor loop: restart dashboard if it crashes, with backoff to avoid spin.
  # - set +e: parent script uses set -e which subshells inherit; without this,
  #   a non-zero exit from the dashboard (e.g. signal kill) would exit the loop.
  # - Inner (...) around gosu: gosu uses exec which replaces the current process;
  #   the inner subshell gives gosu a disposable process to replace.
  (
    set +e
    while true; do
      ( gosu node node "$DASHBOARD_SERVER" )
      echo "[entrypoint] Dashboard exited ($?), restarting in 3s..."
      sleep 3
    done
  ) &
  echo "[entrypoint] Dashboard server started on port 6090 (as node)"
fi

# ── 2c. Fix jiti cache permissions ─────────────────────────────────
# jiti (TypeScript JIT compiler) caches compiled .cjs in $TMPDIR/jiti/.
# Under Sysbox, uid remapping can cause files in /tmp to appear root-owned
# even when written by the node process, blocking subsequent writes.
# Redirect TMPDIR to a node-owned location so jiti (and other temp files)
# are created with correct ownership after gosu drops privileges.
export TMPDIR="/home/node/.cache/tmp"
mkdir -p "$TMPDIR"
chown 1000:1000 "$TMPDIR"
echo "[entrypoint] TMPDIR: $TMPDIR"

# ── 3. Drop privileges and exec gateway ─────────────────────────────
# gosu drops from root to node user without spawning a subshell,
# preserving PID structure for proper signal handling via tini
echo "[entrypoint] Executing as node: $*"
exec gosu node "$@"
