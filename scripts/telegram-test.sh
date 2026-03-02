#!/usr/bin/env bash
# Send a test message to Telegram using stack.env settings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"

if [[ -z "${ENV__HOSTALERT_TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Error: ENV__HOSTALERT_TELEGRAM_BOT_TOKEN is not set in stack.env" >&2
  exit 1
fi

if [[ -z "${ENV__HOSTALERT_TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Error: ENV__HOSTALERT_TELEGRAM_CHAT_ID is not set in stack.env" >&2
  exit 1
fi

MESSAGE="${1:-Test alert from OpenClaw}"

RESPONSE=$(curl -s "https://api.telegram.org/bot${ENV__HOSTALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${ENV__HOSTALERT_TELEGRAM_CHAT_ID}" \
  -d "text=${MESSAGE}")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Message sent successfully."
else
  echo "Failed to send message:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi
