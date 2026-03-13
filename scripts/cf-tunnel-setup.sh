#!/bin/bash
set -euo pipefail

# cf-tunnel-setup.sh — Automated Cloudflare Tunnel configuration via API
#
# Discovers claws from .deploy/stack.json and configures tunnel ingress + DNS
# for each. Uses CF_API_TOKEN to create/manage tunnels, configure ingress
# routes, and create DNS CNAME records. Runs locally (not on VPS).
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
#
# Local dependencies:
#   jq                        Required — install with: brew install jq (macOS) / apt install jq (Linux)

# Resolve paths via canonical config helper
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

CF_API_TOKEN="${ENV__CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
CF_TUNNEL_TOKEN="${ENV__CLOUDFLARE_TUNNEL_TOKEN:-${CF_TUNNEL_TOKEN:-}}"
INSTALL_DIR="${STACK__STACK__INSTALL_DIR:-}"

# stack.json is the source of truth for claw configs
if [ "$OPENCLAW_CONTEXT" = "local" ]; then
  STACK_JSON="${REPO_ROOT}/.deploy/stack.json"
else
  STACK_JSON="$(dirname "$SCRIPT_DIR")/stack.json"
fi
[ -f "$STACK_JSON" ] || { echo "Error: stack.json not found at $STACK_JSON. Run 'npm run pre-deploy'." >&2; exit 1; }

# Project name for Docker DNS container names (e.g. muxxibot-openclaw-personal-claw)
PROJECT_NAME=$(jq -r '.stack.project_name // empty' "$STACK_JSON")
[ -n "$PROJECT_NAME" ] || { echo "Error: stack.project_name not found in $STACK_JSON." >&2; exit 1; }

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

# Discover claws from stack.json
discover_claws() {
  jq -r '.claws | keys[]' "$STACK_JSON" 2>/dev/null | sort
}

# Get claw config value from stack.json
get_claw_val() {
  local claw="$1" key="$2"
  jq -r --arg c "$claw" --arg k "$key" '.claws[$c][$k] // empty' "$STACK_JSON"
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

  # Test DNS permissions — use first claw's domain from stack.json
  local first_claw
  first_claw=$(discover_claws | head -1)
  if [ -n "$first_claw" ]; then
    local domain
    domain=$(get_claw_val "$first_claw" "domain")
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

  # Discover claws from stack.json
  local -a claw_names=()
  if [ -n "$target_instance" ]; then
    claw_names+=("$target_instance")
  else
    local discovered
    discovered=$(discover_claws)
    [ -n "$discovered" ] || die "No claws found in stack.json"
    while IFS= read -r name; do
      claw_names+=("$name")
    done <<< "$discovered"
  fi

  # Collect configs for all claws from stack.json
  local _domains="" _dash_domains="" _dash_paths="" _gw_ports="" _dash_ports="" _tunnel_ids=""

  local idx=0
  for name in "${claw_names[@]}"; do
    local domain dash_path gw_port dash_port
    domain=$(get_claw_val "$name" "domain")
    dash_path=$(get_claw_val "$name" "dashboard_path")

    # Dashboard domain is same as gateway domain (path-based routing)
    _domains="${_domains}${_domains:+$'\n'}${domain}"
    _dash_domains="${_dash_domains}${_dash_domains:+$'\n'}${domain}"
    _dash_paths="${_dash_paths}${_dash_paths:+$'\n'}${dash_path:- }"

    gw_port=$(get_claw_val "$name" "gateway_port")
    dash_port=$(get_claw_val "$name" "dashboard_port")
    [ -z "$gw_port" ] && gw_port=$((18789 + idx))
    [ -z "$dash_port" ] && dash_port=$((6090 + idx))
    _gw_ports="${_gw_ports}${_gw_ports:+$'\n'}${gw_port}"
    _dash_ports="${_dash_ports}${_dash_ports:+$'\n'}${dash_port}"

    _tunnel_ids="${_tunnel_ids}${_tunnel_ids:+$'\n'}${tunnel_id}"

    idx=$((idx + 1))
  done

  # Helper to get nth line (0-indexed) from a newline-separated string
  _nth() { echo "$1" | sed -n "$((${2} + 1))p"; }

  # Validate domains and warn about SSL depth
  local ssl_warnings=0
  idx=0
  for name in "${claw_names[@]}"; do
    local domain
    domain=$(_nth "$_domains" $idx)
    [ -n "$domain" ] || die "Claw '${name}' has no OPENCLAW_DOMAIN configured"
    check_subdomain_depth "$domain" "${name}" || ssl_warnings=$((ssl_warnings + 1))
    idx=$((idx + 1))
  done
  if [ "$ssl_warnings" -gt 0 ]; then
    echo "" >&2
    echo "Fix the subdomain depth warnings above before continuing." >&2
    echo "Cloudflare free SSL will NOT work for 3rd-level subdomains." >&2
    exit 1
  fi

  # Group claws by tunnel ID for batch configuration
  # Build unique tunnel IDs list and their associated claw names
  local unique_tids="" tunnel_groups=""
  idx=0
  for name in "${claw_names[@]}"; do
    local tid
    tid=$(_nth "$_tunnel_ids" $idx)
    if ! echo "$unique_tids" | grep -qF "$tid"; then
      unique_tids="${unique_tids}${unique_tids:+$'\n'}${tid}"
      tunnel_groups="${tunnel_groups}${tunnel_groups:+$'\n'}${tid}=${name}"
    else
      # Append name to existing tunnel group
      tunnel_groups=$(echo "$tunnel_groups" | sed "s|^${tid}=\(.*\)$|${tid}=\1 ${name}|")
    fi
    idx=$((idx + 1))
  done

  # Configure each tunnel
  while IFS='=' read -r tid names_str; do
    [ -n "$tid" ] || continue
    # shellcheck disable=SC2086  # Intentional word-splitting
    configure_tunnel_routes "$account_id" "$tid" $names_str
  done <<< "$tunnel_groups"

  # Create DNS CNAME records
  header "Creating DNS Records"
  local processed_domains=""
  idx=0
  for name in "${claw_names[@]}"; do
    local domain dash_domain tid
    domain=$(_nth "$_domains" $idx)
    dash_domain=$(_nth "$_dash_domains" $idx)
    tid=$(_nth "$_tunnel_ids" $idx)

    # Create CNAME for gateway domain (skip if already processed)
    if ! echo "$processed_domains" | grep -qF "$domain"; then
      create_dns_cname "$domain" "$tid"
      processed_domains="${processed_domains}${processed_domains:+$'\n'}${domain}"
    fi

    # Create CNAME for dashboard domain if different
    if [ -n "$dash_domain" ] && [ "$dash_domain" != "$domain" ]; then
      if ! echo "$processed_domains" | grep -qF "$dash_domain"; then
        create_dns_cname "$dash_domain" "$tid"
        processed_domains="${processed_domains}${processed_domains:+$'\n'}${dash_domain}"
      fi
    fi

    idx=$((idx + 1))
  done

  header "Setup Complete"
  echo "" >&2
  echo "Configured routes:" >&2
  idx=0
  for name in "${claw_names[@]}"; do
    local domain dash_path gw_port dash_port
    domain=$(_nth "$_domains" $idx)
    dash_path=$(_nth "$_dash_paths" $idx)
    gw_port=$(_nth "$_gw_ports" $idx)
    dash_port=$(_nth "$_dash_ports" $idx)
    # Trim placeholder space for empty dash_path
    dash_path=$(echo "$dash_path" | sed 's/^ $//')
    local container="${PROJECT_NAME}-openclaw-${name}"
    if [ -n "$dash_path" ]; then
      echo "  ${name}: ${domain}${dash_path}/* -> ${container}:${dash_port} (dashboard)" >&2
    fi
    echo "  ${name}: ${domain} -> ${container}:${gw_port} (gateway)" >&2
    idx=$((idx + 1))
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

  # Build the set of domains we're managing and collect per-claw config
  # by looking up each claw name's index in the claw_names array
  local managed_domains_list=""
  local ingress_json="[]"

  for name in "${names[@]}"; do
    # Find this claw's index in the claw_names array
    local ci=0
    for cn in "${claw_names[@]}"; do
      [ "$cn" = "$name" ] && break
      ci=$((ci + 1))
    done

    local domain dash_domain dash_path gw_port dash_port
    domain=$(_nth "$_domains" $ci)
    dash_domain=$(_nth "$_dash_domains" $ci)
    dash_path=$(_nth "$_dash_paths" $ci)
    gw_port=$(_nth "$_gw_ports" $ci)
    dash_port=$(_nth "$_dash_ports" $ci)
    # Trim placeholder space for empty dash_path
    dash_path=$(echo "$dash_path" | sed 's/^ $//')

    managed_domains_list="${managed_domains_list}${managed_domains_list:+$'\n'}${domain}"
    [ -n "$dash_domain" ] && managed_domains_list="${managed_domains_list}${managed_domains_list:+$'\n'}${dash_domain}"

    # Docker DNS container name for this claw (cloudflared is on the same bridge network)
    local container="${PROJECT_NAME}-openclaw-${name}"

    # Dashboard rule (path-based, must come first — CF evaluates top-to-bottom)
    if [ -n "$dash_path" ]; then
      local cf_path="${dash_path#/}"
      local dash_hostname="${dash_domain:-$domain}"
      ingress_json=$(echo "$ingress_json" | jq -c --arg hostname "$dash_hostname" --arg path "${cf_path}*" --arg service "http://${container}:${dash_port}" \
        '. + [{"hostname": $hostname, "path": $path, "service": $service}]')
    elif [ -n "$dash_domain" ] && [ "$dash_domain" != "$domain" ]; then
      ingress_json=$(echo "$ingress_json" | jq -c --arg hostname "$dash_domain" --arg service "http://${container}:${dash_port}" \
        '. + [{"hostname": $hostname, "service": $service}]')
    fi

    # Gateway rule (catch-all for the domain)
    ingress_json=$(echo "$ingress_json" | jq -c --arg hostname "$domain" --arg service "http://${container}:${gw_port}" \
      '. + [{"hostname": $hostname, "service": $service}]')
  done

  # Collect existing non-openclaw ingress rules (preserve user's other routes)
  local preserved_rules="[]"
  if [ -n "$existing_config" ]; then
    local managed_json
    managed_json=$(echo "$managed_domains_list" | sort -u | jq -R . | jq -s .)
    preserved_rules=$(echo "$existing_config" | jq -c --argjson managed "$managed_json" \
      '[.result.config.ingress[]? | select(.hostname != null) | select(.hostname as $h | $managed | index($h) | not)]')
  fi

  # Combine: preserved rules + new rules + catch-all 404
  local all_ingress
  all_ingress=$(jq -n --argjson preserved "$preserved_rules" --argjson new "$ingress_json" \
    '$preserved + $new + [{"service": "http_status:404"}]')

  # PUT the full tunnel configuration
  local config_payload
  config_payload=$(jq -n --argjson ingress "$all_ingress" '{"config": {"ingress": $ingress}}')

  cf_api PUT "/accounts/${account_id}/cfd_tunnel/${tid}/configurations" "$config_payload" > /dev/null \
    || die "Failed to update tunnel configuration for ${tid}"

  info "Ingress rules updated for tunnel ${tid} ($(echo "$ingress_json" | jq length) rules)"
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
  Account > Account Settings > Read (needed for /accounts API discovery)
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
