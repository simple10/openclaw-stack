#!/usr/bin/env bash
set -euo pipefail

dir="${1:-.}"

if [[ ! -d "$dir" ]]; then
  echo "Usage: $0 [directory]" >&2
  exit 1
fi

for file in "$dir"/*; do
  [[ -f "$file" ]] || continue

  basename="$(basename "$file")"

  # Skip files already prefixed with a date
  if [[ "$basename" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}- ]]; then
    echo "skip: $basename (already prefixed)"
    continue
  fi

  # Get creation date (macOS: -f '%SB', Linux: --format='%W' with fallback to mtime)
  if [[ "$(uname)" == "Darwin" ]]; then
    date_prefix=$(stat -f '%SB' -t '%Y-%m-%d' "$file")
  else
    birth=$(stat --format='%W' "$file" 2>/dev/null || echo 0)
    if [[ "$birth" == "0" || "$birth" == "-" ]]; then
      # Filesystem doesn't support birth time — fall back to mtime
      date_prefix=$(stat --format='%Y' "$file" | xargs -I{} date -d @{} '+%Y-%m-%d')
    else
      date_prefix=$(date -d @"$birth" '+%Y-%m-%d')
    fi
  fi

  new_name="${date_prefix}-${basename}"
  mv "$file" "$dir/$new_name"
  echo "renamed: $basename -> $new_name"
done
