#!/usr/bin/env bash
# select-claw.sh — Interactive claw picker for multi-claw scripts.
# Source this file, then call: SELECTED=$(select_claw "$LIST") || exit 1
#
# Takes a newline-separated list of claw names on stdin or as $1.
# - 1 item:  auto-selects, prints info to stderr
# - Multiple + interactive terminal: shows numbered menu, reads from /dev/tty
# - Multiple + non-interactive: errors with --instance hints
#
# Returns the selected name on stdout.

select_claw() {
  local names="$1"
  local count
  count=$(echo "$names" | grep -c . || true)

  if [[ "$count" -eq 0 ]]; then
    echo "Error: No claws provided to select from." >&2
    return 1
  fi

  if [[ "$count" -eq 1 ]]; then
    echo "" >&2
    printf '\033[33mAuto-detected single claw: %s\033[0m\n' "$names" >&2
    echo "$names"
    return 0
  fi

  # Multiple claws — need selection
  if [[ -t 0 || -e /dev/tty ]] && [[ -t 2 ]]; then
    # Interactive: show numbered menu, read from /dev/tty
    echo "" >&2
    echo "Multiple claws detected:" >&2
    echo "" >&2
    local i=0
    while IFS= read -r name; do
      i=$((i + 1))
      printf '  \033[2m[%d]\033[0m \033[33m%s\033[0m\n' "$i" "$name" >&2
    done <<< "$names"
    echo "" >&2
    printf 'Select claw [1-%d]: ' "$i" >&2

    local selection
    read -r selection </dev/tty
    if ! [[ "$selection" =~ ^[0-9]+$ ]] || [[ "$selection" -lt 1 ]] || [[ "$selection" -gt "$i" ]]; then
      echo "Invalid selection." >&2
      return 1
    fi
    echo "$names" | sed -n "${selection}p"
    return 0
  fi

  # Non-interactive: error with --instance hints
  echo "Error: Multiple claws detected. Specify which one:" >&2
  while IFS= read -r name; do
    echo "  --instance $name" >&2
  done <<< "$names"
  return 1
}
