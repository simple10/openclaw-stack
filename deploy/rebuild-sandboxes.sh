#!/bin/bash
# Sandbox image builder — runs inside the gateway container.
# Called by entrypoint-gateway.sh on boot and by update-sandboxes.sh via docker exec.
#
# Handles: base image, common image (with toolkit config + labels), browser image.
# Config change detection: rebuilds common image when sandbox-toolkit.yaml changes.
# Integrity verification: stores/compares image digests to detect tampering.
# Staleness: warns when images are older than 30 days.
#
# Usage:
#   /app/deploy/rebuild-sandboxes.sh              # boot mode: build missing, detect config changes
#   /app/deploy/rebuild-sandboxes.sh --force      # force rebuild common (+ base if needed)
#   /app/deploy/rebuild-sandboxes.sh --force --all  # force rebuild all including browser
#   /app/deploy/rebuild-sandboxes.sh --dry-run    # show what would be rebuilt

set -uo pipefail

TOOLKIT_CONFIG="/app/deploy/sandbox-toolkit.yaml"
TOOLKIT_PARSER="/app/deploy/parse-toolkit.mjs"
DIGESTS_FILE="/var/lib/docker/openclaw-image-digests.json"
STALENESS_DAYS=30

FORCE=false
ALL=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --force)  FORCE=true ;;
    --all)    ALL=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

log() { echo "[sandbox-builder] $*"; }

# ── Helpers ────────────────────────────────────────────────────────────

image_exists() {
  docker image inspect "$1" > /dev/null 2>&1
}

# Get the comment-stripped toolkit config for comparison/labeling
get_stripped_config() {
  if [ -f "$TOOLKIT_CONFIG" ] && [ -f "$TOOLKIT_PARSER" ]; then
    node "$TOOLKIT_PARSER" "$TOOLKIT_CONFIG" --strip
  fi
}

# Get the JSON-parsed toolkit config for build parameters
get_toolkit_json() {
  if [ -f "$TOOLKIT_CONFIG" ] && [ -f "$TOOLKIT_PARSER" ]; then
    node "$TOOLKIT_PARSER" "$TOOLKIT_CONFIG"
  fi
}

# Read a label from a Docker image
get_image_label() {
  local image="$1" label="$2"
  docker image inspect "$image" --format "{{index .Config.Labels \"$label\"}}" 2>/dev/null || true
}

# Hash config for Docker label storage and comparison.
hash_config() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

# Check if config has changed since last build.
# Compares escaped forms since the label stores escaped content.
config_changed() {
  local current_config="$1"
  if ! image_exists "openclaw-sandbox-common:bookworm-slim"; then
    return 0  # image missing, needs build
  fi
  local stored_config
  stored_config=$(get_image_label "openclaw-sandbox-common:bookworm-slim" "openclaw.toolkit-config")
  if [ -z "$stored_config" ]; then
    return 0  # no label (pre-label image), treat as changed
  fi
  local current_hash
  current_hash=$(hash_config "$current_config")
  [ "$current_hash" != "$stored_config" ]
}

# ── Integrity verification ─────────────────────────────────────────────

save_digests() {
  local digests="{"
  local first=true
  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-common:bookworm-slim \
             openclaw-sandbox-browser:bookworm-slim; do
    if image_exists "$img"; then
      local digest
      digest=$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null)
      if [ "$first" = true ]; then first=false; else digests="$digests,"; fi
      digests="$digests\"$img\":\"$digest\""
    fi
  done
  digests="$digests}"
  echo "$digests" > "$DIGESTS_FILE"
  log "Image digests saved"
}

verify_digests() {
  if [ ! -f "$DIGESTS_FILE" ]; then
    return  # first boot, nothing to verify
  fi

  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-common:bookworm-slim \
             openclaw-sandbox-browser:bookworm-slim; do
    if image_exists "$img"; then
      local current_digest stored_digest
      current_digest=$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null)
      stored_digest=$(node -e "
        const d = JSON.parse(require('fs').readFileSync('$DIGESTS_FILE','utf8'));
        process.stdout.write(d['$img'] || '');
      " 2>/dev/null)
      if [ -n "$stored_digest" ] && [ "$current_digest" != "$stored_digest" ]; then
        log "WARNING: $img digest mismatch — image may have been tampered with"
        log "  stored:  $stored_digest"
        log "  current: $current_digest"
      fi
    fi
  done
}

# ── Staleness check ───────────────────────────────────────────────────

check_staleness() {
  local img="$1"
  if ! image_exists "$img"; then return; fi

  local build_date
  build_date=$(get_image_label "$img" "openclaw.build-date")
  if [ -z "$build_date" ]; then
    log "$img: no build-date label (pre-label image)"
    return
  fi

  local build_epoch now_epoch age_days
  build_epoch=$(date -d "$build_date" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$build_date" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  if [ "$build_epoch" -eq 0 ]; then
    log "$img: could not parse build-date '$build_date'"
    return
  fi

  age_days=$(( (now_epoch - build_epoch) / 86400 ))
  if [ "$age_days" -gt "$STALENESS_DAYS" ]; then
    log "WARNING: $img is ${age_days} days old — run update-sandboxes.sh for security patches"
  else
    log "$img already exists (built ${age_days} days ago)"
  fi
}

# ── Build: base sandbox ───────────────────────────────────────────────

build_base() {
  if image_exists "openclaw-sandbox:bookworm-slim" && [ "$FORCE" = false ]; then
    log "Base sandbox image already exists"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would build openclaw-sandbox:bookworm-slim"
    return 0
  fi

  log "Building base sandbox image..."
  if [ -f /app/Dockerfile.sandbox ]; then
    cd /app && scripts/sandbox-setup.sh
    if image_exists "openclaw-sandbox:bookworm-slim"; then
      log "Base sandbox image built successfully"
      return 0
    else
      log "ERROR: Base sandbox image build failed"
      return 1
    fi
  else
    log "WARNING: /app/Dockerfile.sandbox not found"
    return 1
  fi
}

# ── Build: common sandbox ─────────────────────────────────────────────

build_common() {
  local current_config="$1"
  local toolkit_json="$2"
  local needs_build=false
  local reason=""

  if ! image_exists "openclaw-sandbox-common:bookworm-slim"; then
    needs_build=true
    reason="image missing"
  elif [ "$FORCE" = true ]; then
    needs_build=true
    reason="forced rebuild"
  elif config_changed "$current_config"; then
    needs_build=true
    reason="config changed"
  fi

  if [ "$needs_build" = false ]; then
    check_staleness "openclaw-sandbox-common:bookworm-slim"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would build openclaw-sandbox-common:bookworm-slim ($reason)"
    return 0
  fi

  log "Building common sandbox image ($reason)..."

  # Remove existing image if rebuilding (config change or force)
  if image_exists "openclaw-sandbox-common:bookworm-slim"; then
    docker rmi openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1 || true
  fi

  if [ ! -f /app/scripts/sandbox-common-setup.sh ]; then
    log "WARNING: sandbox-common-setup.sh not found"
    return 1
  fi

  # Ensure base image exists (common depends on it)
  if ! image_exists "openclaw-sandbox:bookworm-slim"; then
    build_base || return 1
  fi

  # Read packages from toolkit config (falls back to minimal set)
  local toolkit_packages=""
  if [ -n "$toolkit_json" ]; then
    toolkit_packages=$(echo "$toolkit_json" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).packages.join(' ')))")
  fi
  if [ -z "$toolkit_packages" ]; then
    log "WARNING: No toolkit config, using fallback package list"
    toolkit_packages="curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file ffmpeg imagemagick"
  fi

  # Step 1: Build rooted intermediate from base image
  # Upstream sandbox-common-setup.sh has a bug: generated Dockerfile inherits
  # USER sandbox from base and runs apt-get without root. Fix: rooted intermediate.
  # Add NodeSource 24.x repo so upstream's apt-get install nodejs gets Node 24 (not Debian's Node 18)
  printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\nRUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash -\n' \
    | docker build -t openclaw-sandbox-base-root:bookworm-slim -
  if ! image_exists "openclaw-sandbox-base-root:bookworm-slim"; then
    log "ERROR: Failed to build rooted intermediate image"
    return 1
  fi

  # Step 2: Run upstream script with BASE_IMAGE override + config-driven packages.
  # Build from /tmp/sandbox-build to avoid /app/.env permission issue (Sysbox maps
  # .env to nobody:600, Docker can't read it when scanning build context).
  # The Dockerfile has no COPY instructions so the context dir doesn't matter.
  mkdir -p /tmp/sandbox-build
  ln -sf /app/Dockerfile.sandbox-common /tmp/sandbox-build/Dockerfile.sandbox-common
  (cd /tmp/sandbox-build && \
    BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
    PACKAGES="$toolkit_packages" \
    /app/scripts/sandbox-common-setup.sh) || true

  if ! image_exists "openclaw-sandbox-common:bookworm-slim"; then
    log "ERROR: Common sandbox image build failed — upstream script did not produce image"
    docker rmi openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1 || true
    return 1
  fi

  # Step 3: Layer custom tool installs from sandbox-toolkit.yaml + add metadata labels
  local tool_dockerfile="FROM openclaw-sandbox-common:bookworm-slim\nUSER root\n"
  local has_tool_installs=false

  if [ -n "$toolkit_json" ]; then
    local tool_installs install_count
    local bin_dir="/usr/local/bin"
    local install_cmds
    install_cmds=$(echo "$toolkit_json" | node -e "
      process.stdin.on('data', d => {
        const t = JSON.parse(d).tools;
        const aptPkgs = [];
        const installs = [];
        for (const [name, cfg] of Object.entries(t)) {
          if (cfg.apt) aptPkgs.push(cfg.apt);
          if (cfg.install) installs.push({ name, install: cfg.install, version: cfg.version || '' });
        }
        if (aptPkgs.length > 0) {
          console.log('RUN apt-get update && apt-get install -y --no-install-recommends ' + aptPkgs.join(' ') + ' && rm -rf /var/lib/apt/lists/*');
        }
        for (const t of installs) {
          let cmd = t.install;
          if (t.version) cmd = cmd.replaceAll('\${VERSION}', t.version);
          cmd = cmd.replaceAll('\${BIN_DIR}', '$bin_dir');
          // Auto-wrap 'brew install ...' — brew refuses to run as root, so we
          // switch to the linuxbrew user with the full brew path and suppress auto-update.
          // Handles optional leading env vars: 'FOO=bar brew install pkg'
          const brewMatch = cmd.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)brew\s+install\s+(.*)/);
          if (brewMatch) {
            const envVars = brewMatch[1].trim();
            const envPrefix = envVars ? envVars + ' ' : '';
            const args = brewMatch[2];
            cmd = \"su -s /bin/bash linuxbrew -c '\" + envPrefix + \"HOMEBREW_NO_AUTO_UPDATE=1 /home/linuxbrew/.linuxbrew/bin/brew install \" + args + \"'\";
          }
          console.log('RUN ' + cmd);
        }
      });
    ")
    if [ -n "$install_cmds" ]; then
      has_tool_installs=true
      tool_dockerfile="${tool_dockerfile}ENV BIN_DIR=${bin_dir}\n${install_cmds}\n"
    fi
  fi

  # Add metadata labels for config change detection and staleness tracking.
  local config_hash
  config_hash=$(hash_config "$current_config")
  local build_date
  build_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tool_dockerfile="${tool_dockerfile}LABEL openclaw.toolkit-config=\"${config_hash}\"\n"
  tool_dockerfile="${tool_dockerfile}LABEL openclaw.build-date=\"${build_date}\"\n"
  tool_dockerfile="${tool_dockerfile}USER 1000\n"

  if [ "$has_tool_installs" = true ]; then
    log "Installing custom tools into sandbox-common..."
  fi
  printf "%b" "$tool_dockerfile" \
    | docker build -t openclaw-sandbox-common:bookworm-slim -

  # Cleanup intermediate image
  docker rmi openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1 || true

  if image_exists "openclaw-sandbox-common:bookworm-slim"; then
    log "Common sandbox image built successfully"
    return 0
  else
    log "ERROR: Common sandbox image build failed"
    return 1
  fi
}

# ── Build: browser sandbox ────────────────────────────────────────────

build_browser() {
  if [ "$ALL" = false ] && [ "$FORCE" = false ]; then
    # In non-force/non-all mode, only build if missing
    if image_exists "openclaw-sandbox-browser:bookworm-slim"; then
      check_staleness "openclaw-sandbox-browser:bookworm-slim"
      return 0
    fi
  elif [ "$ALL" = false ]; then
    # --force without --all: only build if missing
    if image_exists "openclaw-sandbox-browser:bookworm-slim"; then
      log "Browser sandbox image already exists (use --all to rebuild)"
      return 0
    fi
  fi

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would build openclaw-sandbox-browser:bookworm-slim"
    return 0
  fi

  # Remove existing if force-rebuilding
  if [ "$FORCE" = true ] && [ "$ALL" = true ] && image_exists "openclaw-sandbox-browser:bookworm-slim"; then
    docker rmi openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1 || true
  fi

  if ! image_exists "openclaw-sandbox-browser:bookworm-slim"; then
    log "Building browser sandbox image..."
    if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
      /app/scripts/sandbox-browser-setup.sh
      if image_exists "openclaw-sandbox-browser:bookworm-slim"; then
        log "Browser sandbox image built successfully"
        return 0
      else
        log "ERROR: Browser sandbox image build failed"
        return 1
      fi
    else
      log "WARNING: sandbox-browser-setup.sh not found"
      return 1
    fi
  else
    check_staleness "openclaw-sandbox-browser:bookworm-slim"
    return 0
  fi
}

# ── Seed agent home directories ─────────────────────────────────────────

seed_agent_homes() {
  local sandboxes_dir="/home/node/sandboxes-home"
  local config_file="/home/node/.openclaw/openclaw.json"

  if [ ! -d "$sandboxes_dir" ]; then
    log "No sandboxes-home dir, skipping agent home seeding"
    return 0
  fi

  if [ ! -f "$config_file" ]; then
    log "WARNING: openclaw.json not found, skipping agent home seeding"
    return 0
  fi

  # Emit "id image" pairs — each agent's image from config, falling back to defaults
  # Use JSON5.parse because openclaw.json supports JSON5 (comments, trailing commas, etc.)
  local agent_entries
  agent_entries=$(node -e "
    const JSON5 = require('json5');
    const cfg = JSON5.parse(require('fs').readFileSync('$config_file', 'utf8'));
    const defaultImage = cfg.agents?.defaults?.sandbox?.docker?.image || '';
    for (const a of cfg.agents?.list || []) {
      const image = a.sandbox?.docker?.image || defaultImage;
      console.log(a.id + ' ' + image);
    }
  " 2>/dev/null) || true

  if [ -z "$agent_entries" ]; then
    log "No agents found in openclaw.json"
    return 0
  fi

  echo "$agent_entries" | while read -r agent_id agent_image; do
    local agent_dir="$sandboxes_dir/$agent_id"

    # Create agent home dir if missing
    if [ ! -d "$agent_dir" ]; then
      if [ "$DRY_RUN" = true ]; then
        log "[dry-run] Would create $agent_dir/ and seed dotfiles"
        continue
      fi
      mkdir -p "$agent_dir"
      log "Created $agent_dir/"
    fi

    # Seed default shell dotfiles from the agent's sandbox image /etc/skel/
    # so they aren't lost when the bind mount shadows /home/sandbox
    if [ ! -f "$agent_dir/.bashrc" ]; then
      if [ "$DRY_RUN" = true ]; then
        log "[dry-run] Would seed dotfiles into $agent_dir/ from $agent_image"
        continue
      fi
      if [ -n "$agent_image" ] && image_exists "$agent_image"; then
        docker run --rm "$agent_image" \
          tar -cf - -C /etc/skel . 2>/dev/null \
          | tar -xf - -C "$agent_dir/" 2>/dev/null || true
        log "Seeded dotfiles into $agent_dir/ from $agent_image"
      else
        log "WARNING: image '$agent_image' not available for agent '$agent_id', skipping dotfile seeding"
      fi
    fi
  done

  # Fix ownership for all agent sandbox dirs
  chown -R 1000:1000 "$sandboxes_dir"
}

# ── Main ──────────────────────────────────────────────────────────────

if ! docker info > /dev/null 2>&1; then
  log "ERROR: Docker daemon not available"
  exit 1
fi

# Verify image integrity against stored digests (before any builds)
verify_digests

# Get current toolkit config
CURRENT_CONFIG=$(get_stripped_config)
TOOLKIT_JSON=$(get_toolkit_json)

# Build images
FAILED=0

build_base || FAILED=1
build_common "$CURRENT_CONFIG" "$TOOLKIT_JSON" || FAILED=1
build_browser || FAILED=1

# Seed persistent agent home directories (needs sandbox-common image)
seed_agent_homes

# Save digests after all builds complete
if [ "$DRY_RUN" = false ]; then
  save_digests
fi

if [ "$FAILED" -eq 1 ]; then
  log "Some sandbox image builds failed — check logs above"
  exit 1
fi

log "All sandbox images ready"
