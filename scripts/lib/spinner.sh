#!/usr/bin/env bash
# spinner.sh — Background spinner for long-running waits.
#
# Usage:
#   source "$SCRIPT_DIR/lib/spinner.sh"
#   spinner_start "Waiting for something..."
#   do_work
#   spinner_stop
#
# Safe to call spinner_stop from subshells — PID is tracked via a temp file.

_SPINNER_PIDFILE="${TMPDIR:-/tmp}/.spinner.$$.pid"

spinner_start() {
  local msg="${1:-Working...}"
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local dim=$'\033[2m'
  local rst=$'\033[0m'

  (
    i=0
    while true; do
      printf '\r  %s %s%s%s' "${frames[$((i % ${#frames[@]}))]}" "$dim" "$msg" "$rst" >&2
      i=$((i + 1))
      sleep 0.1
    done
  ) &
  echo $! > "$_SPINNER_PIDFILE"
}

spinner_stop() {
  if [ -f "$_SPINNER_PIDFILE" ]; then
    local pid
    pid=$(cat "$_SPINNER_PIDFILE")
    rm -f "$_SPINNER_PIDFILE"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null || true
    printf '\r\033[K' >&2
  fi
}
