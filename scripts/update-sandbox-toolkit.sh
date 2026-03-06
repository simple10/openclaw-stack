#!/usr/bin/env bash
# Sync sandbox toolkit files to VPS and rebuild sandbox images — no gateway restart.
#
# Default mode detects new/changed tools and quick-layers them on top of the
# existing toolkit image. Use --full for a complete rebuild of all layers.
#
# Three steps:
#   1. Sync local deploy files to VPS host (bind mounts make them visible in container)
#   2. Regenerate gateway shims for any new tool binaries
#   3. Rebuild sandbox images (quick by default, full with --full)
#
# Usage:
#   scripts/update-sandbox-toolkit.sh                      # sync + shims + detect changes + quick-layer
#   scripts/update-sandbox-toolkit.sh --full               # sync + shims + full rebuild of toolkit layer
#   scripts/update-sandbox-toolkit.sh --full --all         # full rebuild including browser
#   scripts/update-sandbox-toolkit.sh --sync-only          # sync + shims, skip image rebuild
#   scripts/update-sandbox-toolkit.sh --dry-run            # show what would happen
#   scripts/update-sandbox-toolkit.sh --instance test-claw # target specific instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/resolve-gateway.sh"

SYNC_ONLY=false
DRY_RUN=false
ALL=false
FULL=false
INSTANCE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)       ALL=true; shift ;;
    --full)      FULL=true; shift ;;
    --sync-only) SYNC_ONLY=true; shift ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --instance)  INSTANCE_ARGS=(--instance "$2"); shift 2 ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--full] [--all] [--sync-only] [--dry-run] [--instance <name>]"
      echo ""
      echo "Sync sandbox toolkit files to VPS and rebuild sandbox images."
      echo ""
      echo "Default: detect new/changed tools and quick-layer them on the toolkit image."
      echo ""
      echo "Options:"
      echo "  --full             Full rebuild of packages + toolkit layers (slower, proper layer ordering)"
      echo "  --all              Also rebuild browser sandbox image (requires --full)"
      echo "  --sync-only        Sync files + regenerate shims, skip image rebuild"
      echo "  --dry-run          Show what would be synced/rebuilt without executing"
      echo "  --instance <name>  Target a specific OpenClaw instance"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

GATEWAY=$(resolve_gateway ${INSTANCE_ARGS[@]+"${INSTANCE_ARGS[@]}"}) || exit 1
OPENCLAW_STACK_DIR="${STACK__STACK__INSTALL_DIR}/openclaw-stack"

# Files to sync: local path -> VPS host path
# These are bind-mounted into the container via docker-compose.yml volumes
if [ -z "${STACK__STACK__SANDBOX_TOOLKIT:-}" ]; then
  echo "Error: stack.sandbox_toolkit not configured in stack.yml" >&2
  echo "Nothing to sync — sandbox toolkit is disabled for this stack." >&2
  exit 1
fi

SYNC_LOCAL=(
  "$STACK__STACK__SANDBOX_TOOLKIT"
  "deploy/openclaw-stack/parse-toolkit.mjs"
  "deploy/openclaw-stack/rebuild-sandboxes.sh"
)
SYNC_REMOTE=(
  "$OPENCLAW_STACK_DIR/sandbox-toolkit.yaml"
  "$OPENCLAW_STACK_DIR/parse-toolkit.mjs"
  "$OPENCLAW_STACK_DIR/rebuild-sandboxes.sh"
)

printf '\033[32mUpdating sandbox toolkit on %s...\033[0m\n' "$ENV__VPS_IP"

# Check gateway container is running
if ! "${SSH_CMD[@]}" "$VPS" \
  "sudo docker inspect -f '{{.State.Running}}' $GATEWAY 2>/dev/null" | grep -q true; then
  echo "Error: $GATEWAY container is not running on VPS" >&2
  exit 1
fi

# ── Step 1: Sync deploy files ────────────────────────────────────────

STEP=1
TOTAL_STEPS=3
if [ "$SYNC_ONLY" = true ]; then
  TOTAL_STEPS=2
fi

printf '\033[33m[%d/%d] Syncing toolkit files...\033[0m\n' "$STEP" "$TOTAL_STEPS"
for i in "${!SYNC_LOCAL[@]}"; do
  local_file="${SYNC_LOCAL[$i]}"
  local_path="$REPO_ROOT/$local_file"
  remote_path="${SYNC_REMOTE[$i]}"

  if [[ ! -f "$local_path" ]]; then
    echo "  WARNING: $local_file not found locally, skipping" >&2
    continue
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] Would sync $local_file -> $remote_path"
  else
    # Write as openclaw user directly — avoids temp files and permission issues
    cat "$local_path" | "${SSH_CMD[@]}" "$VPS" \
      "sudo -u openclaw tee $remote_path > /dev/null"
    echo "  Synced $local_file"
  fi
done

# ── Step 2: Regenerate gateway shims ─────────────────────────────────

STEP=2
printf '\033[33m[%d/%d] Regenerating gateway shims...\033[0m\n' "$STEP" "$TOTAL_STEPS"

# Reuses the same shim logic from entrypoint-gateway.sh.
# Shims are gateway-only (satisfy preflight checks). Real binaries live in sandbox images.
# Only creates shims for binaries that don't already exist (idempotent).
# Piped via heredoc to avoid quoting issues with sh -c through SSH + docker exec.

if [ "$DRY_RUN" = true ]; then
  echo "  [dry-run] Would regenerate shims via docker exec --user root"
else
  TERM=xterm-256color "${SSH_CMD[@]}" "$VPS" \
    "sudo docker exec -i --user root $GATEWAY sh" << 'SHIM_SCRIPT'
TOOLKIT_CONFIG="/app/openclaw-stack/sandbox-toolkit.yaml"
TOOLKIT_PARSER="/app/openclaw-stack/parse-toolkit.mjs"
if [ ! -f "$TOOLKIT_CONFIG" ] || [ ! -f "$TOOLKIT_PARSER" ]; then
  echo "  WARNING: toolkit files not found in container"
  exit 0
fi
SKILL_BINS="/opt/skill-bins"
mkdir -p "$SKILL_BINS"
TOOLKIT_JSON=$(node "$TOOLKIT_PARSER" "$TOOLKIT_CONFIG")
NEW_SHIMS=0
for bin in $(echo "$TOOLKIT_JSON" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).allBins.join(' ')))"); do
  if [ ! -f "$SKILL_BINS/$bin" ]; then
    cat > "$SKILL_BINS/$bin" << 'SHIM'
#!/bin/sh
# Gateway shim — satisfies preflight check. Real binary is in sandbox image.
echo "ERROR: $(basename "$0") is a gateway shim — run inside sandbox" >&2
exit 1
SHIM
    chmod +x "$SKILL_BINS/$bin"
    NEW_SHIMS=$((NEW_SHIMS + 1))
  fi
done
TOTAL=$(ls "$SKILL_BINS" | wc -l)
# Symlink into /usr/local/bin so they're on default PATH (docker exec, openclaw doctor)
for shim in "$SKILL_BINS"/*; do
  bin_name=$(basename "$shim")
  [ ! -L "/usr/local/bin/$bin_name" ] && ln -sf "$shim" "/usr/local/bin/$bin_name"
done
echo "  $NEW_SHIMS new shims created ($TOTAL total)"
SHIM_SCRIPT
fi

# ── Step 3: Rebuild sandbox images ───────────────────────────────────

if [ "$SYNC_ONLY" = true ]; then
  echo ""
  printf '\033[32mDone. Files synced and shims regenerated (skipped image rebuild).\033[0m\n'
  exit 0
fi

STEP=3
printf '\033[33m[%d/%d] Rebuilding sandbox images...\033[0m\n' "$STEP" "$TOTAL_STEPS"

# Build rebuild flags based on mode
REBUILD_FLAGS=""
if [ "$FULL" = true ]; then
  REBUILD_FLAGS="--force"
  if [ "$ALL" = true ]; then
    REBUILD_FLAGS="$REBUILD_FLAGS --all"
  fi
fi
if [ "$DRY_RUN" = true ]; then
  REBUILD_FLAGS="$REBUILD_FLAGS --dry-run"
fi

if [ "$DRY_RUN" = true ]; then
  TERM=xterm-256color "${SSH_CMD[@]}" "$VPS" \
    "sudo docker exec $GATEWAY /app/openclaw-stack/rebuild-sandboxes.sh $REBUILD_FLAGS"
else
  TERM=xterm-256color "${SSH_CMD[@]}" -t "$VPS" \
    "sudo docker exec $GATEWAY /app/openclaw-stack/rebuild-sandboxes.sh $REBUILD_FLAGS"
fi

echo ""
printf '\033[32mDone. Sandbox toolkit updated.\033[0m\n'

# Skip restart prompt for dry-run or quick mode (new sandboxes auto-pick up the image)
if [ "$DRY_RUN" = true ]; then
  exit 0
fi

if [ "$FULL" = false ]; then
  echo "New sandboxes will automatically use the updated image."
  echo "Run scripts/restart-sandboxes.sh to update running sandboxes."
  exit 0
fi

# Prompt to restart running sandbox containers so they pick up the new images.
# Sandboxes are persistent (scope: "agent") — they keep running old images until removed.
echo ""
printf 'Restart sandbox containers to use the new images? [y/N] '
read -r RESTART_ANSWER
if [[ "$RESTART_ANSWER" =~ ^[Yy]$ ]]; then
  RESTART_FLAGS="--force"
  if [ "$ALL" = true ]; then
    RESTART_FLAGS="$RESTART_FLAGS --all"
  fi
  "$SCRIPT_DIR/restart-sandboxes.sh" $RESTART_FLAGS
else
  echo "Skipped. Running sandboxes still use the old images."
  echo "Run scripts/restart-sandboxes.sh when ready."
fi
