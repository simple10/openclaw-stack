#!/bin/bash
set -euo pipefail

# verify-deployment.sh — Verify OpenClaw deployment (playbook 04, verification)
#
# Checks all running claws: sandbox images, binaries, permissions, health.
# Discovers containers and ports dynamically — no hardcoded names or ports.
#
# Interface:
#   Config: sourced from source-config.sh (STACK__STACK__DEFAULTS__DOMAIN_PATH, etc.)
#   Stdout: VERIFY_DEPLOYMENT_OK or VERIFY_DEPLOYMENT_FAILED
#   Stderr: detailed results
#   Exit: 0 all pass, 1 any failure

# Resolve paths via canonical config helper
source "$(cd "$(dirname "$0")" && pwd)/../host/source-config.sh"

DOMAIN_PATH="${STACK__STACK__DEFAULTS__DOMAIN_PATH:-}"
FAILED=0

# Discover running claws
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:-openclaw-stack}"
CLAWS=$(sudo docker ps --format '{{.Names}}' --filter "name=${PROJECT_NAME}-openclaw-" \
  | grep -v 'sbx-' | sort)

if [ -z "$CLAWS" ]; then
  echo "ERROR: No running claw containers found" >&2
  echo "VERIFY_DEPLOYMENT_FAILED"
  exit 1
fi
echo "Verifying claws: $CLAWS" >&2

for CLAW in $CLAWS; do
  echo "" >&2
  echo "=== $CLAW ===" >&2

  # 1. Check sandbox images exist
  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-toolkit:bookworm-slim \
             openclaw-sandbox-browser:bookworm-slim; do
    if sudo docker exec "$CLAW" docker image inspect "$img" > /dev/null 2>&1; then
      echo "  $img: OK" >&2
    else
      echo "  $img: MISSING" >&2
      FAILED=1
    fi
  done

  # 2. Verify USER=1000 on toolkit
  USER_VAL=$(sudo docker exec "$CLAW" docker image inspect \
    openclaw-sandbox-toolkit:bookworm-slim 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null || echo "?")
  if [ "$USER_VAL" = "1000" ]; then
    echo "  toolkit USER: 1000 (OK)" >&2
  else
    echo "  toolkit USER: $USER_VAL (EXPECTED 1000)" >&2
    FAILED=1
  fi

  # 3. Test key binaries in toolkit sandbox
  for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert claude gifgrep; do
    if sudo docker exec "$CLAW" docker run --rm openclaw-sandbox-toolkit:bookworm-slim \
      which "$bin" > /dev/null 2>&1; then
      echo "  toolkit/$bin: OK" >&2
    else
      echo "  toolkit/$bin: MISSING" >&2
      FAILED=1
    fi
  done

  # 4. Image age
  for img in openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
    BUILD_DATE=$(sudo docker exec "$CLAW" docker image inspect "$img" \
      --format '{{index .Config.Labels "openclaw.build-date"}}' 2>/dev/null)
    if [ -n "$BUILD_DATE" ] && [ "$BUILD_DATE" != "<no value>" ]; then
      AGE_DAYS=$(( ( $(date +%s) - $(date -d "$BUILD_DATE" +%s 2>/dev/null || echo 0) ) / 86400 ))
      if [ "$AGE_DAYS" -gt 30 ]; then
        echo "  $img: ${AGE_DAYS} days old — consider rebuilding" >&2
      else
        echo "  $img: ${AGE_DAYS} days old (OK)" >&2
      fi
    fi
  done

  # 5. Fix .openclaw ownership (container-side)
  sudo docker exec "$CLAW" chown -R 1000:1000 /home/node/.openclaw 2>/dev/null
  echo "  .openclaw ownership: fixed" >&2

  # 6. Health endpoint (discover mapped port from docker inspect)
  GW_PORT=$(sudo docker port "$CLAW" 2>/dev/null | grep -oP '0\.0\.0\.0:\K\d+' | head -1 || true)
  if [ -n "$GW_PORT" ]; then
    if curl -sf "http://localhost:${GW_PORT}${DOMAIN_PATH}/" > /dev/null 2>&1; then
      echo "  health (port ${GW_PORT}): OK" >&2
    else
      echo "  health (port ${GW_PORT}): UNREACHABLE" >&2
      # Not fatal — may still be starting
    fi
  fi
done

# 7. Check Vector
if sudo docker ps --format '{{.Names}}' | grep -q 'vector$'; then
  echo "" >&2
  echo "=== Vector ===" >&2
  echo "  status: running" >&2
fi

# 8. Intermediate images check
FIRST_CLAW=$(echo "$CLAWS" | head -1)
if sudo docker exec "$FIRST_CLAW" docker images 2>/dev/null | grep -q base-root; then
  echo "" >&2
  echo "WARNING: intermediate base-root image not cleaned up" >&2
fi

echo "" >&2
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed." >&2
  echo "VERIFY_DEPLOYMENT_OK"
else
  echo "Some checks FAILED — see above." >&2
  echo "VERIFY_DEPLOYMENT_FAILED"
  exit 1
fi
