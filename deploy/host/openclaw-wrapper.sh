#!/bin/bash
# OpenClaw CLI wrapper — multi-claw aware
# Installed to /usr/local/bin/openclaw by setup/install-cli-wrapper.sh
#
# Resolves target container via:
#   1. --instance <name> flag (explicit, stripped before passing to openclaw)
#   2. Auto-detect: single running container = use it, multiple = interactive picker

# Resolve project name from stack.env (for container name prefix)
# When installed to /usr/local/bin, SCRIPT_DIR won't have source-config.sh,
# so also check the known install dir ({{INSTALL_DIR}} resolved at build time).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/source-config.sh" ]; then
  source "${SCRIPT_DIR}/source-config.sh"
elif [ -f "{{INSTALL_DIR}}/host/source-config.sh" ]; then
  source "{{INSTALL_DIR}}/host/source-config.sh"
fi
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"

CONTAINER=""

# Check --instance flag
if [ "$1" = "--instance" ] && [ -n "$2" ]; then
  CONTAINER="${PROJECT_NAME}-openclaw-$2"
  shift 2
fi

# Auto-detect from running containers
if [ -z "$CONTAINER" ]; then
  RUNNING=$(sudo docker ps --filter "name=openclaw-" --filter "status=running" \
    --format '{{.Names}}' | grep -v 'sbx-' | sort)
  COUNT=$(echo "$RUNNING" | grep -c . || true)

  if [ "$COUNT" -eq 0 ]; then
    echo "No openclaw containers running." >&2
    exit 1
  elif [ "$COUNT" -eq 1 ]; then
    CONTAINER="$RUNNING"
  else
    echo "Multiple openclaw instances running:" >&2
    i=1
    while IFS= read -r name; do
      echo "  $i) $name" >&2
      i=$((i + 1))
    done <<< "$RUNNING"
    printf "Select instance [1-%d]: " "$COUNT" >&2
    read -r choice
    CONTAINER=$(echo "$RUNNING" | sed -n "${choice}p")
    if [ -z "$CONTAINER" ]; then
      echo "Invalid selection." >&2
      exit 1
    fi
  fi
fi

TTY_FLAG=""
[ -t 0 ] && [ -t 1 ] && TTY_FLAG="-it"
exec sudo docker exec $TTY_FLAG --user node "$CONTAINER" openclaw "$@"
