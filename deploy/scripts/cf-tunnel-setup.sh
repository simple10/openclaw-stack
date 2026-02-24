#!/bin/bash
set -euo pipefail

# cf-tunnel-setup.sh — Automated Cloudflare Tunnel configuration via API
#
# Always-multi-claw: discovers all claws from deploy/openclaws/*/ and configures
# tunnel ingress + DNS for each. No single-instance fallback.
#
# Uses CF_API_TOKEN to create/manage tunnels, configure ingress routes,
# and create DNS CNAME records. Runs locally (not on VPS).
#
# Usage: cf-tunnel-setup.sh <command> [args]
#
# Commands:
#   verify                    Verify API token has required permissions
#   list-tunnels              List active tunnels in the account
#   create-tunnel <name>      Create a new tunnel, output tunnel ID + token
#   get-token <tunnel-id>     Get the connector install token for a tunnel
#   setup-routes              Configure tunnel ingress + DNS for all claws
#     --instance <name>       Configure routes for a single claw only
#     --tunnel-id <id>        Override tunnel ID (otherwise extracted from CF_TUNNEL_TOKEN)
#
# Environment:
#   CF_API_TOKEN              Required — Cloudflare API token with Tunnel Edit + DNS Edit
#   CF_TUNNEL_TOKEN           Optional — used to extract tunnel ID if --tunnel-id not given

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
INSTANCES_DIR="${DEPLOY_DIR}/openclaws"

CF_API_BASE="https://api.cloudflare.com/client/v4"

# ── Helper Functions ──────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "  $*" >&2; }
header() { echo "=== $* ===" >&2; }

# Make an authenticated CF API request. Args: method endpoint [data]
cf_api() {
  local method="$1" endpoint="$2" data="${3:-}"
  local url="${CF_API_BASE}${endpoint}"
  # -4 forces IPv4 to avoid IPv6 privacy extension issues with IP-filtered API tokens
  local args=(-s -4 -X "$method" -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(-d "$data")

  local response
  response=$(curl "${args[@]}" "$url")

  # Check for API-level success
  local success
  success=$(echo "$response" | jq -r '.success // false')
  if [ "$success" != "true" ]; then
    local errors
    errors=$(echo "$response" | jq -r '.errors[]?.message // empty' 2>/dev/null)
    if [ -n "$errors" ]; then
      echo "CF API error (${method} ${endpoint}): ${errors}" >&2
    else
      echo "CF API error (${method} ${endpoint}): $(echo "$response" | jq -c '.errors // .messages // .')" >&2
    fi
    return 1
  fi

  echo "$response"
}

# Discover account ID (first account)
get_account_id() {
  local resp
  resp=$(cf_api GET "/accounts?per_page=1") || die "Failed to list accounts. Check CF_API_TOKEN."
  echo "$resp" | jq -r '.result[0].id // empty'
}

# Extract root domain from a full domain (e.g., openclaw-dev.example.com -> example.com)
extract_root_domain() {
  local domain="$1"
  echo "$domain" | awk -F. '{print $(NF-1)"."$NF}'
}

# Discover zone ID for a domain
get_zone_id() {
  local root_domain="$1"
  local resp
  resp=$(cf_api GET "/zones?name=${root_domain}&per_page=1") || die "Failed to look up zone for ${root_domain}"
  local zone_id
  zone_id=$(echo "$resp" | jq -r '.result[0].id // empty')
  [ -n "$zone_id" ] || die "No zone found for domain: ${root_domain}. Is it added to your CF account?"
  echo "$zone_id"
}

# Extract tunnel ID from CF_TUNNEL_TOKEN (base64 JWT — tunnel ID is in the JSON payload)
extract_tunnel_id_from_token() {
  local token="$1"
  # CF_TUNNEL_TOKEN is a base64-encoded JSON: {"a":"account_id","t":"tunnel_id","s":"secret"}
  local decoded
  decoded=$(echo "$token" | base64 -d 2>/dev/null) || die "Failed to decode CF_TUNNEL_TOKEN"
  echo "$decoded" | jq -r '.t // empty'
}

# Discover active claws (same logic as openclaw-multi.sh)
discover_instances() {
  [ -d "$INSTANCES_DIR" ] || return
  for dir in "$INSTANCES_DIR"/*/; do
    [ -d "$dir" ] || continue
    local name
    name=$(basename "$dir")
    [[ "$name" == _* ]] && continue
    [ -f "$dir/config.env" ] || continue
    echo "$name"
  done | sort
}

# Get config value from a config file
get_config_val() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '"' || true
}

# Warn about 3rd-level subdomain SSL issues
check_subdomain_depth() {
  local domain="$1" label="$2"
  local dots
  dots=$(echo "$domain" | tr -cd '.' | wc -c | tr -d ' ')
  if [ "$dots" -ge 3 ]; then
    echo "WARNING: ${label} '${domain}' is a 3rd-level subdomain." >&2
    echo "  Cloudflare free SSL only covers *.example.com (2nd-level)." >&2
    echo "  Use a 2nd-level subdomain like openclaw-name.example.com instead." >&2
    echo "  See docs/CLOUDFLARE-TUNNEL.md for details." >&2
    return 1
  fi
  return 0
}

# ── Commands ──────────────────────────────────────────────────────────

cmd_verify() {
  [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set"

  header "Verifying CF API Token Permissions"

  # Test token validity
  local resp
  resp=$(cf_api GET "/user/tokens/verify") || die "Token verification failed — check CF_API_TOKEN value"
  local status
  status=$(echo "$resp" | jq -r '.result.status // "unknown"')

  if [ "$status" != "active" ]; then
    die "Token status: ${status} (expected: active)"
  fi
  info "Token is valid and active"

  # Verify account access
  local account_id
  account_id=$(get_account_id)
  [ -n "$account_id" ] || die "No accounts accessible with this token"
  info "Account ID: ${account_id}"

  # Test tunnel permissions (list tunnels)
  if cf_api GET "/accounts/${account_id}/cfd_tunnel?per_page=1" > /dev/null 2>&1; then
    info "Tunnel permission: OK"
  else
    echo "WARNING: Cannot list tunnels. Token may lack 'Account > Cloudflare Tunnel > Edit' permission." >&2
  fi

  # Test DNS permissions (need a zone to check — use OPENCLAW_DOMAIN if available)
  local config_env="${REPO_ROOT}/openclaw-config.env"
  if [ -f "$config_env" ]; then
    local domain
    domain=$(get_config_val "$config_env" "OPENCLAW_DOMAIN")
    if [ -n "$domain" ] && [[ "$domain" != *"<"* ]]; then
      local root_domain
      root_domain=$(extract_root_domain "$domain")
      if cf_api GET "/zones?name=${root_domain}&per_page=1" > /dev/null 2>&1; then
        info "DNS permission (${root_domain}): OK"
      else
        echo "WARNING: Cannot access zone '${root_domain}'. Token may lack 'Zone > DNS > Edit' permission." >&2
      fi
    fi
  fi

  info "Token verification complete"
}

cmd_list_tunnels() {
  [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set"

  local account_id
  account_id=$(get_account_id)
  [ -n "$account_id" ] || die "No accounts accessible"

  header "Active Cloudflare Tunnels"

  local resp
  resp=$(cf_api GET "/accounts/${account_id}/cfd_tunnel?is_deleted=false&per_page=50") || die "Failed to list tunnels"

  local count
  count=$(echo "$resp" | jq '.result | length')

  if [ "$count" -eq 0 ]; then
    info "(no tunnels found)"
    return
  fi

  echo "$resp" | jq -r '.result[] | "  \(.id)  \(.name)  (\(.status // "unknown"))"'
}

cmd_create_tunnel() {
  local tunnel_name="${1:-}"
  [ -n "$tunnel_name" ] || die "Usage: cf-tunnel-setup.sh create-tunnel <name>"
  [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set"

  local account_id
  account_id=$(get_account_id)
  [ -n "$account_id" ] || die "No accounts accessible"

  header "Creating Tunnel: ${tunnel_name}"

  # Generate a random tunnel secret (32 bytes, base64)
  local tunnel_secret
  tunnel_secret=$(openssl rand -base64 32)

  local data
  data=$(jq -n --arg name "$tunnel_name" --arg secret "$tunnel_secret" \
    '{name: $name, tunnel_secret: $secret, config_src: "cloudflare"}')

  local resp
  resp=$(cf_api POST "/accounts/${account_id}/cfd_tunnel" "$data") || die "Failed to create tunnel"

  local tunnel_id
  tunnel_id=$(echo "$resp" | jq -r '.result.id')
  info "Tunnel created: ${tunnel_id}"
  info "Name: ${tunnel_name}"

  # Fetch the connector token
  local token_resp
  token_resp=$(cf_api GET "/accounts/${account_id}/cfd_tunnel/${tunnel_id}/token") || die "Failed to get tunnel token"
  local tunnel_token
  tunnel_token=$(echo "$token_resp" | jq -r '.result // empty')

  if [ -n "$tunnel_token" ]; then
    info "Tunnel token retrieved"
    # Output structured info for programmatic use
    echo ""
    echo "TUNNEL_ID=${tunnel_id}"
    echo "CF_TUNNEL_TOKEN=${tunnel_token}"
  else
    die "Could not retrieve tunnel token"
  fi
}

cmd_get_token() {
  local tunnel_id="${1:-}"
  [ -n "$tunnel_id" ] || die "Usage: cf-tunnel-setup.sh get-token <tunnel-id>"
  [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set"

  local account_id
  account_id=$(get_account_id)
  [ -n "$account_id" ] || die "No accounts accessible"

  local resp
  resp=$(cf_api GET "/accounts/${account_id}/cfd_tunnel/${tunnel_id}/token") || die "Failed to get tunnel token"
  local token
  token=$(echo "$resp" | jq -r '.result // empty')
  [ -n "$token" ] || die "Empty token returned for tunnel ${tunnel_id}"

  echo "CF_TUNNEL_TOKEN=${token}"
}

cmd_setup_routes() {
  [ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set"

  local target_instance="" tunnel_id_override=""

  # Parse flags
  while [ $# -gt 0 ]; do
    case "$1" in
      --instance)   target_instance="$2"; shift 2 ;;
      --tunnel-id)  tunnel_id_override="$2"; shift 2 ;;
      *)            die "Unknown flag: $1" ;;
    esac
  done

  local config_env="${REPO_ROOT}/openclaw-config.env"
  [ -f "$config_env" ] || die "openclaw-config.env not found"

  # Load shared config
  set -a
  # shellcheck disable=SC1090
  source "$config_env"
  set +a

  local account_id
  account_id=$(get_account_id)
  [ -n "$account_id" ] || die "No accounts accessible"

  # Determine tunnel ID
  local tunnel_id="$tunnel_id_override"
  if [ -z "$tunnel_id" ] && [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    tunnel_id=$(extract_tunnel_id_from_token "$CF_TUNNEL_TOKEN")
  fi
  [ -n "$tunnel_id" ] || die "Cannot determine tunnel ID. Set CF_TUNNEL_TOKEN or use --tunnel-id"

  header "Configuring Tunnel Routes"
  info "Tunnel ID: ${tunnel_id}"

  # Discover claws to configure
  local -a claw_names=()
  if [ -n "$target_instance" ]; then
    claw_names+=("$target_instance")
  else
    local discovered
    discovered=$(discover_instances)
    [ -n "$discovered" ] || die "No active claws found in deploy/openclaws/"
    while IFS= read -r name; do
      claw_names+=("$name")
    done <<< "$discovered"
  fi

  # Collect configs for all claws
  local -A instance_domains=()
  local -A instance_dash_domains=()
  local -A instance_dash_paths=()
  local -A instance_gw_ports=()
  local -A instance_dash_ports=()
  local -A instance_tunnel_ids=()

  local idx=0
  for name in "${claw_names[@]}"; do
    local inst_config="${INSTANCES_DIR}/${name}/config.env"
    [ -f "$inst_config" ] || die "Claw config not found: ${inst_config}"

    # Load layered config (shared + claw-specific)
    set -a
    source "$config_env"
    source "$inst_config"
    set +a

    instance_domains[$name]="${OPENCLAW_DOMAIN:-}"
    instance_dash_domains[$name]="${OPENCLAW_DASHBOARD_DOMAIN:-}"
    instance_dash_paths[$name]="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"

    # Check for explicit port assignments
    local gw_port dash_port
    gw_port=$(get_config_val "$inst_config" "INSTANCE_GATEWAY_PORT")
    dash_port=$(get_config_val "$inst_config" "INSTANCE_DASHBOARD_PORT")
    [ -z "$gw_port" ] && gw_port=$((18789 + idx))
    [ -z "$dash_port" ] && dash_port=$((6090 + idx))
    instance_gw_ports[$name]="$gw_port"
    instance_dash_ports[$name]="$dash_port"

    # Per-claw tunnel override
    local inst_tunnel_token
    inst_tunnel_token=$(get_config_val "$inst_config" "CF_TUNNEL_TOKEN")
    if [ -n "$inst_tunnel_token" ]; then
      instance_tunnel_ids[$name]=$(extract_tunnel_id_from_token "$inst_tunnel_token")
    else
      instance_tunnel_ids[$name]="$tunnel_id"
    fi

    idx=$((idx + 1))
  done

  # Validate domains and warn about SSL depth
  local ssl_warnings=0
  for name in "${claw_names[@]}"; do
    local domain="${instance_domains[$name]}"
    [ -n "$domain" ] || die "Claw '${name}' has no OPENCLAW_DOMAIN configured"
    check_subdomain_depth "$domain" "${name}" || ssl_warnings=$((ssl_warnings + 1))
  done
  if [ "$ssl_warnings" -gt 0 ]; then
    echo "" >&2
    echo "Fix the subdomain depth warnings above before continuing." >&2
    echo "Cloudflare free SSL will NOT work for 3rd-level subdomains." >&2
    exit 1
  fi

  # Group claws by tunnel ID for batch configuration
  local -A tunnel_groups=()
  for name in "${claw_names[@]}"; do
    local tid="${instance_tunnel_ids[$name]}"
    if [ -n "${tunnel_groups[$tid]:-}" ]; then
      tunnel_groups[$tid]+=" ${name}"
    else
      tunnel_groups[$tid]="$name"
    fi
  done

  # Configure each tunnel
  for tid in "${!tunnel_groups[@]}"; do
    # shellcheck disable=SC2086  # Intentional word-splitting: space-separated claw names as separate args
    configure_tunnel_routes "$account_id" "$tid" ${tunnel_groups[$tid]}
  done

  # Create DNS CNAME records
  header "Creating DNS Records"
  local -A processed_domains=()
  for name in "${claw_names[@]}"; do
    local domain="${instance_domains[$name]}"
    local dash_domain="${instance_dash_domains[$name]}"
    local tid="${instance_tunnel_ids[$name]}"

    # Create CNAME for gateway domain
    if [ -z "${processed_domains[$domain]:-}" ]; then
      create_dns_cname "$domain" "$tid"
      processed_domains[$domain]=1
    fi

    # Create CNAME for dashboard domain if different
    if [ -n "$dash_domain" ] && [ "$dash_domain" != "$domain" ]; then
      if [ -z "${processed_domains[$dash_domain]:-}" ]; then
        create_dns_cname "$dash_domain" "$tid"
        processed_domains[$dash_domain]=1
      fi
    fi
  done

  header "Setup Complete"
  echo "" >&2
  echo "Configured routes:" >&2
  for name in "${claw_names[@]}"; do
    local domain="${instance_domains[$name]}"
    local dash_path="${instance_dash_paths[$name]}"
    local gw_port="${instance_gw_ports[$name]}"
    local dash_port="${instance_dash_ports[$name]}"
    if [ -n "$dash_path" ]; then
      echo "  ${name}: ${domain}${dash_path}/* -> localhost:${dash_port} (dashboard)" >&2
    fi
    echo "  ${name}: ${domain} -> localhost:${gw_port} (gateway)" >&2
  done
}

configure_tunnel_routes() {
  local account_id="$1" tid="$2"
  shift 2
  local names=("$@")

  info "Configuring ingress for tunnel ${tid}..."

  # Get existing tunnel config to preserve non-openclaw rules
  local existing_config
  existing_config=$(cf_api GET "/accounts/${account_id}/cfd_tunnel/${tid}/configurations" 2>/dev/null) || true

  # Build the set of domains we're managing (to identify which existing rules to keep)
  local -A managed_domains=()
  for name in "${names[@]}"; do
    managed_domains[${instance_domains[$name]}]=1
    local dash_domain="${instance_dash_domains[$name]}"
    if [ -n "$dash_domain" ]; then
      managed_domains[$dash_domain]=1
    fi
  done

  # Collect existing non-openclaw ingress rules (preserve user's other routes)
  local preserved_rules="[]"
  if [ -n "$existing_config" ]; then
    preserved_rules=$(echo "$existing_config" | jq -c --argjson managed "$(
      printf '%s\n' "${!managed_domains[@]}" | jq -R . | jq -s .
    )" '[.result.config.ingress[]? | select(.hostname != null) | select(.hostname as $h | $managed | index($h) | not)]')
  fi

  # Build new ingress rules for our claws
  # Dashboard paths MUST come before catch-all gateway rules (CF evaluates top-to-bottom)
  local new_rules="[]"

  for name in "${names[@]}"; do
    local domain="${instance_domains[$name]}"
    local dash_domain="${instance_dash_domains[$name]}"
    local dash_path="${instance_dash_paths[$name]}"
    local gw_port="${instance_gw_ports[$name]}"
    local dash_port="${instance_dash_ports[$name]}"

    # Dashboard rule (path-based, must come first)
    if [ -n "$dash_path" ]; then
      # Strip leading slash for CF path matching
      local cf_path="${dash_path#/}"
      local dash_hostname="${dash_domain:-$domain}"
      new_rules=$(echo "$new_rules" | jq -c --arg hostname "$dash_hostname" --arg path "${cf_path}*" --arg service "http://localhost:${dash_port}" \
        '. + [{"hostname": $hostname, "path": $path, "service": $service}]')
    elif [ -n "$dash_domain" ] && [ "$dash_domain" != "$domain" ]; then
      # Separate subdomain for dashboard (no path needed)
      new_rules=$(echo "$new_rules" | jq -c --arg hostname "$dash_domain" --arg service "http://localhost:${dash_port}" \
        '. + [{"hostname": $hostname, "service": $service}]')
    fi

    # Gateway rule (catch-all for the domain)
    new_rules=$(echo "$new_rules" | jq -c --arg hostname "$domain" --arg service "http://localhost:${gw_port}" \
      '. + [{"hostname": $hostname, "service": $service}]')
  done

  # Combine: preserved rules + new rules + catch-all 404
  local all_ingress
  all_ingress=$(jq -n --argjson preserved "$preserved_rules" --argjson new "$new_rules" \
    '$preserved + $new + [{"service": "http_status:404"}]')

  # PUT the full tunnel configuration
  local config_payload
  config_payload=$(jq -n --argjson ingress "$all_ingress" '{"config": {"ingress": $ingress}}')

  cf_api PUT "/accounts/${account_id}/cfd_tunnel/${tid}/configurations" "$config_payload" > /dev/null \
    || die "Failed to update tunnel configuration for ${tid}"

  info "Ingress rules updated for tunnel ${tid} ($(echo "$new_rules" | jq length) rules)"
}

create_dns_cname() {
  local domain="$1" tunnel_id="$2"
  local root_domain
  root_domain=$(extract_root_domain "$domain")

  local zone_id
  zone_id=$(get_zone_id "$root_domain")

  # Check if CNAME already exists
  local existing
  existing=$(cf_api GET "/zones/${zone_id}/dns_records?type=CNAME&name=${domain}" 2>/dev/null) || true

  local existing_count
  existing_count=$(echo "$existing" | jq '.result | length' 2>/dev/null || echo 0)

  if [ "$existing_count" -gt 0 ]; then
    info "DNS CNAME already exists: ${domain} (skipping)"
    return
  fi

  # Create the CNAME record
  local data
  data=$(jq -n --arg name "$domain" --arg content "${tunnel_id}.cfargotunnel.com" \
    '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}')

  cf_api POST "/zones/${zone_id}/dns_records" "$data" > /dev/null \
    || die "Failed to create DNS CNAME for ${domain}"

  info "DNS CNAME created: ${domain} -> ${tunnel_id}.cfargotunnel.com"
}

# ── Main ──────────────────────────────────────────────────────────────

usage() {
  cat << 'EOF'
Usage: cf-tunnel-setup.sh <command> [args]

Commands:
  verify                    Verify API token has required permissions
  list-tunnels              List active tunnels in the account
  create-tunnel <name>      Create a new tunnel, output tunnel ID + token
  get-token <tunnel-id>     Get the connector install token for a tunnel
  setup-routes [flags]      Configure tunnel ingress + DNS for all claws
    --instance <name>         Configure routes for a single claw only
    --tunnel-id <id>          Override tunnel ID (default: extracted from CF_TUNNEL_TOKEN)

Environment:
  CF_API_TOKEN              Required — API token with Tunnel Edit + DNS Edit
  CF_TUNNEL_TOKEN           Optional — used to extract tunnel ID

Required API token permissions:
  Account > Cloudflare Tunnel > Edit
  Zone > DNS > Edit (scoped to your domain's zone)
EOF
}

command="${1:-}"
shift || true

case "$command" in
  verify)         cmd_verify ;;
  list-tunnels)   cmd_list_tunnels ;;
  create-tunnel)  cmd_create_tunnel "${1:-}" ;;
  get-token)      cmd_get_token "${1:-}" ;;
  setup-routes)   cmd_setup_routes "$@" ;;
  -h|--help|"")   usage ;;
  *)              die "Unknown command: ${command}. Run with --help for usage." ;;
esac
