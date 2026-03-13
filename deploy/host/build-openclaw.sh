#!/bin/bash
# Build OpenClaw images with per-claw version support and host-side patching.
#
# Flow (per unique version specifier):
#   1. Resolve specifier → git ref (stable → latest tag, v2026.X.Y → exact tag, latest → HEAD)
#   2. Checkout target ref, create vps-patch branch, apply patches, commit
#   3. docker build → tag with specifier AND resolved version
#   4. Write resolved version to $INSTALL_DIR/.openclaw-versions/<specifier>
#   5. Restore host to main branch
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   4a. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   4b. Dockerfile: clear build-time jiti cache (belt-and-suspenders with entrypoint §2c)
#   4c. .dockerignore: exclude local runtime dirs (data/, deploy/) from build context
#
# Environment:
#   STACK__OPENCLAW_VERSIONS     — comma-separated unique version specifiers (e.g., "stable,v2026.3.8")
#   STACK__STACK__PROJECT_NAME   — project name for image tag prefix
#   STACK__STACK__INSTALL_DIR    — install directory on VPS
#   BUILD_SPECIFIER              — (optional) build only this specifier (used by auto-update)
#
# Usage: sudo -u openclaw ${INSTALL_DIR}/host/build-openclaw.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/source-config.sh"

OPENCLAW_DIR="${STACK__STACK__INSTALL_DIR}/openclaw"
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
IMAGE_PREFIX="openclaw-${PROJECT_NAME}"
VERSIONS_DIR="${STACK__STACK__INSTALL_DIR}/.openclaw-versions"

cd "$OPENCLAW_DIR"

# Allow building a single specifier (used by auto-update)
if [ -n "${BUILD_SPECIFIER:-}" ]; then
  ALL_VERSIONS="$BUILD_SPECIFIER"
else
  ALL_VERSIONS="${STACK__OPENCLAW_VERSIONS:-stable}"
fi

echo "[build] Image prefix: ${IMAGE_PREFIX}"
echo "[build] Versions to build: ${ALL_VERSIONS}"

# Ensure versions state directory exists
mkdir -p "$VERSIONS_DIR"

# ── Trap: restore host state on failure ──────────────────────────────
HOST_NEEDS_RESTORE=false
cleanup() {
  if [ "$HOST_NEEDS_RESTORE" = true ]; then
    echo "[build] Restoring host to main branch..."
    git checkout main -- .dockerignore 2>/dev/null || true
    git checkout main 2>/dev/null || true
    HOST_NEEDS_RESTORE=false
  fi
}
trap cleanup EXIT

# ── build_version(): build a single version specifier ────────────────
build_version() {
  local SPECIFIER="$1"
  local IMAGE_TAG="${IMAGE_PREFIX}:${SPECIFIER}"

  echo ""
  echo "[build] ════════════════════════════════════════════════════════"
  echo "[build] Building: ${IMAGE_TAG}"
  echo "[build] ════════════════════════════════════════════════════════"

  # ── 1. Resolve specifier → git ref ──────────────────────────────
  case "$SPECIFIER" in
    ""|"latest")
      echo "[build] Using current branch (main)"
      # Ensure we're on main first
      git checkout main 2>/dev/null || true
      HOST_NEEDS_RESTORE=false
      ;;
    "stable")
      echo "[build] Fetching tags to find latest stable release..."
      git fetch --tags --force
      TARGET_REF=$(git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -1)
      [ -n "$TARGET_REF" ] || { echo "[build] ERROR: No stable version tags found"; return 1; }
      echo "[build] Latest stable: ${TARGET_REF}"
      git checkout "$TARGET_REF" 2>/dev/null || { echo "[build] ERROR: Could not checkout ${TARGET_REF}"; return 1; }
      HOST_NEEDS_RESTORE=true
      ;;
    v*)
      echo "[build] Fetching tags for specific version ${SPECIFIER}..."
      git fetch --tags --force
      TARGET_REF="$SPECIFIER"
      git checkout "$TARGET_REF" 2>/dev/null || { echo "[build] ERROR: Tag ${TARGET_REF} not found"; return 1; }
      HOST_NEEDS_RESTORE=true
      ;;
    *)
      echo "[build] ERROR: Invalid specifier '${SPECIFIER}'. Use 'stable', 'latest', or a tag (e.g., v2026.2.26)"
      return 1
      ;;
  esac

  # ── 2. Record resolved version ───────────────────────────────────
  local RESOLVED_VERSION
  RESOLVED_VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "unknown")
  echo "[build] Resolved version: ${RESOLVED_VERSION}"

  # ── 3. Create vps-patch branch ───────────────────────────────────
  local PATCH_BRANCH="vps-patch/${RESOLVED_VERSION}"
  echo "[build] Creating patch branch: ${PATCH_BRANCH}"
  git branch -D "$PATCH_BRANCH" 2>/dev/null || true
  git checkout -b "$PATCH_BRANCH"
  HOST_NEEDS_RESTORE=true

  # ── 4. Apply patches ─────────────────────────────────────────────

  # 4a. Dockerfile: install Docker + gosu for nested Docker (Sysbox)
  if ! grep -q "gosu" Dockerfile; then
    echo "[build] Patching Dockerfile to install Docker + gosu..."
    sed -i '0,/^USER node/{/^USER node/i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu gettext-base && usermod -aG docker node && rm -rf /var/lib/apt/lists/*
}' Dockerfile
  else
    echo "[build] Docker + gosu already in Dockerfile (already patched)"
  fi

  # 4b. Dockerfile: clear build-time jiti cache
  if ! grep -q 'rm.*tmp/jiti' Dockerfile; then
    echo "[build] Patching Dockerfile: clear jiti cache after build..."
    sed -i '/^RUN pnpm build/a RUN rm -rf /tmp/jiti' Dockerfile
  else
    echo "[build] Dockerfile jiti patch already present"
  fi

  # 4c. .dockerignore: exclude local runtime dirs from build context
  if ! grep -q '^data/' .dockerignore; then
    echo "[build] Patching .dockerignore to exclude data/ and deploy/..."
    printf '\n# Local runtime dirs (not part of upstream)\ndata/\ndeploy/\nscripts/entrypoint-gateway.sh\n' >> .dockerignore
  else
    echo "[build] .dockerignore already excludes data/"
  fi

  # ── 5. Commit patches ────────────────────────────────────────────
  echo "[build] Committing patches to ${PATCH_BRANCH}..."
  git add Dockerfile .dockerignore
  if ! git diff --cached --quiet; then
    git commit -m "VPS patches for ${RESOLVED_VERSION}" --no-gpg-sign
  else
    echo "[build] No patches needed (all already applied upstream)"
  fi

  # ── 6. Build image ───────────────────────────────────────────────
  echo "[build] Building ${IMAGE_TAG} (version ${RESOLVED_VERSION})..."
  docker build -t "${IMAGE_TAG}" .

  # Also tag with resolved version for rollback (e.g., openclaw-stack:v2026.3.12)
  local VERSION_TAG="${IMAGE_PREFIX}:v${RESOLVED_VERSION}"
  if [ "${IMAGE_TAG}" != "${VERSION_TAG}" ]; then
    docker tag "${IMAGE_TAG}" "${VERSION_TAG}"
    echo "[build] Also tagged: ${VERSION_TAG}"
  fi

  # ── 7. Record resolved version ───────────────────────────────────
  echo "${RESOLVED_VERSION}" > "${VERSIONS_DIR}/${SPECIFIER}"
  echo "[build] Recorded version: ${VERSIONS_DIR}/${SPECIFIER} → ${RESOLVED_VERSION}"

  # ── 8. Restore host state ────────────────────────────────────────
  echo "[build] Restoring host to main branch..."
  git checkout main -- .dockerignore 2>/dev/null || true
  git checkout main 2>/dev/null || true
  HOST_NEEDS_RESTORE=false

  echo "[build] Done: ${IMAGE_TAG} (version ${RESOLVED_VERSION})"
}

# ── Main: build each unique version specifier ─────────────────────────

BUILT=0
IFS=',' read -ra VERSIONS <<< "$ALL_VERSIONS"
for SPECIFIER in "${VERSIONS[@]}"; do
  SPECIFIER=$(echo "$SPECIFIER" | tr -d ' ')
  [ -z "$SPECIFIER" ] && continue
  build_version "$SPECIFIER"
  BUILT=$((BUILT + 1))
done

# ── Prune old version-tagged images ───────────────────────────────────
# Keep current + 1 previous per specifier to allow quick rollback.
echo ""
echo "[build] Pruning old images..."
CURRENT_IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${IMAGE_PREFIX}:" | sort)
KEEP_TAGS=""
for SPECIFIER in "${VERSIONS[@]}"; do
  SPECIFIER=$(echo "$SPECIFIER" | tr -d ' ')
  [ -z "$SPECIFIER" ] && continue
  KEEP_TAGS="${KEEP_TAGS} ${IMAGE_PREFIX}:${SPECIFIER}"
  if [ -f "${VERSIONS_DIR}/${SPECIFIER}" ]; then
    RESOLVED=$(cat "${VERSIONS_DIR}/${SPECIFIER}")
    KEEP_TAGS="${KEEP_TAGS} ${IMAGE_PREFIX}:v${RESOLVED}"
  fi
done

# Don't prune images that are currently in use
for IMG in $CURRENT_IMAGES; do
  TAG="${IMG#*:}"
  # Keep specifier tags and their resolved version tags
  KEEP=false
  for KEEP_TAG in $KEEP_TAGS; do
    if [ "$IMG" = "$KEEP_TAG" ]; then
      KEEP=true
      break
    fi
  done
  if [ "$KEEP" = false ]; then
    echo "[build] Removing old image: ${IMG}"
    docker rmi "$IMG" 2>/dev/null || true
  fi
done

echo ""
echo "[build] ════════════════════════════════════════════════════════"
echo "[build] All done. Built ${BUILT} image(s)."
echo "[build] Run: docker compose up -d"
