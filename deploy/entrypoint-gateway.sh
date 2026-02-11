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

# ── 1g. Install skill binaries for sandbox availability ──────────
# Skills check bins on the gateway (load-time) AND inside the sandbox (runtime).
# /opt/skill-bins is bind-mounted read-only into all sandboxes, making
# gateway-installed binaries available without network or image rebuilds.
mkdir -p /opt/skill-bins

# TODO: remove this after testing new plugin; gifgrep & other skills should be installed via OpenClaw, not hardcoded here
# gifgrep — GIF search skill
if [ ! -f /opt/skill-bins/gifgrep ]; then
  echo "[entrypoint] Installing gifgrep..."
  curl -sfL https://github.com/steipete/gifgrep/releases/download/v0.2.1/gifgrep_0.2.1_linux_amd64.tar.gz \
    | tar xz -C /opt/skill-bins gifgrep 2>/dev/null \
    && echo "[entrypoint] gifgrep installed" \
    || echo "[entrypoint] WARNING: gifgrep install failed (non-fatal)"
fi

# Coding CLI shims — coding-agent skill requires anyBins: ["claude","codex","opencode","pi"].
# Real CLIs live in the claude sandbox image. Shims satisfy the gateway preflight check.
for cli in claude codex opencode pi; do
  if [ ! -f "/opt/skill-bins/$cli" ]; then
    printf '#!/bin/sh\necho "ERROR: $0 is a shim — run inside sandbox" >&2\nexit 1\n' \
      > "/opt/skill-bins/$cli"
    chmod +x "/opt/skill-bins/$cli"
  fi
done

# Add to gateway PATH for load-time skill checks
if ! echo "$PATH" | grep -q '/opt/skill-bins'; then
  export PATH="/opt/skill-bins:$PATH"
fi
echo "[entrypoint] Skill binaries ready ($(ls /opt/skill-bins | wc -l) items)"

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

# ── 2. Start nested Docker daemon (Sysbox provides isolation) ───────
# /var/lib/docker is a persistent bind mount from host (./data/docker),
# so sandbox images survive container restarts (no ~5min rebuild).
# TODO: verify sandbox image checksums on startup and rebuild if tampered,
# to mitigate poisoned-image persistence risk.
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

      # Build default sandbox image if missing
      if ! docker image inspect openclaw-sandbox:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Base sandbox image not found, building..."
        if [ -f /app/Dockerfile.sandbox ]; then
          cd /app && scripts/sandbox-setup.sh
          if docker image inspect openclaw-sandbox:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: /app/Dockerfile.sandbox not found"
        fi
      else
        echo "[entrypoint] Sandbox image already exists"
      fi

      # Build common sandbox image if missing (includes Node.js, git, common tools)
      # Upstream sandbox-common-setup.sh has a bug: the generated Dockerfile inherits
      # USER sandbox from the base image and runs apt-get without switching to root.
      # Fix: build a rooted intermediate image and pass it via BASE_IMAGE env var.
      if ! docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Common sandbox image not found, building..."
        if [ -f /app/scripts/sandbox-common-setup.sh ]; then
          # Step 1: Build rooted intermediate from base image
          printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\n' \
            | docker build -t openclaw-sandbox-base-root:bookworm-slim -
          if ! docker image inspect openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] ERROR: Failed to build rooted intermediate image"
          else
            # Step 2: Run upstream script with BASE_IMAGE override + extra packages
            BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
            PACKAGES="curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file ffmpeg imagemagick" \
            /app/scripts/sandbox-common-setup.sh || true

            # Step 3: Verify and fix USER to 1000 for security
            if docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
              printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER 1000\n' \
                | docker build -t openclaw-sandbox-common:bookworm-slim -
              echo "[entrypoint] Common sandbox image built successfully"
            else
              echo "[entrypoint] ERROR: Common sandbox image build failed — upstream script did not produce image"
            fi

            # Step 4: Cleanup intermediate image
            docker rmi openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1 || true
          fi
        else
          echo "[entrypoint] WARNING: sandbox-common-setup.sh not found"
        fi
      else
        echo "[entrypoint] Common sandbox image already exists"
      fi

      # Build browser sandbox image if missing (includes Chromium, noVNC)
      if ! docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
        echo "[entrypoint] Browser sandbox image not found, building..."
        if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
          /app/scripts/sandbox-browser-setup.sh
          if docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Browser sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Browser sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found"
        fi
      else
        echo "[entrypoint] Browser sandbox image already exists"
      fi

      # Build claude sandbox image if missing (layered on common with Claude Code CLI)
      # ffmpeg + imagemagick are already in common via PACKAGES override above
      if ! docker image inspect openclaw-sandbox-claude:bookworm-slim > /dev/null 2>&1; then
        if docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
          echo "[entrypoint] Claude sandbox image not found, building..."
          printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' \
            | docker build -t openclaw-sandbox-claude:bookworm-slim -
          if docker image inspect openclaw-sandbox-claude:bookworm-slim > /dev/null 2>&1; then
            echo "[entrypoint] Claude sandbox image built successfully"
          else
            echo "[entrypoint] ERROR: Claude sandbox image build failed"
          fi
        else
          echo "[entrypoint] WARNING: Skipping claude sandbox — common image not available"
        fi
      else
        echo "[entrypoint] Claude sandbox image already exists"
      fi
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
