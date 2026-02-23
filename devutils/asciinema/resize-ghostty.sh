#!/usr/bin/env bash
set -euo pipefail

# Requires accessibility controls on a mac

resize_ghostty() {
  local w=${1:-980}
  local h=${2:-520}
  osascript \
    -e "tell application \"System Events\" to tell process \"Ghostty\" to set size of window 1 to {$w, $h}"
}

resize_ghostty_cells() {
  local target_cols=${1:-120}
  local target_rows=${2:-30}
  local cols=$(tput cols)
  local rows=$(tput lines)

  eval $(osascript -e '
  tell application "System Events" to tell process "Ghostty"
    set {w, h} to size of window 1
  end tell
  return "pw=" & w & " ph=" & h')

  local cell_w=$(( pw / cols ))
  local cell_h=$(( ph / rows ))
  local new_w=$(( target_cols * cell_w ))
  local new_h=$(( target_rows * cell_h ))

  osascript -e "tell application \"System Events\" to tell process \"Ghostty\" to set size of window 1 to {$new_w, $new_h}"
}

resize_ghostty_cells 120 30
