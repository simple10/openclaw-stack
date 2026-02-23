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
  if [[ "$basename" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_ ]]; then
    echo "skip: $basename (already prefixed)"
    continue
  fi

  # Get date from git: first commit that added this file
  date_prefix=$(git log --diff-filter=A --follow --format='%as' -- "$file" | tail -1)
  if [[ -z "$date_prefix" ]]; then
    echo "skip: $basename (not tracked by git)" >&2
    continue
  fi

  new_name="${date_prefix}_${basename}"
  mv "$file" "$dir/$new_name"
  echo "renamed: $basename -> $new_name"
done
