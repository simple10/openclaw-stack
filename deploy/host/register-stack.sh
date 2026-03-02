#!/bin/bash
# register-stack.sh — Write stack manifest to /etc/openclaw-stacks/
# Each stack self-registers during deploy so host scripts can discover all stacks.
#
# Usage:
#   register-stack.sh              # Register (default)
#   register-stack.sh --deregister # Remove manifest
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"

MANIFEST_DIR="/etc/openclaw-stacks"
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:?}"
INSTALL_DIR="${STACK__STACK__INSTALL_DIR:?}"
CLAWS="${STACK__CLAWS__IDS:?}"
MANIFEST="${MANIFEST_DIR}/${PROJECT_NAME}.env"

if [[ "${1:-}" == "--deregister" ]]; then
  rm -f "$MANIFEST"
  echo "Deregistered stack: ${PROJECT_NAME}"
  exit 0
fi

mkdir -p "$MANIFEST_DIR"
cat > "$MANIFEST" <<EOF
# Registered by register-stack.sh — $(date -Iseconds)
PROJECT_NAME=${PROJECT_NAME}
INSTALL_DIR=${INSTALL_DIR}
CLAWS=${CLAWS}
EOF
chmod 644 "$MANIFEST"
echo "Registered stack: ${PROJECT_NAME} (${CLAWS})"
