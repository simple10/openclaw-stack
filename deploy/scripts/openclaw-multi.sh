#!/bin/bash
set -euo pipefail

# openclaw-multi.sh — Multi-instance OpenClaw management
#
# Discovers instances from deploy/openclaws/*/, generates docker-compose.multi.yml,
# manages per-instance .env vars, and handles lifecycle operations.
#
# Usage: openclaw-multi.sh <command> [args]
#
# Commands:
#   list            Show discovered instances (active + disabled)
#   generate        Produce docker-compose.multi.yml + update .env
#   deploy-config   Template openclaw.json + models.json for one or all instances
#   start           Generate + docker compose up -d
#   stop            Docker compose down
#   status          Show running instance containers
#   tunnel-config   Print Cloudflare tunnel rules for all instances
#     --apply         Apply routes via CF API (requires CF_API_TOKEN)

# Resolve paths relative to the deploy directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
INSTANCES_DIR="${DEPLOY_DIR}/openclaws"
OPENCLAW_HOME="/home/openclaw"

# Port bases for auto-assignment
GATEWAY_PORT_BASE=18789
DASHBOARD_PORT_BASE=6090

# ── Helper Functions ──────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

# Convert instance name to env var prefix: personal-claw -> PERSONAL_CLAW
name_to_prefix() {
  echo "$1" | tr '[:lower:]-' '[:upper:]_'
}

# Discover active instances (dirs without _ prefix)
discover_instances() {
  local names=()
  if [ ! -d "$INSTANCES_DIR" ]; then
    return
  fi
  for dir in "$INSTANCES_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name
    name=$(basename "$dir")
    # Skip disabled instances (underscore prefix)
    [[ "$name" == _* ]] && continue
    # Must have config.env
    [ -f "$dir/config.env" ] || continue
    names+=("$name")
  done
  # Sort for deterministic port assignment
  [ ${#names[@]} -eq 0 ] && return
  printf '%s\n' "${names[@]}" | sort
}

# Discover disabled instances (_ prefix)
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
    names+=("$name")
  done
  [ ${#names[@]} -eq 0 ] && return
  printf '%s\n' "${names[@]}" | sort
}

# Load layered config for an instance: openclaw-config.env -> instance config.env
# Sets variables in the current shell
load_config() {
  local name="$1"
  local config_env="${REPO_ROOT}/openclaw-config.env"
  local instance_config="${INSTANCES_DIR}/${name}/config.env"

  [ -f "$config_env" ] || die "openclaw-config.env not found at ${config_env}"
  [ -f "$instance_config" ] || die "Instance config not found: ${instance_config}"

  # Source defaults, then instance overrides
  set -a
  # shellcheck disable=SC1090
  source "$config_env"
  # shellcheck disable=SC1090
  source "$instance_config"
  set +a
}

# Assign ports to instances (base + alphabetical index)
# Outputs: name gateway_port dashboard_port (one per line)
assign_ports() {
  local instances=("$@")
  local idx=0
  for name in "${instances[@]}"; do
    # Load instance config to check for explicit port assignments
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
  echo "=== Active Instances ==="
  local instances
  mapfile -t instances < <(discover_instances)

  if [ ${#instances[@]} -eq 0 ]; then
    echo "  (none — create dirs in deploy/openclaws/)"
    echo ""
    echo "=== Disabled Instances ==="
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
    echo "  ${name}"
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

  echo "=== Disabled Instances ==="
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
  [ ${#instances[@]} -gt 0 ] || die "No active instances found in ${INSTANCES_DIR}/"

  local compose_file="${OPENCLAW_HOME}/openclaw/docker-compose.multi.yml"
  local env_file="${OPENCLAW_HOME}/openclaw/.env"

  echo "Generating multi-instance configuration for ${#instances[@]} instance(s)..." >&2

  # Get port assignments
  local port_info
  port_info=$(assign_ports "${instances[@]}")

  # ── Generate docker-compose.multi.yml ──
  local compose_content
  compose_content=$(generate_compose "$port_info")
  echo "$compose_content" | sudo -u openclaw tee "$compose_file" > /dev/null
  echo "Generated ${compose_file}" >&2

  # ── Update .env with per-instance vars ──
  generate_env "$port_info"
  echo "Updated ${env_file}" >&2

  echo ""
  echo "Next steps:" >&2
  echo "  1. Run: openclaw-multi.sh deploy-config" >&2
  echo "  2. Run: openclaw-multi.sh start" >&2
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

  # Generate per-instance service
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
      - /home/openclaw/sandboxes-home/${name}:/home/node/sandboxes-home
      - ./data/${name}/docker:/var/lib/docker
      - ./deploy:/app/deploy:ro
      - /home/openclaw/.openclaw/instances/${name}:/home/node/.openclaw
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
  # Disable upstream single-instance services when using multi-instance mode
  openclaw-gateway:
    profiles: [single-instance]
  openclaw-cli:
    profiles: [openclaw-cli]

networks:
  openclaw-gateway-net:
    external: true
FOOTER
}

generate_env() {
  local port_info="$1"
  local env_file="${OPENCLAW_HOME}/openclaw/.env"

  # Read existing .env to preserve shared vars
  local existing=""
  [ -f "$env_file" ] && existing=$(cat "$env_file")

  # Start with shared vars from existing .env (everything before per-instance section)
  local shared_section
  shared_section=$(echo "$existing" | sed '/^# ── Per-Instance/,$d')

  # Build the per-instance section
  local instance_section=""
  instance_section+=$'\n'"# ── Per-Instance Variables (auto-generated by openclaw-multi.sh) ──"$'\n'

  while IFS=' ' read -r name gw_port dash_port; do
    local prefix
    prefix=$(name_to_prefix "$name")

    # Load instance config to get overrides
    local instance_config="${INSTANCES_DIR}/${name}/config.env"

    instance_section+=$'\n'"# Instance: ${name}"$'\n'

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

  # Write combined .env (pre-create with correct permissions to avoid TOCTOU)
  sudo -u openclaw touch "$env_file"
  sudo chmod 600 "$env_file"
  {
    echo "$shared_section"
    echo "$instance_section"
  } | sudo -u openclaw tee "$env_file" > /dev/null
}

cmd_deploy_config() {
  local target_name="${1:-}"
  local instances
  mapfile -t instances < <(discover_instances)
  [ ${#instances[@]} -gt 0 ] || die "No active instances found"

  if [ -n "$target_name" ]; then
    # Deploy config for a single instance
    deploy_instance_config "$target_name"
  else
    # Deploy config for all instances
    for name in "${instances[@]}"; do
      deploy_instance_config "$name"
    done
  fi
}

deploy_instance_config() {
  local name="$1"
  local instance_config="${INSTANCES_DIR}/${name}/config.env"
  [ -f "$instance_config" ] || die "Instance config not found: ${instance_config}"

  local config_dir="${OPENCLAW_HOME}/.openclaw/instances/${name}"

  echo "Deploying config for instance: ${name}" >&2

  # Load layered config
  load_config "$name"

  # Determine openclaw.json source — instance-specific or default
  local json_source="${INSTANCES_DIR}/${name}/openclaw.json"
  if [ ! -f "$json_source" ]; then
    json_source="${DEPLOY_DIR}/openclaw.json"
  fi
  [ -f "$json_source" ] || die "openclaw.json not found at ${json_source}"

  # Generate or use existing GATEWAY_TOKEN
  local token="${GATEWAY_TOKEN:-}"
  if [ -z "$token" ]; then
    token=$(openssl rand -hex 32)
    echo "  Generated GATEWAY_TOKEN for ${name}: ${token}" >&2
  fi

  # Copy and template openclaw.json
  sudo cp "$json_source" "${config_dir}/openclaw.json"

  # Derive URLs
  local llemtry_url="${LOG_WORKER_URL/\/logs/\/llemtry}"
  local events_url="${LOG_WORKER_URL/\/logs/\/events}"

  sudo sed -i \
    -e "s|{{GATEWAY_TOKEN}}|${token}|g" \
    -e "s|{{OPENCLAW_DOMAIN_PATH}}|${OPENCLAW_DOMAIN_PATH:-}|g" \
    -e "s|{{YOUR_TELEGRAM_ID}}|${YOUR_TELEGRAM_ID:-}|g" \
    -e "s|{{OPENCLAW_INSTANCE_ID}}|${OPENCLAW_INSTANCE_ID:-${name}}|g" \
    -e "s|{{VPS_HOSTNAME}}|${VPS_HOSTNAME:-}|g" \
    -e "s|{{ENABLE_EVENTS_LOGGING}}|${ENABLE_EVENTS_LOGGING:-false}|g" \
    -e "s|{{ENABLE_LLEMTRY_LOGGING}}|${ENABLE_LLEMTRY_LOGGING:-false}|g" \
    -e "s|{{EVENTS_URL}}|${events_url}|g" \
    -e "s|{{LLEMTRY_URL}}|${llemtry_url}|g" \
    -e "s|{{LOG_WORKER_TOKEN}}|${LOG_WORKER_TOKEN:-}|g" \
    "${config_dir}/openclaw.json"

  # Verify no unsubstituted placeholders
  if sudo grep -v '^\s*//' "${config_dir}/openclaw.json" | grep -q '{{'; then
    echo "ERROR: Unsubstituted template placeholders in ${config_dir}/openclaw.json:" >&2
    sudo grep -n '{{' "${config_dir}/openclaw.json" | grep -v '^\s*//' >&2
    exit 1
  fi

  sudo chown 1000:1000 "${config_dir}/openclaw.json"
  sudo chmod 600 "${config_dir}/openclaw.json"

  # Deploy per-agent models.json
  for agent in main code skills; do
    sudo mkdir -p "${config_dir}/agents/${agent}/agent"
    sudo cp "${DEPLOY_DIR}/models.json" "${config_dir}/agents/${agent}/agent/models.json"

    sudo sed -i "s|{{AI_GATEWAY_WORKER_URL}}|${AI_GATEWAY_WORKER_URL}|g" \
      "${config_dir}/agents/${agent}/agent/models.json"

    sudo mkdir -p "${config_dir}/agents/${agent}/sessions"
    [ -f "${config_dir}/agents/${agent}/sessions/sessions.json" ] || \
      echo '{}' | sudo tee "${config_dir}/agents/${agent}/sessions/sessions.json" > /dev/null
    sudo chown -R 1000:1000 "${config_dir}/agents/${agent}"
    sudo chmod 600 "${config_dir}/agents/${agent}/agent/models.json"
    sudo chmod 600 "${config_dir}/agents/${agent}/sessions/sessions.json"
  done

  echo "  Deployed openclaw.json + models.json for ${name}" >&2
}

cmd_start() {
  cmd_generate
  echo "Starting multi-instance containers..." >&2
  cd "${OPENCLAW_HOME}/openclaw"
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/openclaw && docker compose -f docker-compose.yml -f docker-compose.multi.yml up -d"
}

cmd_stop() {
  echo "Stopping multi-instance containers..." >&2
  cd "${OPENCLAW_HOME}/openclaw"
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/openclaw && docker compose -f docker-compose.yml -f docker-compose.multi.yml down"
}

cmd_status() {
  echo "=== OpenClaw Instance Status ==="
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

  # Default: print rules (existing behavior)
  # Source config to check for CF_API_TOKEN (for --apply hint)
  local config_env="${REPO_ROOT}/openclaw-config.env"
  if [ -z "${CF_API_TOKEN:-}" ] && [ -f "$config_env" ]; then
    CF_API_TOKEN=$(grep -E '^CF_API_TOKEN=' "$config_env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  fi

  local instances
  mapfile -t instances < <(discover_instances)
  [ ${#instances[@]} -gt 0 ] || die "No active instances found"

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
  echo "| Subdomain | Path | Service | URL |"
  echo "|-----------|------|---------|-----|"

  while IFS=' ' read -r name gw_port dash_port; do
    local instance_config="${INSTANCES_DIR}/${name}/config.env"
    local domain
    domain=$(grep -E '^OPENCLAW_DOMAIN=' "$instance_config" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
    local dash_path
    dash_path=$(grep -E '^OPENCLAW_DASHBOARD_DOMAIN_PATH=' "$instance_config" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)

    if [ -n "$domain" ]; then
      local subdomain
      subdomain=$(echo "$domain" | cut -d. -f1)
      if [ -n "$dash_path" ]; then
        echo "| \`${subdomain}\` | \`${dash_path}/*\` | HTTP | \`localhost:${dash_port}\` |"
      fi
      echo "| \`${subdomain}\` | *(catch-all)* | HTTP | \`localhost:${gw_port}\` |"
    else
      echo "| *(${name} — no OPENCLAW_DOMAIN set)* | | HTTP | \`localhost:${gw_port}\` |"
    fi
  done <<< "$port_info"

  echo ""
  echo "Each instance also needs a Cloudflare Access application for its subdomain."
}

# ── Main ──────────────────────────────────────────────────────────────

usage() {
  cat << 'EOF'
Usage: openclaw-multi.sh <command> [args]

Commands:
  list                    Show discovered instances (active + disabled)
  generate                Produce docker-compose.multi.yml + update .env
  deploy-config [name]    Template openclaw.json + models.json (one or all instances)
  start                   Generate + docker compose up -d
  stop                    Docker compose down
  status                  Show running instance containers
  tunnel-config [--apply] Print Cloudflare tunnel rules (--apply to configure via CF API)

Instance directories: deploy/openclaws/<name>/
  - Active: any name without _ prefix + has config.env
  - Disabled: _ prefix (e.g., _experimental/)
EOF
}

command="${1:-}"
shift || true

case "$command" in
  list)           cmd_list ;;
  generate)       cmd_generate ;;
  deploy-config)  cmd_deploy_config "${1:-}" ;;
  start)          cmd_start ;;
  stop)           cmd_stop ;;
  status)         cmd_status ;;
  tunnel-config)  cmd_tunnel_config "$@" ;;
  -h|--help|"")   usage ;;
  *)              die "Unknown command: ${command}. Run with --help for usage." ;;
esac
