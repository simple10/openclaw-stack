#!/usr/bin/env bash
# Send a test message to Telegram using openclaw-config.env settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

if [[ -z "${HOSTALERT_TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Error: HOSTALERT_TELEGRAM_BOT_TOKEN is not set in openclaw-config.env" >&2
  exit 1
fi

if [[ -z "${HOSTALERT_TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Error: HOSTALERT_TELEGRAM_CHAT_ID is not set in openclaw-config.env" >&2
  exit 1
fi

MESSAGE="${1:-Test alert from OpenClaw}"

RESPONSE=$(curl -s "https://api.telegram.org/bot${HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${HOSTALERT_TELEGRAM_CHAT_ID}" \
  -d "text=${MESSAGE}")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Message sent successfully."
else
  echo "Failed to send message:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi
