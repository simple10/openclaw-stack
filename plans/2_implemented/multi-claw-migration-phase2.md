# Always Multi-Claw Architecture (Phase 2: Scripts & CLI)

## Context

Phase 1 (completed) established the always-multi-claw architecture: generated `docker-compose.override.yml`, instance layout at `/home/openclaw/instances/<name>/`, `_defaults/` layering, and unified claw discovery. Container names are now `openclaw-<dirname>` (e.g., `openclaw-main-claw`).

**Problem:** ~12 bash scripts and 2 CLI TypeScript files still hardcode `openclaw-gateway` as the container name. These scripts break when the container is actually named `openclaw-main-claw` (or any other claw name). The host monitoring script (`deploy/host-alert.sh`) also checks for `openclaw-gateway` specifically.

**This phase updates all scripts and CLI code to dynamically resolve the correct container name.** For single-claw deployments (the common case), resolution is automatic. For multi-claw setups, an `--instance` flag or env var selects the target.

---

## Key Design Decisions

**Shared `resolve_gateway()` function** — a new helper script `scripts/lib/resolve-gateway.sh` provides a `resolve_gateway()` function that all bash scripts source. Resolution order:

1. `--instance <name>` CLI flag (if the script passes it through)
2. `OPENCLAW_INSTANCE` env var
3. Auto-detect: list running `openclaw-*` containers; if exactly one, use it; if multiple, error with a list

**CLI uses the same logic** — `cli/src/ssh.ts` exports a `resolveGatewayContainer()` function that mirrors the bash logic. `OPENCLAW_EXEC` and `OPENCLAW_EXEC_IT` become functions (not constants) that accept an optional instance name.

**`deploy/host-alert.sh` checks ALL claw containers** — replaces the `grep -q '^openclaw-gateway$'` check with a pattern match for any `openclaw-*` container (excluding utility containers like `openclaw-cli`).

**`deploy/build-openclaw.sh`** — update the help message from `openclaw-gateway` to the generic name.

**Backward compatibility** — `openclaw-gateway` is no longer a valid container name. Scripts that used it will now auto-resolve to the actual container. No env var or flag needed for single-claw deployments.

---

## Implementation

### 1. Create shared resolver: `scripts/lib/resolve-gateway.sh`

New file sourced by all scripts that need a container name.

```bash
#!/bin/bash
# resolve-gateway.sh — Resolve the OpenClaw gateway container name
# Source this file, then call resolve_gateway [--instance <name>]

resolve_gateway() {
  local instance=""

  # Check for --instance flag in arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance) instance="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Fall back to env var
  instance="${instance:-${OPENCLAW_INSTANCE:-}}"

  if [[ -n "$instance" ]]; then
    echo "openclaw-${instance}"
    return 0
  fi

  # Auto-detect: find running openclaw-* containers (exclude openclaw-cli)
  local containers
  containers=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
    "sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' 2>/dev/null" \
    | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' || true)

  local count
  count=$(echo "$containers" | grep -c . || true)

  if [[ "$count" -eq 1 ]]; then
    echo "$containers"
    return 0
  elif [[ "$count" -eq 0 ]]; then
    echo "Error: No OpenClaw gateway containers running." >&2
    echo "  Start with: openclaw-multi.sh start" >&2
    return 1
  else
    echo "Error: Multiple gateway containers running. Specify which one:" >&2
    echo "$containers" | sed 's/^openclaw-/  --instance /' >&2
    return 1
  fi
}
```

### 2. Update bash scripts (8 files)

Each script gets the same pattern change: replace `GATEWAY="openclaw-gateway"` with a `resolve_gateway` call.

**`scripts/restart-gateway.sh`** (line 22):

```bash
# Before:
GATEWAY="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
```

**`scripts/health-check.sh`** (line 82):

```bash
# Before:
CONTAINERS="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
CONTAINERS="$GATEWAY"
```

**`scripts/restart-sandboxes.sh`** (line 56):

```bash
# Before:
GATEWAY="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
```

**`scripts/start-browser.sh`** (line 28):

```bash
# Before:
GATEWAY="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
```

**`scripts/ssh-gateway.sh`** (line 20):

```bash
# Before:
  "sudo docker exec -it -u node openclaw-gateway bash"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
...
  "sudo docker exec -it -u node $GATEWAY bash"
```

**`scripts/logs-openclaw.sh`** (line 21):

```bash
# Before:
CONTAINER="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
CONTAINER=$(resolve_gateway "$@") || exit 1
```

**`scripts/ssh-agent.sh`** (line 29):

```bash
# Before:
GATEWAY="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
```

**`scripts/update-openclaw.sh`** (line 22):

```bash
# Before:
GATEWAY="openclaw-gateway"
# After:
source "$SCRIPT_DIR/lib/resolve-gateway.sh"
GATEWAY=$(resolve_gateway "$@") || exit 1
```

**Note on `--instance` flag parsing:** Scripts like `restart-sandboxes.sh` and `health-check.sh` already have their own arg parsing loops. For those, extract `--instance` before passing to `resolve_gateway`. The resolver's `while` loop handles this by scanning through all args and ignoring unknown ones.

### 3. Update CLI TypeScript (2 files)

**`cli/src/ssh.ts`** — Replace hardcoded container name with a resolver function:

```typescript
// Before:
export async function gatewayExec(cfg: Config, cmd: string): Promise<string> {
  return ssh(cfg, 'vps1', `sudo docker exec --user node openclaw-gateway ${cmd}`);
}
export const OPENCLAW_EXEC = `sudo docker exec --user node openclaw-gateway ${OPENCLAW_BIN}`;
export const OPENCLAW_EXEC_IT = `sudo docker exec --user node -it openclaw-gateway ${OPENCLAW_BIN}`;

// After:
function gatewayContainer(cfg: Config): string {
  const instance = cfg['OPENCLAW_INSTANCE'] || 'main-claw';
  return `openclaw-${instance}`;
}

export async function gatewayExec(cfg: Config, cmd: string): Promise<string> {
  return ssh(cfg, 'vps1', `sudo docker exec --user node ${gatewayContainer(cfg)} ${cmd}`);
}

export async function gatewayExecSafe(cfg: Config, cmd: string): Promise<SshResult> {
  return sshSafe(cfg, 'vps1', `sudo docker exec --user node ${gatewayContainer(cfg)} ${cmd}`);
}

export function openclawExecPrefix(cfg: Config): string {
  return `sudo docker exec --user node ${gatewayContainer(cfg)} ${OPENCLAW_BIN}`;
}

export function openclawExecItPrefix(cfg: Config): string {
  return `sudo docker exec --user node -it ${gatewayContainer(cfg)} ${OPENCLAW_BIN}`;
}
```

The CLI always has access to `openclaw-config.env` via its Config object. `OPENCLAW_INSTANCE` defaults to `main-claw` if not set (the default claw).

**`cli/src/commands/gateway.ts`** — Replace hardcoded container references:

```typescript
// Line 40 — health check port: keep as-is (18789 is the default gateway port)
// The health check runs on localhost inside the VPS, and main-claw always gets 18789.
// For multi-claw, this would need per-claw port resolution (Phase 3 scope).

// Lines 61, 64, 67 — docker logs:
await sshStream(cfg, 'vps1', `sudo docker logs -f ${gatewayContainer(cfg)}`);
// etc.

// Line 89 — docker exec shell:
await sshInteractive(cfg, 'vps1', `sudo docker exec -it ${gatewayContainer(cfg)} /bin/sh`);
```

Import `gatewayContainer` from `../ssh.ts`.

**`cli/src/commands/openclaw.ts`** — Uses `OPENCLAW_EXEC` and `OPENCLAW_EXEC_IT` (3 call sites):

- Line 68: `sshInteractive(cfg, 'vps1',`${OPENCLAW_EXEC_IT} ${args}`)` → use `openclawExecItPrefix(cfg)`
- Line 201: `sshInteractive(cfg, 'vps1',`${OPENCLAW_EXEC_IT} cron add`)` → same
- Line 310: `sshStream(cfg, 'vps1',`${OPENCLAW_EXEC} logs --follow`)` → use `openclawExecPrefix(cfg)`

Also update imports: replace `OPENCLAW_EXEC, OPENCLAW_EXEC_IT` with `openclawExecPrefix, openclawExecItPrefix`.

### 4. Update `deploy/host-alert.sh`

Replace the single-container check with a pattern match for any `openclaw-*` gateway container.

```bash
# Before (line 74):
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^openclaw-gateway$'; then
  alerts+=("🔴 openclaw-gateway container is NOT running")

# After:
gateway_containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' || true)
if [[ -z "$gateway_containers" ]]; then
  alerts+=("🔴 No OpenClaw gateway containers running")
```

Also update the backup path check (line 91):

```bash
# Before:
backup_dir="/home/openclaw/.openclaw/backups"

# After:
# Check all instance backup directories
backup_ok=true
for inst_dir in /home/openclaw/instances/*/; do
  [ -d "$inst_dir" ] || continue
  backup_dir="${inst_dir}.openclaw/backups"
  # ... existing freshness check per instance ...
done
```

### 5. Update `deploy/build-openclaw.sh`

```bash
# Line 77 — update help message:
# Before:
echo "[build] Done. Run: docker compose up -d openclaw-gateway"
# After:
echo "[build] Done. Run: docker compose up -d"
```

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `scripts/lib/resolve-gateway.sh` | **CREATE** | Shared container name resolution |
| `scripts/restart-gateway.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/health-check.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/restart-sandboxes.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/start-browser.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/ssh-gateway.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/logs-openclaw.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/ssh-agent.sh` | **MODIFY** | Use `resolve_gateway` |
| `scripts/update-openclaw.sh` | **MODIFY** | Use `resolve_gateway` |
| `cli/src/ssh.ts` | **MODIFY** | `gatewayContainer()` resolver, functions replace constants |
| `cli/src/commands/gateway.ts` | **MODIFY** | Use `gatewayContainer()` |
| `cli/src/commands/openclaw.ts` | **MODIFY** | Replace `OPENCLAW_EXEC` constants with functions |
| `deploy/host-alert.sh` | **MODIFY** | Check all `openclaw-*` containers |
| `deploy/build-openclaw.sh` | **MODIFY** | Update help message |

**NOT changing (Phase 3):** playbooks/*, docs/*, CLAUDE.md, plans/*

---

## Verification

1. **Single-claw auto-resolve:** `scripts/restart-gateway.sh` — resolves to `openclaw-main-claw` without any flags
2. **Explicit instance:** `scripts/restart-gateway.sh --instance test-claw` — targets `openclaw-test-claw`
3. **Env var:** `OPENCLAW_INSTANCE=test-claw scripts/health-check.sh` — targets `openclaw-test-claw`
4. **Multi-claw error:** With 2+ containers running and no `--instance`, scripts print helpful error listing available instances
5. **CLI:** `gatewayExec()` uses resolved container name; old constants removed
6. **Host alert:** `deploy/host-alert.sh` detects any running `openclaw-*` container
7. **Shellcheck:** All modified scripts pass shellcheck
8. **No remaining `openclaw-gateway` refs:** `grep -r 'openclaw-gateway' scripts/ cli/ deploy/host-alert.sh deploy/build-openclaw.sh` returns nothing (except comments/docs)
