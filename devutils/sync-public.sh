#!/usr/bin/env bash
# Merge main into public, removing dirs that shouldn't be in the public repo.
# Usage: ./devutils/sync-public.sh

set -euo pipefail

EXCLUDE_DIRS=(plans devutils cli notes)
SOURCE_BRANCH="main"
TARGET_BRANCH="public"

# Must be on the public branch
current=$(git branch --show-current)
if [[ "$current" != "$TARGET_BRANCH" ]]; then
  echo "Switching to $TARGET_BRANCH..."
  git checkout "$TARGET_BRANCH"
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

# Merge main without committing
echo "Merging $SOURCE_BRANCH into $TARGET_BRANCH..."
if ! git merge "$SOURCE_BRANCH" --no-commit --no-edit 2>/dev/null; then
  echo "Merge conflicts detected. Resolve them, then run this script again."
  exit 1
fi

# Check if the merge brought in anything to clean up
needs_cleanup=false
for dir in "${EXCLUDE_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    needs_cleanup=true
    break
  fi
done

if $needs_cleanup; then
  for dir in "${EXCLUDE_DIRS[@]}"; do
    if [[ -d "$dir" ]]; then
      echo "  Removing $dir/"
      git rm -rf --quiet "$dir"
    fi
  done
  git commit --no-edit -m "Merge $SOURCE_BRANCH into $TARGET_BRANCH (excluding ${EXCLUDE_DIRS[*]})"
else
  # Nothing to clean — let the merge commit through as-is
  git commit --no-edit
fi

echo ""
echo "Done. Review with: git log --oneline -5"
echo "Push with: git push public $TARGET_BRANCH:main"
