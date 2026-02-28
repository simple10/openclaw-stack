#!/bin/bash
# Build OpenClaw with version-aware auto-patching and .git inclusion for in-container updates.
#
# Flow:
#   1. Resolve OPENCLAW_VERSION → checkout target ref
#   2. Create vps-patch/<version> branch, apply patches, commit
#   3. Include .git in Docker image (comment out .dockerignore exclusion)
#   4. docker build -t $OPENCLAW_IMAGE (stack-scoped tag)
#   5. Restore host to main branch + clean .dockerignore
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   2. Dockerfile: clear build-time jiti cache (belt-and-suspenders with entrypoint §2c)
#   3. .dockerignore: exclude local runtime dirs (data/, deploy/) from build context
#
# Usage: sudo -u openclaw ${INSTALL_DIR}/scripts/build-openclaw.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/../source-config.sh"

OPENCLAW_DIR="${STACK__STACK__INSTALL_DIR}/openclaw"
cd "$OPENCLAW_DIR"

echo "[build] Image tag: ${STACK__STACK__IMAGE}"

# ── Trap: restore host state on failure ──────────────────────────────
# Ensures the host repo is never left on a patch branch or with a
# modified .dockerignore if the build is interrupted.
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

# ── 1. Resolve version ───────────────────────────────────────────────
# TODO: switch fallback to "stable" not "latest"
OPENCLAW_VERSION="${STACK__STACK__OPENCLAW__VERSION:-latest}"
echo "[build] OPENCLAW_VERSION=${STACK__STACK__OPENCLAW__VERSION}"

case "$OPENCLAW_VERSION" in
  ""|"latest")
    # Stay on current branch (main)
    echo "[build] Using current branch (main)"
    TARGET_REF="HEAD"
    ;;
  "stable")
    echo "[build] Fetching tags to find latest stable release..."
    git fetch --tags --force
    # Find latest vYYYY.M.D tag (non-beta, non-rc)
    TARGET_REF=$(git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -1)
    [ -n "$TARGET_REF" ] || { echo "[build] ERROR: No stable version tags found"; exit 1; }
    echo "[build] Latest stable: ${TARGET_REF}"
    git checkout "$TARGET_REF" 2>/dev/null || { echo "[build] ERROR: Could not checkout ${TARGET_REF}"; exit 1; }
    HOST_NEEDS_RESTORE=true
    ;;
  v*)
    echo "[build] Fetching tags for specific version ${STACK__STACK__OPENCLAW__VERSION}..."
    git fetch --tags --force
    TARGET_REF="$OPENCLAW_VERSION"
    git checkout "$TARGET_REF" 2>/dev/null || { echo "[build] ERROR: Tag ${TARGET_REF} not found"; exit 1; }
    HOST_NEEDS_RESTORE=true
    ;;
  *)
    echo "[build] ERROR: Invalid OPENCLAW_VERSION='${STACK__STACK__OPENCLAW__VERSION}'. Use 'stable', 'latest', '', or a tag (e.g., v2026.2.26)"
    exit 1
    ;;
esac

# ── 2. Record resolved version ──────────────────────────────────────
RESOLVED_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "[build] Resolved version: ${RESOLVED_VERSION}"

# ── 3. Create vps-patch branch ──────────────────────────────────────
PATCH_BRANCH="vps-patch/${RESOLVED_VERSION}"
echo "[build] Creating patch branch: ${PATCH_BRANCH}"

# Delete existing patch branch if it exists (rebuild scenario)
git branch -D "$PATCH_BRANCH" 2>/dev/null || true
git checkout -b "$PATCH_BRANCH"
HOST_NEEDS_RESTORE=true

# ── 4. Apply patches ────────────────────────────────────────────────

# 4a. Dockerfile: install Docker + gosu for nested Docker
if ! grep -q "docker.io" Dockerfile; then
  echo "[build] Patching Dockerfile to install Docker + gosu..."
  sed -i '0,/^USER node/{/^USER node/i RUN apt-get update && apt-get install -y --no-install-recommends docker.io gosu gettext-base && usermod -aG docker node && rm -rf /var/lib/apt/lists/*
}' Dockerfile
else
  echo "[build] Docker already in Dockerfile (already patched)"
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

# ── 5. Commit patches to branch ─────────────────────────────────────
# Only stage the specific files that patches touch. git add -A would
# capture host runtime dirs (data/, deploy/, instances/) that exist on
# the VPS but aren't part of upstream — bloating the commit and the
# .git object store that ships inside the container image.
echo "[build] Committing patches to ${PATCH_BRANCH}..."
git add Dockerfile .dockerignore
# Only commit if there are changes (patches may have been no-ops)
if ! git diff --cached --quiet; then
  git commit -m "VPS patches for ${RESOLVED_VERSION}" --no-gpg-sign
else
  echo "[build] No patches needed (all already applied upstream)"
fi

# ── 6. Include .git in Docker image ─────────────────────────────────
# Comment out .git exclusion so COPY --chown=node:node . . picks up .git
if grep -q '^\.git$' .dockerignore; then
  echo "[build] Enabling .git inclusion in Docker image..."
  sed -i 's/^\.git$/#.git  # Commented out by build-openclaw.sh — .git included for in-container updates/' .dockerignore
elif grep -q '^\.git/' .dockerignore; then
  echo "[build] Enabling .git inclusion in Docker image..."
  sed -i 's/^\.git\//#.git\/  # Commented out by build-openclaw.sh/' .dockerignore
else
  echo "[build] .git not excluded in .dockerignore (already enabled)"
fi

# ── 7. Build image ──────────────────────────────────────────────────
echo "[build] Building ${STACK__STACK__IMAGE} (version ${RESOLVED_VERSION})..."
docker build -t "${STACK__STACK__IMAGE}" .

# ── 8. Restore host state ───────────────────────────────────────────
# The image is built and immutable. Restore host to main with clean .dockerignore.
echo "[build] Restoring host to main branch..."
git checkout main -- .dockerignore 2>/dev/null || true
git checkout main 2>/dev/null || true
HOST_NEEDS_RESTORE=false

echo "[build] Done. Built ${STACK__STACK__IMAGE} (version ${RESOLVED_VERSION}) from branch ${PATCH_BRANCH}"
echo "[build] Run: docker compose up -d"
