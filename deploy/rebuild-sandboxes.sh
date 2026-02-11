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

# Escape config for Docker label storage (newlines -> literal \n, quotes escaped).
# Must match the escaping used in build_common() for label embedding.
escape_config() {
  echo "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>process.stdout.write(d.replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"').replace(/\\n/g,'\\\\n')));
  "
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
  local escaped_current
  escaped_current=$(escape_config "$current_config")
  [ "$escaped_current" != "$stored_config" ]
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
  printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\n' \
    | docker build -t openclaw-sandbox-base-root:bookworm-slim -
  if ! image_exists "openclaw-sandbox-base-root:bookworm-slim"; then
    log "ERROR: Failed to build rooted intermediate image"
    return 1
  fi

  # Step 2: Run upstream script with BASE_IMAGE override + config-driven packages
  BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
  PACKAGES="$toolkit_packages" \
  /app/scripts/sandbox-common-setup.sh || true

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
    tool_installs=$(echo "$toolkit_json" | node -e "
      process.stdin.on('data', d => {
        const t = JSON.parse(d).tools;
        const installs = [];
        for (const [name, cfg] of Object.entries(t)) {
          if (cfg.install) installs.push({ name, install: cfg.install, version: cfg.version || '' });
        }
        console.log(JSON.stringify(installs));
      });
    ")
    install_count=$(echo "$tool_installs" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).length))")
    if [ "$install_count" -gt 0 ]; then
      has_tool_installs=true
      local bin_dir="/usr/local/bin"
      local install_cmds
      install_cmds=$(echo "$tool_installs" | node -e "
        process.stdin.on('data', d => {
          const installs = JSON.parse(d);
          for (const t of installs) {
            let cmd = t.install;
            if (t.version) cmd = cmd.replaceAll('\${VERSION}', t.version);
            cmd = cmd.replaceAll('\${BIN_DIR}', '$bin_dir');
            console.log('RUN ' + cmd);
          }
        });
      ")
      tool_dockerfile="${tool_dockerfile}ENV BIN_DIR=${bin_dir}\n${install_cmds}\n"
    fi
  fi

  # Add metadata labels for config change detection and staleness tracking.
  # Escape the config for use in a Docker label (newlines -> \n, quotes escaped).
  local escaped_config
  escaped_config=$(echo "$current_config" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>process.stdout.write(d.replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"').replace(/\\n/g,'\\\\n')));
  ")
  local build_date
  build_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tool_dockerfile="${tool_dockerfile}LABEL openclaw.toolkit-config=\"${escaped_config}\"\n"
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

# Save digests after all builds complete
if [ "$DRY_RUN" = false ]; then
  save_digests
fi

if [ "$FAILED" -eq 1 ]; then
  log "Some sandbox image builds failed — check logs above"
  exit 1
fi

log "All sandbox images ready"
