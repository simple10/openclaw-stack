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
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

# Extract --instance before passing remaining args to openclaw
INSTANCE_ARGS=()
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "Error: --instance requires a claw name" >&2; exit 1
      fi
      INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    *) REMAINING_ARGS+=("$1"); shift ;;
  esac
done

if [[ ${#REMAINING_ARGS[@]} -eq 0 ]]; then
  echo "Usage: $(basename "$0") [--instance <name>] <command> [args...]" >&2
  echo "Runs 'openclaw <command>' on the VPS via SSH." >&2
  exit 1
fi

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
INSTANCE_NAME="${GATEWAY#${PROJECT_NAME}-openclaw-}"

TERM=xterm-256color "${SSH_CMD[@]}" -t "$VPS" \
  "openclaw --instance $INSTANCE_NAME ${REMAINING_ARGS[*]}"
