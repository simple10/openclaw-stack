#!/bin/bash
# Sandbox image builder — runs inside the gateway container.
# Called by entrypoint-gateway.sh on boot and by update-sandboxes.sh via docker exec.
#
# Image layer architecture:
#   openclaw-sandbox:bookworm-slim                     (upstream base)
#     -> openclaw-sandbox-base-root:bookworm-slim      (intermediate, cleaned up)
#       -> openclaw-sandbox-packages:bookworm-slim     (apt + brew packages)
#         -> openclaw-sandbox-toolkit:bookworm-slim    (tool installs from sandbox-toolkit.yaml)
#   openclaw-sandbox-browser:bookworm-slim             (separate chain, FROM debian:bookworm-slim)
#
# Config change detection uses split hashing:
#   - Packages hash (from packages array) -> label on packages image
#   - Tools hash (from tools object) -> label on toolkit image
#   Packages changed -> rebuild packages + toolkit
#   Only tools changed -> skip packages, rebuild toolkit (Docker caches unchanged RUN layers)
#
# Integrity verification: stores/compares image digests to detect tampering.
# Staleness: warns when images are older than 30 days.
#
# Usage:
#   /app/deploy/rebuild-sandboxes.sh                    # boot mode: build missing, detect config changes
#   /app/deploy/rebuild-sandboxes.sh --force            # force rebuild toolkit (+ packages/base if needed)
#   /app/deploy/rebuild-sandboxes.sh --force --all      # force rebuild all including browser
#   /app/deploy/rebuild-sandboxes.sh --quick <toolname> # layer a single tool on top of toolkit image
#   /app/deploy/rebuild-sandboxes.sh --dry-run          # show what would be rebuilt
#
# Sysbox build gotchas:
#   - Do NOT use `docker build -f - /dev/null` — Sysbox needs a real build context.
#     Use `printf '...' | docker build -t tag -` instead (stdin as Dockerfile, CWD as context).
#   - Do NOT use `docker run` + `docker commit` to build images — creates dirty single-layer
#     images that break caching. Always use multi-stage `docker build` with FROM.

set -uo pipefail

TOOLKIT_CONFIG="/app/deploy/sandbox-toolkit.yaml"
TOOLKIT_PARSER="/app/deploy/parse-toolkit.mjs"
DIGESTS_FILE="/var/lib/docker/openclaw-image-digests.json"
STALENESS_DAYS=30

FORCE=false
ALL=false
DRY_RUN=false
QUICK_TOOL=""

for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=true ;;
    --all)     ALL=true ;;
    --dry-run) DRY_RUN=true ;;
    --quick)   ;; # next arg is the tool name
    *)
      # Capture tool name after --quick
      if [ "${prev_arg:-}" = "--quick" ]; then
        QUICK_TOOL="$arg"
      fi
      ;;
  esac
  prev_arg="$arg"
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

# Extract just the packages array from toolkit JSON, hash it
get_packages_hash() {
  local toolkit_json="$1"
  if [ -n "$toolkit_json" ]; then
    echo "$toolkit_json" | node -e "
      process.stdin.on('data', d => {
        const cfg = JSON.parse(d);
        process.stdout.write(require('crypto').createHash('sha256')
          .update(JSON.stringify(cfg.packages)).digest('hex'));
      });
    "
  fi
}

# Extract just the tools object from toolkit JSON, hash it
get_tools_hash() {
  local toolkit_json="$1"
  if [ -n "$toolkit_json" ]; then
    echo "$toolkit_json" | node -e "
      process.stdin.on('data', d => {
        const cfg = JSON.parse(d);
        process.stdout.write(require('crypto').createHash('sha256')
          .update(JSON.stringify(cfg.tools)).digest('hex'));
      });
    "
  fi
}

# Check if packages config has changed since last build.
packages_changed() {
  local packages_hash="$1"
  if ! image_exists "openclaw-sandbox-packages:bookworm-slim"; then
    return 0  # image missing, needs build
  fi
  local stored_hash
  stored_hash=$(get_image_label "openclaw-sandbox-packages:bookworm-slim" "openclaw.packages-config")
  if [ -z "$stored_hash" ]; then
    return 0  # no label, treat as changed
  fi
  [ "$packages_hash" != "$stored_hash" ]
}

# Check if tools config has changed since last build.
tools_changed() {
  local tools_hash="$1"
  if ! image_exists "openclaw-sandbox-toolkit:bookworm-slim"; then
    return 0  # image missing, needs build
  fi
  local stored_hash
  stored_hash=$(get_image_label "openclaw-sandbox-toolkit:bookworm-slim" "openclaw.toolkit-config")
  if [ -z "$stored_hash" ]; then
    return 0  # no label, treat as changed
  fi
  [ "$tools_hash" != "$stored_hash" ]
}

# ── Integrity verification ─────────────────────────────────────────────

save_digests() {
  local digests="{"
  local first=true
  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-packages:bookworm-slim \
             openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
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

  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-packages:bookworm-slim \
             openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
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

# ── Generate tool install commands ────────────────────────────────────

# Generates Dockerfile RUN instructions for tool installs.
# Used by both build_toolkit() and quick_add_tool().
# Args: $1 = toolkit_json, $2 = optional tool name filter (empty = all tools)
generate_tool_installs() {
  local toolkit_json="$1"
  local filter_tool="${2:-}"
  local bin_dir="/usr/local/bin"

  if [ -z "$toolkit_json" ]; then
    return
  fi

  echo "$toolkit_json" | node -e "
    process.stdin.on('data', d => {
      const t = JSON.parse(d).tools;
      const filterTool = '$filter_tool';
      const aptPkgs = [];
      const installs = [];
      for (const [name, cfg] of Object.entries(t)) {
        if (filterTool && name !== filterTool) continue;
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
  "
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

# ── Build: packages layer ────────────────────────────────────────────

build_packages() {
  local toolkit_json="$1"
  local packages_hash="$2"
  local needs_build=false
  local reason=""

  if ! image_exists "openclaw-sandbox-packages:bookworm-slim"; then
    needs_build=true
    reason="image missing"
  elif [ "$FORCE" = true ]; then
    needs_build=true
    reason="forced rebuild"
  elif packages_changed "$packages_hash"; then
    needs_build=true
    reason="packages changed"
  fi

  if [ "$needs_build" = false ]; then
    check_staleness "openclaw-sandbox-packages:bookworm-slim"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would build openclaw-sandbox-packages:bookworm-slim ($reason)"
    return 0
  fi

  log "Building packages image ($reason)..."

  if [ ! -f /app/scripts/sandbox-common-setup.sh ]; then
    log "WARNING: sandbox-common-setup.sh not found"
    return 1
  fi

  # Ensure base image exists (packages depends on it)
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
    toolkit_packages="curl wget jq coreutils grep nodejs python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file ffmpeg imagemagick"
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
  # TARGET_IMAGE tags the output as packages (not the default sandbox-common).
  # Build from /tmp/sandbox-build to avoid /app/.env permission issue (Sysbox maps
  # .env to nobody:600, Docker can't read it when scanning build context).
  # The Dockerfile has no COPY instructions so the context dir doesn't matter.
  mkdir -p /tmp/sandbox-build
  ln -sf /app/Dockerfile.sandbox-common /tmp/sandbox-build/Dockerfile.sandbox-common
  (cd /tmp/sandbox-build && \
    BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
    TARGET_IMAGE=openclaw-sandbox-packages:bookworm-slim \
    PACKAGES="$toolkit_packages" \
    /app/scripts/sandbox-common-setup.sh) || true

  # Cleanup intermediate image
  docker rmi openclaw-sandbox-base-root:bookworm-slim > /dev/null 2>&1 || true

  if ! image_exists "openclaw-sandbox-packages:bookworm-slim"; then
    log "ERROR: Packages image build failed — upstream script did not produce image"
    return 1
  fi

  # Add metadata labels for config change detection and staleness tracking
  local build_date
  build_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf 'FROM openclaw-sandbox-packages:bookworm-slim\nLABEL openclaw.packages-config="%s"\nLABEL openclaw.build-date="%s"\n' \
    "$packages_hash" "$build_date" \
    | docker build -t openclaw-sandbox-packages:bookworm-slim -

  log "Packages image built successfully"
  return 0
}

# ── Build: toolkit layer ─────────────────────────────────────────────

build_toolkit() {
  local toolkit_json="$1"
  local tools_hash="$2"
  local needs_build=false
  local reason=""

  if ! image_exists "openclaw-sandbox-toolkit:bookworm-slim"; then
    needs_build=true
    reason="image missing"
  elif [ "$FORCE" = true ]; then
    needs_build=true
    reason="forced rebuild"
  elif tools_changed "$tools_hash"; then
    needs_build=true
    reason="tools changed"
  fi

  if [ "$needs_build" = false ]; then
    check_staleness "openclaw-sandbox-toolkit:bookworm-slim"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would build openclaw-sandbox-toolkit:bookworm-slim ($reason)"
    return 0
  fi

  # Ensure packages image exists (toolkit depends on it)
  if ! image_exists "openclaw-sandbox-packages:bookworm-slim"; then
    log "ERROR: Packages image missing — cannot build toolkit without it"
    return 1
  fi

  log "Building toolkit image ($reason)..."

  # Build tool installs on top of packages image.
  # Each tool is a separate RUN instruction — Docker caches unchanged ones.
  # No docker rmi before build — keeping the old image lets Docker cache hit.
  local bin_dir="/usr/local/bin"
  local tool_dockerfile="FROM openclaw-sandbox-packages:bookworm-slim\nUSER root\n"
  local has_tool_installs=false

  local install_cmds
  install_cmds=$(generate_tool_installs "$toolkit_json")
  if [ -n "$install_cmds" ]; then
    has_tool_installs=true
    tool_dockerfile="${tool_dockerfile}ENV BIN_DIR=${bin_dir}\n${install_cmds}\n"
  fi

  # Add metadata labels for config change detection and staleness tracking.
  local build_date
  build_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tool_dockerfile="${tool_dockerfile}LABEL openclaw.toolkit-config=\"${tools_hash}\"\n"
  tool_dockerfile="${tool_dockerfile}LABEL openclaw.build-date=\"${build_date}\"\n"
  tool_dockerfile="${tool_dockerfile}USER 1000\n"

  if [ "$has_tool_installs" = true ]; then
    log "Installing custom tools into sandbox-toolkit..."
  fi
  printf "%b" "$tool_dockerfile" \
    | docker build -t openclaw-sandbox-toolkit:bookworm-slim -

  if image_exists "openclaw-sandbox-toolkit:bookworm-slim"; then
    log "Toolkit image built successfully"
    return 0
  else
    log "ERROR: Toolkit image build failed"
    return 1
  fi
}

# ── Quick add: layer a single tool ────────────────────────────────────

quick_add_tool() {
  local tool_name="$1"
  local toolkit_json="$2"

  if [ "$DRY_RUN" = true ]; then
    log "[dry-run] Would quick-add tool '$tool_name' on top of openclaw-sandbox-toolkit:bookworm-slim"
    return 0
  fi

  if ! image_exists "openclaw-sandbox-toolkit:bookworm-slim"; then
    log "ERROR: Toolkit image missing — run a full build first"
    return 1
  fi

  # Verify the tool exists in config
  local tool_exists
  tool_exists=$(echo "$toolkit_json" | node -e "
    process.stdin.on('data', d => {
      const t = JSON.parse(d).tools;
      process.stdout.write(t['$tool_name'] ? 'yes' : 'no');
    });
  ")

  if [ "$tool_exists" != "yes" ]; then
    log "ERROR: Tool '$tool_name' not found in sandbox-toolkit.yaml"
    return 1
  fi

  log "Quick-adding tool '$tool_name'..."

  local bin_dir="/usr/local/bin"
  local install_cmds
  install_cmds=$(generate_tool_installs "$toolkit_json" "$tool_name")

  if [ -z "$install_cmds" ]; then
    log "ERROR: No install commands generated for '$tool_name'"
    return 1
  fi

  local dockerfile="FROM openclaw-sandbox-toolkit:bookworm-slim\nUSER root\nENV BIN_DIR=${bin_dir}\n${install_cmds}\nUSER 1000\n"
  printf "%b" "$dockerfile" \
    | docker build -t openclaw-sandbox-toolkit:bookworm-slim -

  if image_exists "openclaw-sandbox-toolkit:bookworm-slim"; then
    log "Tool '$tool_name' added successfully"
    log "NOTE: Run --force rebuild to properly order layers"
    return 0
  else
    log "ERROR: Quick-add failed for '$tool_name'"
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
TOOLKIT_JSON=$(get_toolkit_json)

# ── Quick-add mode: layer a single tool and exit ──
if [ -n "$QUICK_TOOL" ]; then
  quick_add_tool "$QUICK_TOOL" "$TOOLKIT_JSON" || exit 1
  if [ "$DRY_RUN" = false ]; then
    save_digests
  fi
  exit 0
fi

# Compute split config hashes
PACKAGES_HASH=$(get_packages_hash "$TOOLKIT_JSON")
TOOLS_HASH=$(get_tools_hash "$TOOLKIT_JSON")

# Build images
FAILED=0

build_base || FAILED=1
build_packages "$TOOLKIT_JSON" "$PACKAGES_HASH" || FAILED=1
build_toolkit "$TOOLKIT_JSON" "$TOOLS_HASH" || FAILED=1
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
