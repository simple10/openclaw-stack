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

# ── 1c. Fix .claude-sandbox dir ownership (Sysbox uid remapping) ────
# Sandbox credentials dir: host bind mount arrives with host uid which Sysbox remaps.
# Chown to node (1000) so sandbox containers (via binds) can access it.
claude_dir="/home/node/.claude-sandbox"
if [ -d "$claude_dir" ]; then
  dir_owner=$(stat -c '%u' "$claude_dir" 2>/dev/null)
  if [ "$dir_owner" != "1000" ]; then
    chown -R 1000:1000 "$claude_dir"
    echo "[entrypoint] Fixed .claude-sandbox ownership: ${dir_owner} -> 1000"
  fi
fi

# ── 1d. Fix .openclaw dir ownership (Sysbox uid remapping) ──────────
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

# ── 1e. Create openclaw CLI symlink ──────────────────────────────────
# /app/openclaw.mjs has #!/usr/bin/env node shebang and is executable.
# Symlink to /usr/local/bin so 'openclaw' works anywhere in the container.
if [ ! -L /usr/local/bin/openclaw ]; then
  ln -sf /app/openclaw.mjs /usr/local/bin/openclaw
  echo "[entrypoint] Created /usr/local/bin/openclaw symlink"
fi

# ── 1f. Configure npm global prefix for skill installs ────────────
# Gateway runs as node (uid 1000) after gosu drops privileges.
# npm install -g (used by skills.install) needs a writable global prefix.
# Default /usr/local/lib/node_modules is owned by root — redirect to user dir.
npm_global="/home/node/.npm-global"
mkdir -p "$npm_global"
chown 1000:1000 "$npm_global"
echo "prefix=$npm_global" >> /home/node/.npmrc
# Add to PATH so globally installed binaries are found
export PATH="$npm_global/bin:$PATH"
echo "[entrypoint] npm global prefix set to $npm_global"

# ── 1g. Auto-generate gateway shims from sandbox-toolkit.yaml ─────
# Skills check bins on the gateway (load-time) AND inside the sandbox (runtime).
# /opt/skill-bins is bind-mounted read-only into all sandboxes, making
# gateway-installed binaries available without network or image rebuilds.
# Shims satisfy the gateway preflight check; real binaries live in sandbox images.
mkdir -p /opt/skill-bins

TOOLKIT_CONFIG="/app/deploy/sandbox-toolkit.yaml"
TOOLKIT_PARSER="/app/deploy/parse-toolkit.mjs"

if [ -f "$TOOLKIT_CONFIG" ] && [ -f "$TOOLKIT_PARSER" ]; then
  TOOLKIT_JSON=$(node "$TOOLKIT_PARSER" "$TOOLKIT_CONFIG")

  # Generate a shim for each declared binary.
  # Shims are pass-through: if the real binary exists elsewhere in PATH (i.e. inside
  # a sandbox where tools are installed), the shim execs it. On the gateway (where only
  # shims exist), they print an error. This prevents shims from shadowing real binaries
  # when /opt/skill-bins is bind-mounted into sandboxes.
  for bin in $(echo "$TOOLKIT_JSON" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).allBins.join(' ')))"); do
    if [ ! -f "/opt/skill-bins/$bin" ]; then
      cat > "/opt/skill-bins/$bin" << 'SHIM'
#!/bin/sh
# Auto-generated shim — pass through to real binary if available
SELF_DIR=$(dirname "$(readlink -f "$0")")
ORIG_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "$SELF_DIR" | tr '\n' ':' | sed 's/:$//')
REAL=$(PATH="$ORIG_PATH" command -v "$(basename "$0")" 2>/dev/null)
if [ -n "$REAL" ]; then
  exec "$REAL" "$@"
fi
echo "ERROR: $(basename "$0") is a shim — run inside sandbox" >&2
exit 1
SHIM
      chmod +x "/opt/skill-bins/$bin"
    fi
  done
  echo "[entrypoint] Auto-shimmed $(ls /opt/skill-bins | wc -l) binaries from sandbox-toolkit.yaml"
else
  echo "[entrypoint] WARNING: sandbox-toolkit.yaml or parser not found, skipping shim generation"
fi

# Add to gateway PATH for load-time skill checks
if ! echo "$PATH" | grep -q '/opt/skill-bins'; then
  export PATH="/opt/skill-bins:$PATH"
fi

# ── 1h. Deploy plugins to global extensions dir ────────────────────
# Plugins from deploy/plugins/ are copied to ~/.openclaw/extensions/
# where the gateway discovers them automatically.
# The skill-router plugin replaces per-skill SKILL.md overrides — it rewrites
# skill descriptions in the system prompt based on config rules in openclaw.json.
global_extensions="/home/node/.openclaw/extensions"
deploy_plugins="/app/deploy/plugins"
if [ -d "$deploy_plugins" ]; then
  mkdir -p "$global_extensions"
  for plugin_dir in "$deploy_plugins"/*/; do
    plugin_name=$(basename "$plugin_dir")
    target="$global_extensions/$plugin_name"
    # Copy if new or source is newer
    if [ ! -d "$target" ] || [ "$deploy_plugins/$plugin_name/index.js" -nt "$target/index.js" ]; then
      rm -rf "$target"
      cp -r "$deploy_plugins/$plugin_name" "$target"
      echo "[entrypoint] Deployed plugin: $plugin_name"
    fi
  done
  chown -R 1000:1000 "$global_extensions"
  echo "[entrypoint] Plugins ready"
else
  echo "[entrypoint] No plugins to deploy"
fi

# ── 1i. Deploy managed hooks ──────────────────────────────────────
# Hooks from deploy/hooks/ are copied to ~/.openclaw/hooks/ where the
# gateway discovers them. Each hook dir contains HOOK.md + handler.js.
# Hook entries must also be enabled in openclaw.json (hooks.internal.entries).
hooks_dir="/home/node/.openclaw/hooks"
deploy_hooks="/app/deploy/hooks"
if [ -d "$deploy_hooks" ]; then
  mkdir -p "$hooks_dir"
  for hook_dir in "$deploy_hooks"/*/; do
    hook_name=$(basename "$hook_dir")
    target="$hooks_dir/$hook_name"
    if [ ! -d "$target" ] || [ "$deploy_hooks/$hook_name/handler.js" -nt "$target/handler.js" ]; then
      rm -rf "$target"
      cp -r "$deploy_hooks/$hook_name" "$target"
      echo "[entrypoint] Deployed hook: $hook_name"
    fi
  done
  chown -R 1000:1000 "$hooks_dir"
  echo "[entrypoint] Hooks ready"
else
  echo "[entrypoint] No hooks to deploy"
fi

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# /var/lib/docker is a persistent bind mount from host (./data/docker),
# so sandbox images survive container restarts (no ~5min rebuild).
# rebuild-sandboxes.sh handles: config change detection (auto-rebuild when
# sandbox-toolkit.yaml changes), integrity verification (digest comparison),
# and staleness warnings (>30 days).
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

    # Sandbox builds are non-fatal — gateway starts even if builds fail.
    # Failures are logged but don't prevent the gateway from running.
    # Missing images will surface during deployment verification or when agents run.
    (
      set +e
      /app/deploy/rebuild-sandboxes.sh
    )
  fi
else
  echo "[entrypoint] Docker not installed, skipping sandbox bootstrap"
fi

# ── 3. Drop privileges and exec gateway ─────────────────────────────
# gosu drops from root to node user without spawning a subshell,
# preserving PID structure for proper signal handling via tini
echo "[entrypoint] Executing as node: $*"
exec gosu node "$@"
