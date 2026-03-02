#!/usr/bin/env bash
# Run openclaw CLI commands on the VPS via SSH
#
# Usage:
#   scripts/openclaw.sh <command> [args...]              # auto-detect instance
#   scripts/openclaw.sh --instance test-claw <command>   # target specific instance
#
# Examples:
#   scripts/openclaw.sh status
#   scripts/openclaw.sh doctor --deep
#   scripts/openclaw.sh security audit --deep
#   scripts/openclaw.sh devices list
#   scripts/openclaw.sh --instance test-claw health

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# Extract --instance before passing remaining args to openclaw
INSTANCE_ARGS=()
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    *) REMAINING_ARGS+=("$1"); shift ;;
  esac
done

if [[ ${#REMAINING_ARGS[@]} -eq 0 ]]; then
  echo "Usage: $(basename "$0") [--instance <name>] <command> [args...]" >&2
  echo "Runs 'openclaw <command>' on the VPS via SSH." >&2
  exit 1
fi

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1
INSTANCE_NAME="${GATEWAY#openclaw-}"

TERM=xterm-256color ssh -t -i "${ENV__SSH_KEY}" -p "${ENV__SSH_PORT}" "${ENV__SSH_USER}@${ENV__VPS_IP}" \
  "openclaw --instance $INSTANCE_NAME ${REMAINING_ARGS[*]}"
