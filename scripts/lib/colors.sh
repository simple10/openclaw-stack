#!/usr/bin/env bash
# colors.sh — Shared color output helpers for scripts/.
# Source this after source-config.sh. Not used by deploy/host/ scripts
# (those run as cron jobs where color output is irrelevant).

info()    { echo -e "\033[36m→ $1\033[0m"; }
success() { echo -e "\033[32m✓ $1\033[0m"; }
warn()    { echo -e "\033[33m! $1\033[0m"; }
err()     { echo -e "\033[31m✗ $1\033[0m"; }
header()  { echo -e "\n\033[1;34m── $1 ──\033[0m"; }
