#!/usr/bin/env bash
# Tail the debug-logger log from the VPS (bind-mounted at ~/.openclaw/logs/debug.log)
#
# Usage:
#   scripts/logs-debug.sh              # tail -f (follow new entries)
#   scripts/logs-debug.sh 50           # show last 50 lines then follow
#   scripts/logs-debug.sh --no-follow  # dump all logs and exit
#   scripts/logs-debug.sh --pretty     # pretty-print JSON with jq (follow)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

LOG_FILE="/home/openclaw/.openclaw/logs/debug.log"
TAIL_ARGS=()
PRETTY=false
LINES="50"

for arg in "$@"; do
  case "$arg" in
    --no-follow)
      TAIL_ARGS=() # will use cat instead
      LINES="all"
      ;;
    --pretty)
      PRETTY=true
      ;;
    [0-9]*)
      LINES="$arg"
      ;;
    --help|-h)
      echo "Usage: $(basename "$0") [LINES] [--no-follow] [--pretty]"
      echo ""
      echo "Tail the openclaw debug-logger log on the VPS."
      echo ""
      echo "Options:"
      echo "  LINES        Number of lines to show (default: 50)"
      echo "  --no-follow  Dump all logs and exit"
      echo "  --pretty     Pretty-print JSON output with jq"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

printf '\033[32mStreaming debug log from VPS-1 (%s)\033[0m\n' "$VPS1_IP"

if [[ "$LINES" == "all" ]]; then
  CMD="sudo cat $LOG_FILE"
else
  CMD="sudo tail -n $LINES -f $LOG_FILE"
fi

if [[ "$PRETTY" == true ]]; then
  CMD="$CMD | jq ."
fi

ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" "$CMD"
