#!/usr/bin/env bash
# ssh.sh — Shared SSH helpers for scripts/.
# Source this after source-config.sh. SSH_KEY is optional: if unset, ssh/scp
# fall back to the user's normal SSH config and agent behavior.

SSH_ARGS=(-p "${ENV__SSH_PORT}" -o StrictHostKeyChecking=accept-new)
if [ -n "${ENV__SSH_KEY:-}" ]; then
  SSH_ARGS=(-i "${ENV__SSH_KEY}" "${SSH_ARGS[@]}")
fi
if [ -n "${ENV__SSH_IDENTITY_AGENT:-}" ]; then
  SSH_ARGS+=(-o "IdentityAgent=${ENV__SSH_IDENTITY_AGENT}")
fi

SCP_ARGS=(-P "${ENV__SSH_PORT}" -o StrictHostKeyChecking=accept-new)
if [ -n "${ENV__SSH_KEY:-}" ]; then
  SCP_ARGS=(-i "${ENV__SSH_KEY}" "${SCP_ARGS[@]}")
fi
if [ -n "${ENV__SSH_IDENTITY_AGENT:-}" ]; then
  SCP_ARGS+=(-o "IdentityAgent=${ENV__SSH_IDENTITY_AGENT}")
fi

SSH_CMD=(ssh "${SSH_ARGS[@]}")
SSH_RSYNC_CMD=$(printf '%q ' ssh "${SSH_ARGS[@]}")
SSH_RSYNC_CMD=${SSH_RSYNC_CMD% }
VPS="${ENV__SSH_USER}@${ENV__VPS_IP}"
INSTALL_DIR="$STACK__STACK__INSTALL_DIR"

# Run rsync with our SSH config and sudo on the remote side.
# Pass additional rsync flags and paths as arguments.
# Set RSYNC_EXTRA before calling to inject flags (e.g., RSYNC_EXTRA="--dry-run").
do_rsync() {
  rsync -avz ${RSYNC_EXTRA:-} \
    -e "${SSH_RSYNC_CMD}" \
    --rsync-path='sudo rsync' \
    "$@"
}
