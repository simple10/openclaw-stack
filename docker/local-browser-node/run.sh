#!/bin/bash
# Wrapper for docker compose that resolves config from the stack.
# Usage: ./run.sh up --build              # Kasm desktop (visible browser)
#        ./run.sh --profile headless up --build  # Headless (no GUI)
#        ./run.sh logs -f
#        ./run.sh down
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/../../deploy/host/source-config.sh"

# Resolve claw name → uppercase key (personal-claw → PERSONAL_CLAW)
CLAW="${LOCAL_BROWSER_NODE_CLAW:?Set LOCAL_BROWSER_NODE_CLAW in .env}"
CLAW_UPPER=$(echo "$CLAW" | tr '[:lower:]-' '[:upper:]_')

# Resolve per-claw domain and gateway token
DOMAIN_VAR="STACK__CLAWS__${CLAW_UPPER}__DOMAIN"
TOKEN_VAR="${CLAW_UPPER}_GATEWAY_TOKEN"

export GATEWAY_DOMAIN="${!DOMAIN_VAR:?${DOMAIN_VAR} not found — run npm run pre-deploy}"
export OPENCLAW_GATEWAY_TOKEN="${!TOKEN_VAR:?${TOKEN_VAR} not found in .env}"

# CF Access service token (from .env, optional if not behind CF Access)
export CF_ACCESS_CLIENT_ID="${CF_ACCESS_CLIENT_ID:-}"
export CF_ACCESS_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"

echo "[local-browser-node] Claw: ${CLAW}"
echo "[local-browser-node] Gateway: ${GATEWAY_DOMAIN}"

cd "$SCRIPT_DIR"
exec docker compose "$@"
