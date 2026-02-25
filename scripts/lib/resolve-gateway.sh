#!/usr/bin/env bash
# resolve-gateway.sh — Resolve the OpenClaw gateway container name.
# Source this file, then call: GATEWAY=$(resolve_gateway "$@") || exit 1
#
# Resolution order:
#   1. --instance <name> flag (scanned from arguments)
#   2. OPENCLAW_INSTANCE env var
#   3. Auto-detect: list running openclaw-* containers on the VPS;
#      if exactly one, use it; if zero or multiple, error with guidance.
#
# Requires SSH_KEY_PATH, SSH_PORT, SSH_USER, VPS1_IP to be set (from openclaw-config.env).

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

  if [[ -n "$instance" ]]; then
    echo "openclaw-${instance}"
    return 0
  fi

  # Auto-detect: find running openclaw-* gateway containers (exclude utility containers)
  local containers
  containers=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -o ConnectTimeout=10 -o BatchMode=yes \
    "${SSH_USER}@${VPS1_IP}" \
    "sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-'" 2>/dev/null \
    | grep -v '^openclaw-cli$' \
    | grep -v '^openclaw-sbx-' \
    || true)

  local count
  count=$(echo "$containers" | grep -c . || true)

  if [[ "$count" -eq 1 ]]; then
    echo "" >&2
    echo "Auto-detected single claw: ${containers#openclaw-}" >&2
    echo "$containers"
    return 0
  elif [[ "$count" -eq 0 ]]; then
    echo "Error: No OpenClaw gateway containers running." >&2
    echo "  Start with: openclaw-multi.sh start" >&2
    return 1
  else
    echo "Error: Multiple OpenClaw gateway containers running. Specify which one:" >&2
    while IFS= read -r c; do
      echo "  --instance ${c#openclaw-}" >&2
    done <<< "$containers"
    return 1
  fi
}
