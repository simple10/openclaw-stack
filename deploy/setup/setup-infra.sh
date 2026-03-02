#!/bin/bash
set -euo pipefail

# setup-infra.sh — OpenClaw infrastructure setup (playbook 04, section 4.2)
#
# Creates per-claw directory structure and clones the OpenClaw repo.
# Docker networks and .env generation are handled by docker-compose.yml
# (rendered by pre-deploy from stack.yml).
#
# Always-multi-claw architecture: every deployment uses the same instance-based layout
# under ${INSTALL_DIR}/instances/<name>/, even if running just one claw.
#
# Interface:
#   Env vars in: INSTANCE_NAMES (space-separated list of claw names)
#   Config: sourced from source-config.sh (STACK__STACK__INSTALL_DIR, etc.)
#   Stdout: SETUP_INFRA_OK
#   Stderr: progress
#   Exit: 0 success, 1 failure

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/../host/source-config.sh"
INSTALL_DIR="$STACK__STACK__INSTALL_DIR"

# INSTANCE_NAMES is required — always-multi-claw means at least "main-claw"
INSTANCE_NAMES="${INSTANCE_NAMES:-main-claw}"

# Part 1: Create Directory Structure (instance-based layout)
# Each claw gets full isolation under ${INSTALL_DIR}/instances/<name>/
# Ensure INSTALL_DIR exists and is owned by openclaw.
# Default /home/openclaw is already correct (created by useradd -m), but custom
# INSTALL_DIR values (e.g. /opt/openclaw) may be root-owned from the staging mkdir.
sudo mkdir -p "$INSTALL_DIR"
sudo chown openclaw:openclaw "$INSTALL_DIR"

sudo -u openclaw bash -s "$INSTALL_DIR" << 'DIREOF'
set -euo pipefail
OPENCLAW_HOME="$1"

# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in Part 2
# Deploy directories (openclaw-stack/, host/, setup/, vector/) are created by rsync from .deploy/
mkdir -p "${OPENCLAW_HOME}/instances"
DIREOF

for inst_name in $INSTANCE_NAMES; do
  # Pass inst_name and INSTALL_DIR as arguments (not heredoc interpolation) to prevent shell injection
  sudo -u openclaw bash -s "$inst_name" "$INSTALL_DIR" << 'INSTEOF'
set -euo pipefail
inst_name="$1"
OPENCLAW_HOME="$2"
INST_DIR="${OPENCLAW_HOME}/instances/${inst_name}"

mkdir -p "${INST_DIR}/.openclaw/workspace"
mkdir -p "${INST_DIR}/.openclaw/credentials"
mkdir -p "${INST_DIR}/.openclaw/logs"
mkdir -p "${INST_DIR}/.openclaw/backups"
mkdir -p "${INST_DIR}/docker"

chmod 700 "${INST_DIR}/.openclaw"
chmod 700 "${INST_DIR}/.openclaw/credentials"
INSTEOF

  # Do NOT change 1000:1000 to openclaw:openclaw!
  # The container runs as uid 1000 (node user inside Docker), which is typically
  # 'ubuntu' on the host — NOT the openclaw user (uid 1002). Using the openclaw
  # UID breaks container write access to these directories.
  sudo chown -R 1000:1000 "${INSTALL_DIR}/instances/${inst_name}/.openclaw"

  # Host status directory — written by root cron scripts, read by agents via workspace
  # Lives under workspace/ so agents can read via relative path (host-status/health.json)
  # Root-owned with 755/644 permissions so both root can write and container can read
  sudo mkdir -p "${INSTALL_DIR}/instances/${inst_name}/.openclaw/workspace/host-status"
  sudo chmod 755 "${INSTALL_DIR}/instances/${inst_name}/.openclaw/workspace/host-status"

  echo "  Created directories for claw: ${inst_name}" >&2
done

echo "Directory structure created." >&2

# Part 1b: Initialize deploy tracking repo
# Tracks deploy-managed config at INSTALL_DIR with git, enabling diff review
# and rollback. The .gitignore (synced by sync-deploy.sh) excludes runtime data.
sudo -u openclaw bash -s "$INSTALL_DIR" << 'GITEOF'
set -euo pipefail
cd "$1"
if [ ! -d .git ]; then
  git init -b main
  git config user.email "openclaw@localhost"
  git config user.name "openclaw-deploy"
  # .gitignore is synced by sync-deploy.sh; if present, commit it
  if [ -f .gitignore ]; then
    git add .gitignore
    git commit -m "init: deploy tracking"
  fi
fi
GITEOF

echo "Deploy tracking repo initialized." >&2

# Part 2: Clone OpenClaw Repository
OPENCLAW_SOURCE="${STACK__STACK__OPENCLAW__SOURCE:-https://github.com/openclaw/openclaw.git}"
sudo -u openclaw bash -s "$INSTALL_DIR" "$OPENCLAW_SOURCE" << 'CLONEEOF'
set -euo pipefail
cd "$1"
git clone "$2" openclaw
CLONEEOF

echo "Repository cloned." >&2

# Part 3: Install OpenClaw CLI host wrapper
# Copies the wrapper to /usr/local/bin/openclaw so adminclaw can run
# `openclaw <cmd>` without docker exec boilerplate.
# The wrapper auto-detects the target container or accepts --instance <name>.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo cp "${SCRIPT_DIR}/../host/openclaw-wrapper.sh" /usr/local/bin/openclaw
sudo chmod +x /usr/local/bin/openclaw
echo "Installed /usr/local/bin/openclaw CLI wrapper." >&2

echo "SETUP_INFRA_OK"
