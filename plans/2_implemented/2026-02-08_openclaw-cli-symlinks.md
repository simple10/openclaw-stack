# Make OpenClaw CLI Commands More Convenient

## Context

When SSH'd into the gateway container (`docker exec -it openclaw-gateway bash`), there's no `openclaw` command on PATH. You have to type `node /app/openclaw.mjs <command>` every time. The goal is to make `openclaw <command>` work inside the container, and optionally from the VPS host too.

## Current State

- `/app/openclaw.mjs` — canonical entry point, has `#!/usr/bin/env node` shebang
- package.json defines `"bin": {"openclaw": "openclaw.mjs"}` but it's not globally installed
- No `openclaw` binary exists anywhere in the container PATH

## Plan

### 1. Create symlink inside the container (entrypoint)

Add to `entrypoint-gateway.sh` (before the gosu privilege drop, after section 1d):

```bash
# ── 1e. Create openclaw CLI symlink ──────────────────────────────────
if [ ! -L /usr/local/bin/openclaw ]; then
  ln -sf /app/openclaw.mjs /usr/local/bin/openclaw
  echo "[entrypoint] Created /usr/local/bin/openclaw symlink"
fi
```

Since `openclaw.mjs` already has `#!/usr/bin/env node` shebang and is executable, the symlink is all that's needed. This runs as root (before gosu drops to node), so it can write to `/usr/local/bin/`.

**File:** `playbooks/04-vps1-openclaw.md` section 4.8c (entrypoint script)

### 2. Create VPS host wrapper script (optional convenience)

Create `/home/openclaw/scripts/openclaw.sh` and symlink to `/usr/local/bin/openclaw`:

```bash
#!/bin/bash
exec sudo docker exec --user node openclaw-gateway openclaw "$@"
```

This lets `adminclaw` run `openclaw <command>` directly from the VPS host without typing the docker exec prefix.

**File:** `playbooks/04-vps1-openclaw.md` — new section after 4.8d

### 3. Update documentation references

Update playbooks and CLAUDE.md to use `openclaw` instead of `node dist/index.js` or `node openclaw.mjs`:

- `playbooks/04-vps1-openclaw.md` — verification, troubleshooting, updating sections
- `playbooks/07-verification.md` — security audit, doctor commands
- `CLAUDE.md` — quick reference, device pairing instructions

Docker exec examples change from:

```bash
sudo docker exec --user node openclaw-gateway node dist/index.js <cmd>
```

To:

```bash
openclaw <cmd>                    # from VPS host (wrapper)
sudo docker exec --user node openclaw-gateway openclaw <cmd>  # explicit docker exec
```

### 4. Deploy to VPS

- SCP updated entrypoint to VPS
- Create wrapper script + symlink on VPS
- Restart gateway container (picks up entrypoint change, creates symlink on boot)
- Verify

## Files to Modify

1. `playbooks/04-vps1-openclaw.md` — entrypoint (4.8c), new wrapper section, update CLI references throughout
2. `playbooks/07-verification.md` — update docker exec commands
3. `CLAUDE.md` — update quick reference and device pairing docs

## Verification

1. `sudo docker exec -it --user node openclaw-gateway bash` then `openclaw --version` — works inside container
2. `openclaw --version` from VPS host — works via wrapper
3. `openclaw doctor --deep` — full diagnostic
4. `openclaw security audit --deep` — security scan
