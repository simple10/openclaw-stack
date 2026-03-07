#!/usr/bin/env bash
# Tags the current deployment on the VPS as successful.
# Usage: scripts/tag-deploy.sh [message]
#   scripts/tag-deploy.sh "added work claw"
#   scripts/tag-deploy.sh                    # auto-generates timestamp tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/ssh.sh"

MSG="${1:-}"
TAG="deploy-$(date +%Y%m%d-%H%M%S)"

"${SSH_CMD[@]}" "$VPS" "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && \
  git tag -a \"${TAG}\" -m \"${MSG:-successful deploy}\"'"

echo "Tagged: ${TAG}"
echo "View history: ssh ... 'cd ${INSTALL_DIR} && git log --oneline --decorate'"
