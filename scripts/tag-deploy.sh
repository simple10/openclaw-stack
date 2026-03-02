#!/usr/bin/env bash
# Tags the current deployment on the VPS as successful.
# Usage: scripts/tag-deploy.sh [message]
#   scripts/tag-deploy.sh "added work claw"
#   scripts/tag-deploy.sh                    # auto-generates timestamp tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"
INSTALL_DIR="$STACK__STACK__INSTALL_DIR"

MSG="${1:-}"
TAG="deploy-$(date +%Y%m%d-%H%M%S)"

${SSH_CMD} "${VPS}" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && \
  git tag -a \"${TAG}\" -m \"${MSG:-successful deploy}\"'"

echo "Tagged: ${TAG}"
echo "View history: ssh ... 'cd ${INSTALL_DIR} && git log --oneline --decorate'"
