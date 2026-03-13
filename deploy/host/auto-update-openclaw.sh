#!/bin/bash
# auto-update-openclaw.sh — Daily auto-update check for OpenClaw versions.
#
# For each version specifier in STACK__OPENCLAW_VERSIONS:
#   - Pinned (v*): skip — user explicitly chose this version
#   - stable: fetch tags, compare latest stable tag with recorded version
#   - latest: fetch origin, compare HEAD with recorded version
#
# If any specifier has a newer version available, rebuilds that specifier
# and runs `docker compose up -d` to recreate affected containers.
#
# Gated on STACK__STACK__OPENCLAW__AUTO_UPDATE (must be 'true').
#
# Usage: sudo -u openclaw ${INSTALL_DIR}/host/auto-update-openclaw.sh
#   (typically via cron — see register-cron-jobs.sh § Section 5)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/source-config.sh"

INSTALL_DIR="${STACK__STACK__INSTALL_DIR:?STACK__STACK__INSTALL_DIR not set}"
OPENCLAW_DIR="${INSTALL_DIR}/openclaw"
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
VERSIONS_DIR="${INSTALL_DIR}/.openclaw-versions"
ALL_VERSIONS="${STACK__OPENCLAW_VERSIONS:-stable}"

# Gate on auto_update setting
if [ "${STACK__STACK__OPENCLAW__AUTO_UPDATE:-false}" != "true" ]; then
  echo "[auto-update] Auto-update disabled (STACK__STACK__OPENCLAW__AUTO_UPDATE != true)"
  exit 0
fi

echo "[auto-update] Checking for updates (versions: ${ALL_VERSIONS})..."
echo "[auto-update] $(date -Iseconds)"

cd "$OPENCLAW_DIR"

REBUILD_SPECIFIERS=()

IFS=',' read -ra VERSIONS <<< "$ALL_VERSIONS"
for SPECIFIER in "${VERSIONS[@]}"; do
  SPECIFIER=$(echo "$SPECIFIER" | tr -d ' ')
  [ -z "$SPECIFIER" ] && continue

  case "$SPECIFIER" in
    v*)
      echo "[auto-update] ${SPECIFIER}: pinned version — skipping"
      continue
      ;;
    "stable")
      echo "[auto-update] ${SPECIFIER}: fetching tags..."
      git fetch --tags --force 2>/dev/null
      LATEST_TAG=$(git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -1)
      if [ -z "$LATEST_TAG" ]; then
        echo "[auto-update] ${SPECIFIER}: ERROR — no stable tags found"
        continue
      fi
      # Strip leading 'v' for comparison with recorded version
      LATEST_VERSION="${LATEST_TAG#v}"
      CURRENT_VERSION=""
      if [ -f "${VERSIONS_DIR}/${SPECIFIER}" ]; then
        CURRENT_VERSION=$(cat "${VERSIONS_DIR}/${SPECIFIER}")
      fi
      if [ "$LATEST_VERSION" = "$CURRENT_VERSION" ]; then
        echo "[auto-update] ${SPECIFIER}: already up to date (${CURRENT_VERSION})"
        continue
      fi
      echo "[auto-update] ${SPECIFIER}: update available ${CURRENT_VERSION:-<none>} → ${LATEST_VERSION}"
      REBUILD_SPECIFIERS+=("$SPECIFIER")
      ;;
    "latest"|"")
      echo "[auto-update] ${SPECIFIER}: fetching origin..."
      git fetch origin 2>/dev/null
      REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
      if [ -z "$REMOTE_HEAD" ]; then
        echo "[auto-update] ${SPECIFIER}: ERROR — could not resolve origin/main"
        continue
      fi
      # For 'latest', we compare the package.json version at the remote HEAD
      # against the recorded version. A simple HEAD comparison would rebuild
      # on every unrelated commit.
      REMOTE_VERSION=$(git show origin/main:package.json 2>/dev/null \
        | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null || echo "")
      CURRENT_VERSION=""
      if [ -f "${VERSIONS_DIR}/${SPECIFIER}" ]; then
        CURRENT_VERSION=$(cat "${VERSIONS_DIR}/${SPECIFIER}")
      fi
      if [ "$REMOTE_VERSION" = "$CURRENT_VERSION" ]; then
        echo "[auto-update] ${SPECIFIER}: already up to date (${CURRENT_VERSION})"
        continue
      fi
      echo "[auto-update] ${SPECIFIER}: update available ${CURRENT_VERSION:-<none>} → ${REMOTE_VERSION}"
      REBUILD_SPECIFIERS+=("$SPECIFIER")
      ;;
    *)
      echo "[auto-update] ${SPECIFIER}: unknown specifier type — skipping"
      continue
      ;;
  esac
done

# ── Rebuild if needed ──────────────────────────────────────────────────
if [ ${#REBUILD_SPECIFIERS[@]} -eq 0 ]; then
  echo "[auto-update] All versions up to date. Nothing to do."
  exit 0
fi

echo ""
echo "[auto-update] Rebuilding: ${REBUILD_SPECIFIERS[*]}"

FAILED=()
for SPECIFIER in "${REBUILD_SPECIFIERS[@]}"; do
  echo "[auto-update] Building ${SPECIFIER}..."
  if BUILD_SPECIFIER="$SPECIFIER" "${SCRIPT_DIR}/build-openclaw.sh"; then
    echo "[auto-update] ${SPECIFIER}: build succeeded"
  else
    echo "[auto-update] ${SPECIFIER}: build FAILED"
    FAILED+=("$SPECIFIER")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[auto-update] ERROR: Failed to build: ${FAILED[*]}"
  # Still try to recreate containers for versions that did succeed
fi

# ── Recreate containers ───────────────────────────────────────────────
echo "[auto-update] Recreating containers..."
cd "$INSTALL_DIR"
docker compose up -d

# ── Health check ──────────────────────────────────────────────────────
# Poll container health for up to 5 minutes.
echo "[auto-update] Waiting for containers to become healthy..."
HEALTH_TIMEOUT=300
HEALTH_INTERVAL=15
ELAPSED=0
ALL_HEALTHY=false

while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))

  UNHEALTHY=$(docker compose ps --format json 2>/dev/null \
    | python3 -c "
import json, sys
for line in sys.stdin:
    c = json.loads(line)
    name = c.get('Name', '')
    health = c.get('Health', '')
    if 'openclaw' in name and health not in ('healthy', ''):
        print(name)
" 2>/dev/null || true)

  if [ -z "$UNHEALTHY" ]; then
    ALL_HEALTHY=true
    break
  fi
  echo "[auto-update] Still waiting (${ELAPSED}s)... unhealthy: ${UNHEALTHY}"
done

# ── Notification ──────────────────────────────────────────────────────
CHAT_ID="${ENV__HOSTALERT_TELEGRAM_CHAT_ID:-}"
BOT_TOKEN="${ENV__HOSTALERT_TELEGRAM_BOT_TOKEN:-}"

send_telegram() {
  local MESSAGE="$1"
  if [ -n "$CHAT_ID" ] && [ -n "$BOT_TOKEN" ]; then
    curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$CHAT_ID" \
      -d parse_mode=Markdown \
      -d text="$MESSAGE" \
      -d disable_notification=true \
      >/dev/null 2>&1 || echo "[auto-update] Warning: Telegram notification failed"
  fi
}

# Build summary
SUMMARY="OpenClaw auto-update on *$(hostname)*:\n"
for SPECIFIER in "${REBUILD_SPECIFIERS[@]}"; do
  VERSION="unknown"
  if [ -f "${VERSIONS_DIR}/${SPECIFIER}" ]; then
    VERSION=$(cat "${VERSIONS_DIR}/${SPECIFIER}")
  fi
  # Check if this specifier failed
  IS_FAILED=false
  for F in "${FAILED[@]+"${FAILED[@]}"}"; do
    if [ "$F" = "$SPECIFIER" ]; then
      IS_FAILED=true
      break
    fi
  done
  if [ "$IS_FAILED" = true ]; then
    SUMMARY="${SUMMARY}• \`${SPECIFIER}\` → FAILED\n"
  else
    SUMMARY="${SUMMARY}• \`${SPECIFIER}\` → v${VERSION}\n"
  fi
done

if [ "$ALL_HEALTHY" = true ]; then
  SUMMARY="${SUMMARY}\nAll containers healthy."
  echo "[auto-update] All containers healthy."
else
  SUMMARY="${SUMMARY}\n⚠️ Some containers not healthy after ${HEALTH_TIMEOUT}s."
  echo "[auto-update] WARNING: Some containers not healthy after ${HEALTH_TIMEOUT}s"
fi

send_telegram "$SUMMARY"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[auto-update] Completed with errors."
  exit 1
fi

echo "[auto-update] Update complete."
