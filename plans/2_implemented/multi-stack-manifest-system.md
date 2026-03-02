# Plan: Multi-Stack Manifest System for Host Scripts

## Context

Host-level scripts (`host-alert.sh`, `backup.sh`, `session-prune.sh`, `host-maintenance-check.sh`) were written for single-stack use. They source `stack.env` and iterate `${INSTALL_DIR}/instances/*/` — only aware of their own stack. Two immediate bugs:

1. **Broken container grep**: `host-alert.sh:70` greps `^openclaw-` but containers are actually named `${PROJECT_NAME}-openclaw-*` (e.g., `muxxibot-openclaw-personal-claw`). `gateway_ok` is always false.
2. **Single boolean**: `gateway_ok` can't distinguish per-claw status.

The fix: a self-registering manifest system where each stack writes a manifest to `/etc/openclaw-stacks/` during deploy. Host scripts read all manifests for cross-stack discovery.

---

## New Files

### 1. `deploy/host/register-stack.sh`

Self-registering manifest writer. Called by every stack during deploy.

```bash
#!/bin/bash
# Writes stack manifest to /etc/openclaw-stacks/<project-name>.env
# Usage:
#   register-stack.sh              # Register (default)
#   register-stack.sh --deregister # Remove manifest

source "$(cd "$(dirname "$0")" && pwd)/source-config.sh"

MANIFEST_DIR="/etc/openclaw-stacks"
PROJECT_NAME="${STACK__STACK__PROJECT_NAME:?}"
INSTALL_DIR="${STACK__STACK__INSTALL_DIR:?}"
CLAWS="${STACK__CLAWS__IDS:?}"
MANIFEST="${MANIFEST_DIR}/${PROJECT_NAME}.env"

if [[ "${1:-}" == "--deregister" ]]; then
  rm -f "$MANIFEST"
  echo "Deregistered stack: ${PROJECT_NAME}"
  exit 0
fi

mkdir -p "$MANIFEST_DIR"
cat > "$MANIFEST" <<EOF
# Registered by register-stack.sh — $(date -Iseconds)
PROJECT_NAME=${PROJECT_NAME}
INSTALL_DIR=${INSTALL_DIR}
CLAWS=${CLAWS}
EOF
chmod 644 "$MANIFEST"
echo "Registered stack: ${PROJECT_NAME} (${CLAWS})"
```

### 2. `deploy/host/source-stacks.sh`

Shared helper sourced by host scripts for cross-stack discovery. Safe — reads manifests via `grep`, no `eval`/`source`.

```bash
#!/bin/bash
# source-stacks.sh — Cross-stack discovery from /etc/openclaw-stacks/ manifests
#
# Functions:
#   all_install_dirs       — prints one INSTALL_DIR per line
#   all_expected_containers — prints "PROJECT-openclaw-CLAW" per line

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
```

---

## Modified Files

### 3. `deploy/host/host-alert.sh`

**Container check** (lines 66-85): Replace grep-based boolean with per-container status using manifests.

```bash
# Source cross-stack discovery
source "$(cd "$(dirname "$0")" && pwd)/source-stacks.sh"

# Per-container status check
containers_json=""
containers_all_ok=true
if $docker_ok; then
  running=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  restarting=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | awk '/Restarting/ {print $1}' || true)

  while IFS= read -r expected; do
    [ -n "$expected" ] || continue
    if echo "$restarting" | grep -qx "$expected"; then
      status="restarting"
      alerts+=("🔴 Container restarting: $expected")
      containers_all_ok=false
    elif echo "$running" | grep -qx "$expected"; then
      status="running"
    else
      status="stopped"
      alerts+=("🔴 Container not running: $expected")
      containers_all_ok=false
    fi
    containers_json+="    \"${expected}\": \"${status}\","$'\n'
  done < <(all_expected_containers)
fi
```

Also check for unexpected crashing containers (non-gateway):

```bash
crashed=""
if $docker_ok; then
  crashed=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | \
    awk '/Restarting/ {print $1}' | tr '\n' ', ' | sed 's/,$//')
  # Filter out already-reported gateway containers, alert on remaining
fi
```

**health.json format** (lines 117-132): Replace `gateway_ok` with `containers` object.

```json
{
  "timestamp": "...",
  "disk_pct": 45,
  "disk_total_gb": 500,
  "disk_threshold": 85,
  "memory_pct": 60,
  "memory_total_gb": 92,
  "memory_threshold": 90,
  "load_avg": "1.2",
  "cpu_count": 24,
  "docker_ok": true,
  "containers": {
    "muxxibot-openclaw-personal-claw": "running",
    "muxxibot-openclaw-work-claw": "stopped"
  },
  "containers_ok": true,
  "crashed": "",
  "backup_ok": true,
  "backup_age_hours": 5
}
```

`containers_ok` is a convenience boolean (all expected containers running) for quick checks.

**health.json write** (lines 134-140): Iterate all stacks' instances via `all_install_dirs`.

**Backup check** (lines 87-114): Iterate all stacks' instances.

**Report mode** (lines 207-212): Replace "Gateway: OK/down" with per-container status listing.

### 4. `deploy/host/host-maintenance-check.sh`

**JSON write** (lines 60-66): Replace single-stack iteration with `all_install_dirs` loop.

```bash
source "$(cd "$(dirname "$0")" && pwd)/source-stacks.sh"

# Write maintenance.json to all instances across all stacks
while IFS= read -r install_dir; do
  for inst_dir in "${install_dir}/instances"/*/; do
    [ -d "$inst_dir" ] || continue
    status_dir="${inst_dir}.openclaw/workspace/host-status"
    mkdir -p "$status_dir"
    echo "$maintenance_json" > "${status_dir}/maintenance.json"
    chmod 644 "${status_dir}/maintenance.json"
  done
done < <(all_install_dirs)
```

### 5. `deploy/host/backup.sh`

**Instance iteration** (lines 20-55): Iterate all stacks' instances.

```bash
source "$(cd "$(dirname "$0")" && pwd)/source-stacks.sh"

while IFS= read -r install_dir; do
  instances_dir="${install_dir}/instances"
  [ -d "$instances_dir" ] || continue
  for inst_dir in "${instances_dir}"/*/; do
    # existing per-instance backup logic...
  done
  # shared backup (docker-compose.yml) per stack
done < <(all_install_dirs)
```

### 6. `deploy/host/session-prune.sh`

Same pattern as backup.sh — wrap instance loop in `all_install_dirs` iteration.

### 7. `deploy/host/register-cron-jobs.sh`

**Section 4 preamble**: Add a dependency check — warn if no manifests exist (register-stack.sh not yet run). The script still reads its own `stack.env` for CLI cron registration (per-stack concern), but the host scripts it installs will read manifests.

### 8. `deploy/host/register-cron-jobs.sh` — Update cron message

Update the CLI health check message to reference new `containers` format instead of `gateway_ok`:

```
Health (health.json):
- containers: check each entry — "stopped" or "restarting" means a claw is down
- containers_ok is false means at least one expected container is not running
- disk_pct approaching or exceeding disk_threshold
- ...
```

---

## Deploy Sequence

```
1. sync-deploy.sh         # Sync files (every stack)
2. register-stack.sh      # Write manifest (every stack, runs as root)
3. register-cron-jobs.sh  # Install host crons (only host-owning stack)
4. start-claws.sh         # Start containers
```

For an existing deployment adding a new stack:

1. New stack runs `sync-deploy.sh` + `register-stack.sh`
2. Host-owning stack does NOT need redeployment — host scripts auto-discover the new manifest

---

## Verification

1. `npm run pre-deploy` — confirm `register-stack.sh` and `source-stacks.sh` in `.deploy/host/`
2. Deploy to VPS, run `register-stack.sh` — verify `/etc/openclaw-stacks/muxxibot.env` written
3. Run `host-alert.sh` — verify:
   - Container check uses correct names (`muxxibot-openclaw-*`)
   - health.json has `containers` object with per-container status
   - `containers_ok` is true when all running
4. Stop a claw, run `host-alert.sh` again — verify alert sent with container name
5. Re-register CLI cron (`register-cron-jobs.sh`), trigger manually — verify agent reads new format correctly
6. Run `backup.sh` — verify it finds instances across stacks (single-stack is fine for now)

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `deploy/host/register-stack.sh` | **New** | Write/remove stack manifest to `/etc/openclaw-stacks/` |
| `deploy/host/source-stacks.sh` | **New** | Shared cross-stack discovery helper |
| `deploy/host/host-alert.sh` | **Modify** | Per-container checks via manifests, new health.json format |
| `deploy/host/host-maintenance-check.sh` | **Modify** | Write to all stacks' instances |
| `deploy/host/backup.sh` | **Modify** | Back up all stacks' instances |
| `deploy/host/session-prune.sh` | **Modify** | Prune all stacks' instances |
| `deploy/host/register-cron-jobs.sh` | **Modify** | Update CLI cron message for new health.json format |
