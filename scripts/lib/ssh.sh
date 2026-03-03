#!/usr/bin/env bash
# ssh.sh — Shared SSH and rsync helpers for scripts/.
# Source this after source-config.sh. Requires ENV__SSH_KEY, ENV__SSH_PORT,
# ENV__SSH_USER, ENV__VPS_IP from stack.env.

SSH_CMD="ssh -i ${ENV__SSH_KEY} -p ${ENV__SSH_PORT} -o StrictHostKeyChecking=accept-new"
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"
INSTALL_DIR="$STACK__STACK__INSTALL_DIR"

# Run rsync with our SSH config and sudo on the remote side.
# Pass additional rsync flags and paths as arguments.
# Set RSYNC_EXTRA before calling to inject flags (e.g., RSYNC_EXTRA="--dry-run").
do_rsync() {
  rsync -avz ${RSYNC_EXTRA:-} \
    -e "${SSH_CMD}" \
    --rsync-path='sudo rsync' \
    "$@"
}
