#!/usr/bin/env bash
# resolve-gateway.sh — Resolve the OpenClaw gateway container name.
# Source this file, then call: GATEWAY=$(resolve_gateway "$@") || exit 1
#
# Resolution order:
#   1. --instance <name> flag (scanned from arguments)
#   2. OPENCLAW_INSTANCE env var
#   3. Auto-detect: list running openclaw-* containers on the VPS;
#      if exactly one, use it; if multiple, show interactive picker;
#      if zero, error with guidance.
#
# Requires ENV__SSH_PORT, ENV__SSH_USER, ENV__VPS_IP (and optionally ENV__SSH_KEY)
# to be set from stack.env.

# shellcheck source=select-claw.sh
source "$(dirname "${BASH_SOURCE[0]}")/select-claw.sh"
# shellcheck source=ssh.sh
source "$(dirname "${BASH_SOURCE[0]}")/ssh.sh"

resolve_gateway() {
  local instance=""
  local args=()

  # Scan arguments for --instance flag, pass the rest through
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance)
        instance="$2"
        shift 2
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  # Fall back to env var
  instance="${instance:-${OPENCLAW_INSTANCE:-}}"

  local project_name="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"

  if [[ -n "$instance" ]]; then
    echo "${project_name}-openclaw-${instance}"
    return 0
  fi

  # Auto-detect: find running claw containers (match -openclaw- substring, exclude sandbox containers)
  local containers
  containers=$("${SSH_CMD[@]}" -o ConnectTimeout=10 -o BatchMode=yes \
    "$VPS" \
    "sudo docker ps --format '{{.Names}}' --filter 'name=openclaw-'" 2>/dev/null \
    | grep -v 'sbx-' \
    || true)

  if [[ -z "$containers" ]]; then
    echo "Error: No OpenClaw gateway containers running on the VPS." >&2
    return 1
  fi

  # Strip project-openclaw- prefix for the picker, then re-add it
  local names
  names=$(echo "$containers" | sed "s/^${project_name}-openclaw-//")

  local selected
  selected=$(select_claw "$names") || return 1
  echo "${project_name}-openclaw-${selected}"
}
