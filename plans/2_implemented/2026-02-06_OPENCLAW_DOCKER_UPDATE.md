# Plan: Align OpenClaw Docker Setup with Upstream

## Context

Our VPS deployment deviates significantly from the official OpenClaw Docker setup, creating maintenance burden and risk of breaking on upstream updates. The key deviations are:

1. A fully forked `Dockerfile.custom` (must be manually synced with upstream changes)
2. Runtime volume-mount patching of OTEL extension source code (silently overrides container files)
3. A custom entrypoint that hardcodes the gateway startup command
4. A docker-compose.override.yml that overrides build config, entrypoint, and command

The goal is to minimize deviations so that `git pull && rebuild` works with minimal manual intervention, while preserving our power-user features (Sysbox, OTEL, security hardening).

**Upstream status (confirmed):** The two issues that forced our deviations are still unfixed:

- [#7201](https://github.com/openclaw/openclaw/issues/7201): Dockerfile doesn't copy extension `package.json` before `pnpm install`
- [#3201](https://github.com/openclaw/openclaw/issues/3201): `diagnostics-otel` uses deprecated OTEL v2.x APIs (PR #4255 not yet merged)

---

## Changes

### 1. Replace `Dockerfile.custom` with sed-patched upstream Dockerfile

**Current:** Full Dockerfile fork that mirrors upstream + 1 extra COPY line.
**New:** Patch the upstream Dockerfile in-place before building.

Instead of maintaining a parallel Dockerfile, a build script will insert the missing `COPY extensions/diagnostics-otel/package.json` line into the upstream Dockerfile using sed, then build normally. When upstream fixes #7201, the check auto-skips.

- **Remove:** `Dockerfile.custom` creation (section 4.8a)
- **Remove:** `build:` section from `docker-compose.override.yml` (section 4.6)
- **Add:** Build script that patches and builds (new section, replaces 4.8a + 4.9)

### 2. Convert runtime OTEL patch to build-time patch

**Current:** `patches-runtime/diagnostics-otel-service.ts` mounted as volume over container file at runtime.
**New:** Apply a unified diff patch to the source tree before `docker build`, with a guard that auto-skips when upstream fixes the issue.

- **Remove:** `patches-runtime/` directory and its volume mount from override
- **Add:** `patches/otel-v2-compat.patch` (unified diff) in the VPS repo
- **Add:** Patch step in the build script with auto-detection

### 3. Simplify entrypoint to use `exec "$@"` pattern

**Current:** Entrypoint hardcodes `exec node dist/index.js gateway "$@"`, and the override's `command` passes only flags like `--allow-unconfigured --bind lan --port 18789`.
**New:** Entrypoint ends with `exec "$@"`, receiving the full command from Docker Compose. The override's `command` specifies the complete gateway invocation.

This is a small structural change that makes the entrypoint agnostic to the gateway command format. If upstream changes their command structure, we only update one place (the override's `command`).

- **Modify:** `scripts/entrypoint-gateway.sh` — change `exec node dist/index.js gateway "$@"` to `exec "$@"`
- **Modify:** Override's `command` to include the full invocation: `["node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]`

### 4. Simplify docker-compose.override.yml

Remove items that are no longer needed after changes 1-3:

| Remove | Reason |
|--------|--------|
| `build:` section | Building happens in the build script, not via compose |
| `image: openclaw:local` on `openclaw-cli` | Will inherit from base compose (same image) |
| `build:` on `openclaw-cli` | Same as above |
| Patch volume mount | Patches applied at build time |

Keep all security/operational overrides (they're additive, not divergent):

- `runtime: sysbox-runc`
- `read_only: true` + tmpfs
- `user: "1000:1000"` / `security_opt`
- Resource limits
- Entrypoint mount + override
- OTEL env vars, healthcheck, logging
- node-exporter and promtail services

### 5. Create a build script for reproducible updates

New file: `scripts/build-openclaw.sh` (stored in the VPS repo, copied to VPS-1)

```bash
#!/bin/bash
set -euo pipefail
cd /home/openclaw/openclaw

# 1. Patch Dockerfile for extension deps (upstream #7201)
if ! grep -q "extensions/diagnostics-otel/package.json" Dockerfile; then
  echo "[build] Patching Dockerfile for extension deps (upstream #7201)..."
  sed -i '/COPY scripts \.\/scripts/a COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json' Dockerfile
fi

# 2. Patch OTEL v2.x API compat (upstream #3201)
if grep -q "new Resource(" extensions/diagnostics-otel/src/service.ts 2>/dev/null; then
  echo "[build] Applying OTEL v2.x compatibility patch (upstream #3201)..."
  patch -p1 < /home/openclaw/patches/otel-v2-compat.patch
else
  echo "[build] OTEL v2.x patch not needed (upstream fixed or extension not present)"
fi

# 3. Build image
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# 4. Restore patched files (keep git working tree clean)
git checkout -- Dockerfile extensions/ 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
```

The `git checkout` at the end restores the working tree so future `git pull` doesn't conflict.

---

## Files to Modify

| File | Action |
|------|--------|
| `playbooks/04-vps1-openclaw.md` § 4.6 | Rewrite override (remove build, patch volume, simplify command) |
| `playbooks/04-vps1-openclaw.md` § 4.8a | Replace Dockerfile.custom with build script |
| `playbooks/04-vps1-openclaw.md` § 4.8b | Replace runtime patch with build-time patch file |
| `playbooks/04-vps1-openclaw.md` § 4.8c | Update entrypoint to `exec "$@"` |
| `playbooks/04-vps1-openclaw.md` § 4.9 | Update build/start to use build script |
| `playbooks/04-vps1-openclaw.md` § "Updating OpenClaw" (lines 732-754) | Rewrite to use build script instead of `Dockerfile.custom` |
| `CLAUDE.md` | Update notes 15 (entrypoint) to reflect new pattern |

## New Files

| File | Purpose |
|------|---------|
| `scripts/build-openclaw.sh` | Build script with auto-patching |
| `patches/otel-v2-compat.patch` | Unified diff for OTEL v2.x API fixes |

---

## Update Procedure (going forward)

```bash
# SSH to VPS-1
ssh -p 222 adminclaw@VPS1

# Pull latest upstream
sudo -u openclaw bash -c "cd /home/openclaw/openclaw && git pull"

# Build with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Restart
sudo -u openclaw bash -c "cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway"
```

When upstream fixes either issue, the build script auto-detects and skips the corresponding patch. No manual intervention needed.

---

## Verification

1. Build succeeds without errors
2. `docker compose up -d` starts gateway with Sysbox runtime
3. Gateway health check passes: `curl http://localhost:18789/health`
4. OTEL traces appear in Tempo (make a model call to generate activity)
5. OTEL metrics appear in Prometheus
6. OTEL logs appear in Loki
7. Sandbox creation works (agent can execute code)
8. `git status` in the openclaw repo shows clean working tree after build
