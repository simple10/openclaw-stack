#!/bin/bash
set -euo pipefail

# openclaw-multi.sh — Multi-claw OpenClaw management (always-multi architecture)
#
# Every deployment is multi-claw — even if running just one instance (main-claw).
# Discovers claws from deploy/openclaws/*/, generates docker-compose.override.yml,
# manages per-instance .env vars, and handles lifecycle operations.
#
# Usage: openclaw-multi.sh <command> [args]
#
# Commands:
#   list            Show discovered claws (active + disabled)
#   generate        Produce docker-compose.override.yml + update .env
#   start           Generate + docker compose up -d
#   stop            Docker compose down
#   status          Show running claw containers
#   sync-images     Export sandbox images from one claw, load into others
#     --source <name>   Source claw (default: auto-detect first with images)
#     --force           Overwrite even if target already has images
#   tunnel-config   Print Cloudflare tunnel rules for all claws
#     --apply         Apply routes via CF API (requires CF_API_TOKEN)

# Resolve paths relative to the deploy directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
INSTANCES_DIR="${DEPLOY_DIR}/openclaws"
OPENCLAW_HOME="${INSTALL_DIR:-/home/openclaw}"

# Port bases for auto-assignment
GATEWAY_PORT_BASE=18789
DASHBOARD_PORT_BASE=6090

# ── Helper Functions ──────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

# Convert claw name to env var prefix: main-claw -> MAIN_CLAW
name_to_prefix() {
  echo "$1" | tr '[:lower:]-' '[:upper:]_'
}

# Discover active claws (dirs without _ prefix that have config.env)
discover_instances() {
  local names=()
  if [ ! -d "$INSTANCES_DIR" ]; then
    return
  fi
  for dir in "$INSTANCES_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name
    name=$(basename "$dir")
    # Skip disabled/special instances (underscore prefix)
    [[ "$name" == _* ]] && continue
    # Must have config.env
    [ -f "$dir/config.env" ] || continue
    names+=("$name")
  done
  # Sort for deterministic port assignment
  [ ${#names[@]} -eq 0 ] && return
  printf '%s\n' "${names[@]}" | sort
}

# Discover disabled claws (_ prefix, excluding _defaults and _example)
discover_disabled() {
  local names=()
  if [ ! -d "$INSTANCES_DIR" ]; then
    return
  fi
  for dir in "$INSTANCES_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name
    name=$(basename "$dir")
    [[ "$name" == _* ]] || continue
    # Skip internal directories
    [[ "$name" == "_defaults" ]] && continue
    [[ "$name" == "_example" ]] && continue
    names+=("$name")
  done
  [ ${#names[@]} -eq 0 ] && return
  printf '%s\n' "${names[@]}" | sort
}

# Load layered config for a claw: openclaw-config.env -> claw config.env
# Sets variables in the current shell
load_config() {
  local name="$1"
  local config_env="${REPO_ROOT}/openclaw-config.env"
  local instance_config="${INSTANCES_DIR}/${name}/config.env"

  [ -f "$config_env" ] || die "openclaw-config.env not found at ${config_env}"
  [ -f "$instance_config" ] || die "Claw config not found: ${instance_config}"

  # Source defaults, then claw overrides
  set -a
  # shellcheck disable=SC1090
  source "$config_env"
  # shellcheck disable=SC1090
  source "$instance_config"
  set +a
}

# Assign ports to claws (base + alphabetical index)
# Outputs: name gateway_port dashboard_port (one per line)
assign_ports() {
  local instances=("$@")
  local idx=0
  for name in "${instances[@]}"; do
    # Load claw config to check for explicit port assignments
    local gw_port="" dash_port=""
    local instance_config="${INSTANCES_DIR}/${name}/config.env"

    if [ -f "$instance_config" ]; then
      gw_port=$(grep -E '^INSTANCE_GATEWAY_PORT=' "$instance_config" 2>/dev/null | cut -d= -f2 | tr -d ' "' || true)
      dash_port=$(grep -E '^INSTANCE_DASHBOARD_PORT=' "$instance_config" 2>/dev/null | cut -d= -f2 | tr -d ' "' || true)
    fi

    # Auto-assign if empty
    [ -z "$gw_port" ] && gw_port=$((GATEWAY_PORT_BASE + idx))
    [ -z "$dash_port" ] && dash_port=$((DASHBOARD_PORT_BASE + idx))

    echo "${name} ${gw_port} ${dash_port}"
    idx=$((idx + 1))
  done
}

# ── Commands ──────────────────────────────────────────────────────────

cmd_list() {
  echo "=== Active Claws ==="
  local instances
  mapfile -t instances < <(discover_instances)

  if [ ${#instances[@]} -eq 0 ]; then
    echo "  (none — create dirs in deploy/openclaws/)"
    echo ""
    echo "=== Disabled Claws ==="
    local disabled
    mapfile -t disabled < <(discover_disabled)
    if [ ${#disabled[@]} -eq 0 ]; then
      echo "  (none)"
    else
      for name in "${disabled[@]}"; do
        echo "  ${name} (disabled — remove _ prefix to enable)"
      done
    fi
    return
  fi

  # Get port assignments
  local port_info
  port_info=$(assign_ports "${instances[@]}")

  while IFS=' ' read -r name gw_port dash_port; do
    local prefix
    prefix=$(name_to_prefix "$name")
    local container_name="openclaw-${name}"
    echo "  ${name}"
    echo "    Container:      ${container_name}"
    echo "    Gateway port:   ${gw_port}"
    echo "    Dashboard port: ${dash_port}"
    echo "    Env prefix:     ${prefix}_*"

    # Show domain if configured
    local instance_config="${INSTANCES_DIR}/${name}/config.env"
    local domain
    domain=$(grep -E '^OPENCLAW_DOMAIN=' "$instance_config" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
    [ -n "$domain" ] && echo "    Domain:         ${domain}"
    echo ""
  done <<< "$port_info"

  echo "=== Disabled Claws ==="
  local disabled
  mapfile -t disabled < <(discover_disabled)
  if [ ${#disabled[@]} -eq 0 ]; then
    echo "  (none)"
  else
    for name in "${disabled[@]}"; do
      echo "  ${name} (remove _ prefix to enable)"
    done
  fi
}

cmd_generate() {
  local instances
  mapfile -t instances < <(discover_instances)
  [ ${#instances[@]} -gt 0 ] || die "No active claws found in ${INSTANCES_DIR}/"

  local compose_file="${OPENCLAW_HOME}/openclaw/docker-compose.override.yml"
  local env_file="${OPENCLAW_HOME}/openclaw/.env"

  echo "Generating multi-claw configuration for ${#instances[@]} claw(s)..." >&2

  # Get port assignments
  local port_info
  port_info=$(assign_ports "${instances[@]}")

  # ── Generate docker-compose.override.yml ──
  local compose_content
  compose_content=$(generate_compose "$port_info")
  echo "$compose_content" | sudo -u openclaw tee "$compose_file" > /dev/null
  echo "Generated ${compose_file}" >&2

  # ── Update .env with per-instance vars ──
  generate_env "$port_info"
  echo "Updated ${env_file}" >&2

  echo ""
  echo "Next steps:" >&2
  echo "  1. Deploy configs: deploy-config.sh" >&2
  echo "  2. Start:          docker compose up -d" >&2
}

generate_compose() {
  local port_info="$1"

  cat << 'HEADER'
# AUTO-GENERATED by openclaw-multi.sh — do not edit
# Regenerate: openclaw-multi.sh generate

x-openclaw-base: &openclaw-base
  image: openclaw:local
  runtime: sysbox-runc
  read_only: false
  tmpfs:
    - /tmp:size=1G,mode=1777
    - /var/tmp:size=200M,mode=1777
    - /run:size=100M,mode=755
    - /var/log:size=100M,mode=755
  user: "0:0"
  security_opt: [no-new-privileges:true]
  entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
  environment: &base-env
    - NODE_ENV=production
    - TZ=UTC
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "5"
  networks: [openclaw-gateway-net]
  healthcheck:
    test: ["CMD", "curl", "-sf", "http://localhost:18789/"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 300s

services:
HEADER

  # Generate per-claw service
  while IFS=' ' read -r name gw_port dash_port; do
    local prefix
    prefix=$(name_to_prefix "$name")
    local container_name="openclaw-${name}"

    cat << EOF
  ${container_name}:
    <<: *openclaw-base
    container_name: ${container_name}
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--port",
        "${gw_port}",
      ]
    deploy:
      resources:
        limits:
          cpus: "\${${prefix}_CPUS:-\${GATEWAY_CPUS:-6}}"
          memory: "\${${prefix}_MEMORY:-\${GATEWAY_MEMORY:-10.5G}}"
          pids: 1024
        reservations:
          cpus: "2"
          memory: 2G
    ports:
      - "127.0.0.1:${gw_port}:${gw_port}"
      - "127.0.0.1:${dash_port}:6090"
    volumes:
      - ./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
      - ${OPENCLAW_HOME}/instances/${name}/sandboxes-home:/home/node/sandboxes-home
      - ${OPENCLAW_HOME}/instances/${name}/docker:/var/lib/docker
      - ./deploy:/app/deploy:ro
      - ${OPENCLAW_HOME}/instances/${name}/.openclaw:/home/node/.openclaw
    environment:
      - NODE_ENV=production
      - TZ=UTC
      - ANTHROPIC_API_KEY=\${${prefix}_AI_GATEWAY_AUTH_TOKEN:-\${AI_GATEWAY_AUTH_TOKEN}}
      - ANTHROPIC_BASE_URL=\${${prefix}_AI_GATEWAY_WORKER_URL:-\${AI_GATEWAY_WORKER_URL}}
      - OPENAI_API_KEY=\${${prefix}_AI_GATEWAY_AUTH_TOKEN:-\${AI_GATEWAY_AUTH_TOKEN}}
      - OPENAI_BASE_URL=\${${prefix}_AI_GATEWAY_WORKER_URL:-\${AI_GATEWAY_WORKER_URL}}
      - DASHBOARD_BASE_PATH=\${${prefix}_DASHBOARD_BASE_PATH:-}
      - OPENCLAW_DOMAIN_PATH=\${${prefix}_OPENCLAW_DOMAIN_PATH:-}
      - TELEGRAM_BOT_TOKEN=\${${prefix}_TELEGRAM_BOT_TOKEN:-}
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:${gw_port}/"]

EOF
  done <<< "$port_info"

  # Disable upstream single-instance services
  cat << 'FOOTER'
  # Disable upstream services — replaced by per-claw services above
  openclaw-gateway:
    profiles: [disabled]
  openclaw-cli:
    profiles: [disabled]

networks:
  openclaw-gateway-net:
    external: true
FOOTER
}

generate_env() {
  local port_info="$1"
  local env_file="${OPENCLAW_HOME}/openclaw/.env"

  # Build the per-instance section
  local instance_section=""
  instance_section+="# ── Per-Instance Variables (auto-generated by openclaw-multi.sh) ──"$'\n'

  while IFS=' ' read -r name gw_port dash_port; do
    local prefix
    prefix=$(name_to_prefix "$name")

    # Load instance config to get overrides
    local instance_config="${INSTANCES_DIR}/${name}/config.env"

    instance_section+=$'\n'"# Claw: ${name}"$'\n'

    # Extract specific vars from instance config
    # Check for key presence (not value emptiness) so explicit empty overrides work
    local var_value
    for var in GATEWAY_CPUS GATEWAY_MEMORY AI_GATEWAY_AUTH_TOKEN AI_GATEWAY_WORKER_URL \
               OPENCLAW_TELEGRAM_BOT_TOKEN OPENCLAW_DASHBOARD_DOMAIN_PATH OPENCLAW_DOMAIN_PATH; do
      if grep -qE "^${var}=" "$instance_config" 2>/dev/null; then
        var_value=$(grep -E "^${var}=" "$instance_config" | cut -d= -f2- || true)
        local target_var="${prefix}_${var}"
        # Map to compose-expected names
        case "$var" in
          GATEWAY_CPUS)    target_var="${prefix}_CPUS" ;;
          GATEWAY_MEMORY)  target_var="${prefix}_MEMORY" ;;
          OPENCLAW_TELEGRAM_BOT_TOKEN) target_var="${prefix}_TELEGRAM_BOT_TOKEN" ;;
          OPENCLAW_DASHBOARD_DOMAIN_PATH) target_var="${prefix}_DASHBOARD_BASE_PATH" ;;
          *) target_var="${prefix}_${var}" ;;
        esac
        instance_section+="${target_var}=${var_value}"$'\n'
      fi
    done
  done <<< "$port_info"

  # Update .env: preserve shared vars (above marker), replace per-instance section
  # Write to temp file then move atomically to avoid partial writes
  local tmp_env
  tmp_env=$(mktemp)

  # Extract shared vars (everything before the per-instance marker)
  # Use sudo test/sed because /home/openclaw is 750 — adminclaw can't traverse without sudo
  if sudo test -f "$env_file"; then
    sudo sed '/^# ── Per-Instance/,$d' "$env_file" > "$tmp_env"
  fi

  # Append per-instance section
  echo "" >> "$tmp_env"
  echo "$instance_section" >> "$tmp_env"

  # Move into place with correct ownership
  sudo cp "$tmp_env" "$env_file"
  sudo chown openclaw:openclaw "$env_file"
  sudo chmod 600 "$env_file"
  rm -f "$tmp_env"
}

cmd_start() {
  cmd_generate
  echo "Starting claw containers..." >&2
  cd "${OPENCLAW_HOME}/openclaw"
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/openclaw && docker compose up -d"
}

cmd_stop() {
  echo "Stopping claw containers..." >&2
  cd "${OPENCLAW_HOME}/openclaw"
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/openclaw && docker compose down"
}

cmd_status() {
  echo "=== OpenClaw Claw Status ==="
  sudo docker ps --filter "name=openclaw-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | \
    grep -v 'openclaw-cli' || echo "  No containers running."
}

cmd_tunnel_config() {
  local apply=false
  local extra_args=()

  # Parse flags
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply)    apply=true; shift ;;
      --instance) extra_args+=(--instance "$2"); shift 2 ;;
      *)          die "Unknown flag for tunnel-config: $1" ;;
    esac
  done

  if [ "$apply" = true ]; then
    # Apply routes via CF API
    local cf_script="${SCRIPT_DIR}/cf-tunnel-setup.sh"
    [ -x "$cf_script" ] || die "cf-tunnel-setup.sh not found at ${cf_script}"
    # Source config to get CF_API_TOKEN if not already in environment
    local config_env="${REPO_ROOT}/openclaw-config.env"
    if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$config_env" ]; then
      set -a; source "$config_env"; set +a
    fi
    [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN required for --apply. Set it in openclaw-config.env or environment."
    exec "$cf_script" setup-routes "${extra_args[@]}"
  fi

  # Default: print rules
  # Source config to check for CF_API_TOKEN (for --apply hint)
  local config_env="${REPO_ROOT}/openclaw-config.env"
  if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$config_env" ]; then
    CF_API_TOKEN=$(grep -E '^CF_API_TOKEN=' "$config_env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  fi

  local instances
  mapfile -t instances < <(discover_instances)
  [ ${#instances[@]} -gt 0 ] || die "No active claws found"

  local port_info
  port_info=$(assign_ports "${instances[@]}")

  echo "=== Cloudflare Tunnel Public Hostname Rules ==="
  echo ""
  echo "Add these routes in: CF Dashboard > Zero Trust > Networks > Tunnels > Configure"
  echo "Order matters — more specific paths first, then catch-all."
  if [ -n "${CF_API_TOKEN:-}" ]; then
    echo ""
    echo "Tip: Run 'openclaw-multi.sh tunnel-config --apply' to configure these automatically via CF API."
  fi
  echo ""
  echo "| Claw | Subdomain | Path | Service | URL |"
  echo "|------|-----------|------|---------|-----|"

  while IFS=' ' read -r name gw_port dash_port; do
    # Load layered config for this claw
    load_config "$name"
    local domain="${OPENCLAW_DOMAIN:-}"
    local dash_path="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"

    if [ -n "$domain" ]; then
      local subdomain
      subdomain=$(echo "$domain" | cut -d. -f1)
      if [ -n "$dash_path" ]; then
        echo "| \`${name}\` | \`${subdomain}\` | \`${dash_path}/*\` | HTTP | \`localhost:${dash_port}\` |"
      fi
      echo "| \`${name}\` | \`${subdomain}\` | *(catch-all)* | HTTP | \`localhost:${gw_port}\` |"
    else
      echo "| \`${name}\` | *(no OPENCLAW_DOMAIN set)* | | HTTP | \`localhost:${gw_port}\` |"
    fi
  done <<< "$port_info"

  echo ""
  echo "Each claw also needs a Cloudflare Access application for its subdomain."
}

cmd_sync_images() {
  local source_name="" force=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --source) source_name="$2"; shift 2 ;;
      --force)  force=true; shift ;;
      *)        die "Unknown flag: $1" ;;
    esac
  done

  # Discover running claw containers
  local running_claws
  mapfile -t running_claws < <(sudo docker ps --format '{{.Names}}' \
    --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' | sort)

  # Discover all configured claws (may include stopped ones)
  local configured_claws
  mapfile -t configured_claws < <(discover_instances)

  # Find source claw
  local source_container=""
  if [ -n "$source_name" ]; then
    source_container="openclaw-${source_name}"
  else
    # Auto-detect: first running claw with sandbox images
    for claw in "${running_claws[@]}"; do
      if sudo docker exec "$claw" docker image inspect \
        openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
        source_container="$claw"
        source_name="${claw#openclaw-}"
        break
      fi
    done
  fi

  [ -n "$source_container" ] || die "No source claw with sandbox images found"

  # Verify source container is actually running
  local source_running=false
  for rc in "${running_claws[@]}"; do
    [ "$rc" = "$source_container" ] && source_running=true && break
  done
  [ "$source_running" = true ] || die "Source container ${source_container} is not running. Start it first: docker compose up -d ${source_container}"

  # Verify source has all 3 sandbox images
  local images=(
    "openclaw-sandbox:bookworm-slim"
    "openclaw-sandbox-toolkit:bookworm-slim"
    "openclaw-sandbox-browser:bookworm-slim"
  )
  for img in "${images[@]}"; do
    sudo docker exec "$source_container" docker image inspect "$img" > /dev/null 2>&1 \
      || die "Source $source_container missing image: $img"
  done

  echo "Source: $source_container" >&2

  # Export images from source's nested Docker
  local export_host_path="${OPENCLAW_HOME}/instances/${source_name}/docker/sandbox-export.tar"
  echo "Exporting sandbox images..." >&2
  sudo docker exec "$source_container" docker save \
    "${images[@]}" -o /var/lib/docker/sandbox-export.tar
  local tar_size
  tar_size=$(sudo du -h "$export_host_path" | cut -f1)
  echo "Exported (${tar_size})" >&2

  # Sync to each target claw
  local synced=0
  for name in "${configured_claws[@]}"; do
    [ "$name" = "$source_name" ] && continue
    local target_container="openclaw-${name}"
    local target_docker_dir="${OPENCLAW_HOME}/instances/${name}/docker"

    # Check if target is running
    local target_running=false
    for rc in "${running_claws[@]}"; do
      [ "$rc" = "$target_container" ] && target_running=true && break
    done

    # Skip if target already has images (unless --force)
    if [ "$target_running" = true ] && [ "$force" = false ]; then
      if sudo docker exec "$target_container" docker image inspect \
        openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
        echo "  $target_container: images already present, skipping (use --force to overwrite)" >&2
        continue
      fi
    fi

    if [ "$target_running" = true ]; then
      # Load directly into running claw's nested Docker
      echo "  $target_container: loading (running)..." >&2
      sudo cp "$export_host_path" "${target_docker_dir}/sandbox-images.tar"
      sudo chown 1000:1000 "${target_docker_dir}/sandbox-images.tar"
      sudo docker exec "$target_container" docker load -i /var/lib/docker/sandbox-images.tar
      sudo rm -f "${target_docker_dir}/sandbox-images.tar"
    else
      # Pre-place tar for entrypoint to load on next start
      echo "  $target_container: pre-placing tar (not running)..." >&2
      sudo cp "$export_host_path" "${target_docker_dir}/sandbox-images.tar"
      sudo chown 1000:1000 "${target_docker_dir}/sandbox-images.tar"
    fi
    synced=$((synced + 1))
  done

  # Cleanup export tar from source
  sudo rm -f "$export_host_path"
  echo "Synced to ${synced} claw(s)." >&2
}

# ── Main ──────────────────────────────────────────────────────────────

usage() {
  cat << 'EOF'
Usage: openclaw-multi.sh <command> [args]

Commands:
  list                    Show discovered claws (active + disabled)
  generate                Produce docker-compose.override.yml + update .env
  start                   Generate + docker compose up -d
  stop                    Docker compose down
  status                  Show running claw containers
  sync-images [opts]      Export sandbox images from one claw, load into others
                            --source <name>  Source claw (default: auto-detect)
                            --force          Overwrite even if target has images
  tunnel-config [--apply] Print Cloudflare tunnel rules (--apply to configure via CF API)

Claw directories: deploy/openclaws/<name>/
  - Active: any name without _ prefix + has config.env
  - Disabled: _ prefix (e.g., _experimental/)
  - Templates: _defaults/ (shared config), _example/ (copy template)
EOF
}

command="${1:-}"
shift || true

case "$command" in
  list)           cmd_list ;;
  generate)       cmd_generate ;;
  start)          cmd_start ;;
  stop)           cmd_stop ;;
  status)         cmd_status ;;
  sync-images)    cmd_sync_images "$@" ;;
  tunnel-config)  cmd_tunnel_config "$@" ;;
  -h|--help|"")   usage ;;
  *)              die "Unknown command: ${command}. Run with --help for usage." ;;
esac
