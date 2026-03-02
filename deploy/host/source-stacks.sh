#!/bin/bash
# source-stacks.sh — Cross-stack discovery from /etc/openclaw-stacks/ manifests
#
# Functions:
#   all_install_dirs        — prints one INSTALL_DIR per line
#   all_expected_containers — prints "PROJECT-openclaw-CLAW" per line
#
# Safe: reads manifests via grep, no eval/source.

OPENCLAW_STACKS_DIR="/etc/openclaw-stacks"

all_install_dirs() {
  [ -d "$OPENCLAW_STACKS_DIR" ] || return
  for manifest in "$OPENCLAW_STACKS_DIR"/*.env; do
    [ -f "$manifest" ] || continue
    grep '^INSTALL_DIR=' "$manifest" | cut -d= -f2-
  done
}

all_expected_containers() {
  [ -d "$OPENCLAW_STACKS_DIR" ] || return
  for manifest in "$OPENCLAW_STACKS_DIR"/*.env; do
    [ -f "$manifest" ] || continue
    local project claws
    project=$(grep '^PROJECT_NAME=' "$manifest" | cut -d= -f2-)
    claws=$(grep '^CLAWS=' "$manifest" | cut -d= -f2-)
    IFS=',' read -ra claw_list <<< "$claws"
    for claw in "${claw_list[@]}"; do
      echo "${project}-openclaw-${claw}"
    done
  done
}
