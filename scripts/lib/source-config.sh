#!/usr/bin/env bash
# source-config.sh — Thin wrapper that sources the project's config resolver.
# All scripts/ should source this instead of reaching into deploy/ directly.
# If the config resolver moves, only this file needs updating.

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$_LIB_DIR/../../deploy/host/source-config.sh" "$@"
unset _LIB_DIR
