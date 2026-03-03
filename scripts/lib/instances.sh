#!/usr/bin/env bash
# instances.sh — Shared instance list resolution for scripts/.
# Source this after source-config.sh. Requires STACK__CLAWS__IDS from stack.env.

# Resolve an instance list from a --instance argument value.
# Usage: resolve_instance_list "$SYNC_INSTANCE"
#   - "" or "all" → all claws from stack config
#   - "<name>"    → validates name exists, returns just that name
# Sets INSTANCE_LIST (space-separated) or exits on invalid name.
resolve_instance_list() {
  local requested="$1"
  local all_ids="$STACK__CLAWS__IDS"

  if [ -z "$requested" ] || [ "$requested" = "all" ]; then
    INSTANCE_LIST=$(echo "$all_ids" | tr ',' ' ')
  else
    if ! echo ",$all_ids," | grep -q ",${requested},"; then
      echo "Error: Instance '${requested}' not found in stack config." >&2
      echo "  Available: ${all_ids}" >&2
      exit 1
    fi
    INSTANCE_LIST="$requested"
  fi
}
