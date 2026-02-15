# Plan: Entrypoint Script + Sandbox Bootstrap + Self-Restart

## Overview

Add three capabilities to the OpenClaw gateway by modifying `playbooks/04-vps1-openclaw.md`:

1. **Lock file cleanup** on container boot
2. **Sandbox image bootstrap** inside the sysbox nested Docker daemon
3. **Self-restart** via `commands.restart: true` in openclaw.json

All three are wired through a new `entrypoint-gateway.sh` script, bind-mounted into the container.

The purpose of these changes is to fully support openclaw's self-modification loop.

---

## Files to Modify

| File | Change |
|------|--------|
| `playbooks/04-vps1-openclaw.md` § 4.6 | Update docker-compose.override.yml: add `entrypoint`, change `command`, add volume mounts, increase `start_period` |
| `playbooks/04-vps1-openclaw.md` § 4.8 | Add `"commands": { "restart": true }` to openclaw.json |
| `playbooks/04-vps1-openclaw.md` (new § 4.8c) | New section: create `scripts/entrypoint-gateway.sh` |
| `CLAUDE.md` | Add 2 entries to Key Deployment Notes |

---

## Implementation

### 1. New section 4.8c: Create Entrypoint Script

Insert after section 4.8b. Creates `scripts/entrypoint-gateway.sh` on the host at `/home/openclaw/openclaw/scripts/`.

The script does three things in order:

1. `rm -f /home/node/.openclaw/gateway.*.lock` — clean stale locks
2. Wait up to 30s for sysbox nested Docker daemon, then build sandbox images if missing
3. `exec node dist/index.js gateway "$@"` — start gateway (exec replaces shell so tini from `init: true` becomes direct parent of node)

Key detail: Do NOT use `exec tini --` in the script. Docker's `init: true` already provides tini as PID 1. Double-wrapping would break signal forwarding.

### 2. Modify section 4.6: docker-compose.override.yml

Changes to the `openclaw-gateway` service:

```yaml
    volumes:
      # Patch: Fix @opentelemetry/resources v2.x API change (from 4.8b)
      - ./patches-runtime/diagnostics-otel-service.ts:/app/extensions/diagnostics-otel/src/service.ts:ro
      # Entrypoint script: lock cleanup, sandbox bootstrap, then exec gateway
      - ./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
    # Entrypoint handles pre-start tasks before exec-ing the gateway
    entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
    # Args passed to entrypoint, which passes them to: node dist/index.js gateway
    command:
      [
        "--allow-unconfigured",
        "--bind",
        "lan",
        "--port",
        "18789",
      ]
    healthcheck:
      # ... same as current, but increase start_period:
      start_period: 120s  # Up from 60s — sandbox image build on first boot takes time
```

This also integrates the OTEL patch volume mount from 4.8b into the main override config (currently it's a separate manual step).

The `command` changes from `["node", "dist/index.js", "gateway", "--allow-unconfigured", ...]` to just `["--allow-unconfigured", ...]` because the entrypoint provides `exec node dist/index.js gateway "$@"`.

### 3. Modify section 4.8: openclaw.json

Add `commands` key as first entry:

```json
{
  "commands": {
    "restart": true
  },
  "gateway": { ... },
  ...
}
```

Add a comment noting this must be validated first:

```bash
# Validate commands.restart is accepted before applying:
# sudo docker exec openclaw-gateway node dist/index.js gateway --help 2>&1 | grep -i restart
```

If OpenClaw rejects the key, omit it and document the limitation.

### 4. Update CLAUDE.md Key Deployment Notes

Add:

```
15. **Entrypoint script:** Gateway uses bind-mounted entrypoint that cleans lock files and bootstraps sandbox images before starting
16. **Self-restart:** `commands.restart: true` enables agents to modify config and trigger in-process restart via SIGUSR1
```

---

## Verification

After deploying changes on VPS-1:

```bash
# 1. Check entrypoint ran (look for [entrypoint] log lines)
sudo docker logs openclaw-gateway 2>&1 | grep "\[entrypoint\]"

# 2. Verify health endpoint still works
curl -s http://localhost:18789/health

# 3. Check nested Docker daemon and sandbox images
sudo docker exec openclaw-gateway docker images

# 4. Verify tini is PID 1 (not the entrypoint script)
sudo docker exec openclaw-gateway ps aux | head -5

# 5. Test self-restart config key (if added)
sudo docker exec openclaw-gateway node dist/index.js config get 2>&1 | grep -A2 commands
```
