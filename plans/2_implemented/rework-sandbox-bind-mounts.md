>
> k. let's rethink the bind mounts altogether. I don't think we need /app/docs anymore. as long as the main agent
> can read them then we should be good. and since it's not running in sandbox agent mode, it already has access
> to them. the coding agent doesn't need access to the docs. hosts-status is only needed in the main agent, which
> is should already have access, so i don't think we need it.
>
> i confirmed that claude can't auto update itself. so linuxbrew mount definitely needs to go.
>
> skill-bins is probably only needed in the main agent when it's running in sandbox. the only reason for it was to
> have the main agent be able to know what skills are available. but let's just make a note about this and
> revisit in a second pass.

# Plan: Clean up sandbox mounts and revert brew workarounds

## Context

Brew-installed tools (gh, himalaya, asciinema, uv, etc.) broke in sandbox containers because `/home/linuxbrew` is configured as tmpfs — wiping the brew Cellar, dynamic linker, and libraries at every container start. We applied workarounds (`cp -L` + `patchelf` + npm fallbacks), but the root cause is the tmpfs itself. It was added to enable runtime tool updates, but `readOnlyRoot: true` prevents meaningful updates anyway — any tmpfs install is lost on restart, and npm/brew global installs can't write to the read-only root.

Additionally, several bind mounts exist in the default sandbox config that are unnecessary given the current agent architecture: main runs on host (has direct access to docs and host-status), and code/skills agents don't need those files.

## Changes

### 1. Remove `/home/linuxbrew` from tmpfs — `deploy/openclaw.json`

In `agents.defaults.sandbox.docker.tmpfs` (line ~110), remove the `/home/linuxbrew:uid=1000,gid=1000` entry. Keep `/tmp`, `/var/tmp`, `/run`.

Update the comment from "Allow agents to update or install packages" to reflect the remaining tmpfs entries are for scratch space only.

### 2. Remove unnecessary default bind mounts — `deploy/openclaw.json`

In `agents.defaults.sandbox.docker.binds` (lines 133-141), remove:

- `/app/docs:/workspace/docs:ro` — main agent runs on host, already has access. Other agents don't need docs.
- `/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro` — main agent runs on host, already has access. Other agents don't need host-status.

Keep:

- `/opt/skill-bins:/opt/skill-bins:ro` — needed for gateway preflight checks. Note: revisit in a second pass (only truly needed when main runs in sandbox mode).

### 3. Update code agent binds — `deploy/openclaw.json`

The code agent's per-agent `binds` array (lines 216-223) repeats all defaults plus its own. After removing docs and host-status from defaults, update the code agent's binds to match:

- Keep `/opt/skill-bins:/opt/skill-bins:ro`
- Remove `/app/docs:/workspace/docs:ro`
- Remove `/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro`
- Keep `/home/node/sandboxes-home/code:/home/sandbox`

Update the comment about repeating defaults.

### 4. Revert all brew workarounds — `deploy/sandbox-toolkit.yaml`

Since `/home/linuxbrew` is no longer tmpfs, brew symlinks will work fine. Revert to simple `ln -sf` for all brew tools:

- **Remove `patchelf`** from `packages:` list (line 27)
- **Revert brew section comment** back to simpler explanation (symlinks are fine now)
- **gh**: remove `cp -L` + `patchelf`, use `ln -sf` instead
- **himalaya**: same — revert to `ln -sf`
- **gemini-cli**: revert from npm to brew install with `ln -sf` (brew handles the full module tree properly when Cellar persists)
- **sag**: remove `cp -L`, use `ln -sf`
- **goplaces**: remove `cp -L`, use `ln -sf`
- **asciinema**: remove `cp -L` + `patchelf`, use `ln -sf`
- **uv/uvx**: remove `cp -L` + `patchelf` + `--set-rpath`, use `ln -sf`
- **nano-pdf**: remove `--python /usr/bin/python3` flag (brew Python will persist now)

### 5. Deploy and rebuild

1. Sync `deploy/openclaw.json` to VPS via `openclaw config set` or direct file copy
2. Sync `deploy/sandbox-toolkit.yaml` to VPS
3. Remove cached `openclaw-sandbox-common:bookworm-slim` image (force clean rebuild)
4. Rebuild sandbox images via `rebuild-sandboxes.sh --force`
5. Recreate sandbox containers: `openclaw sandbox recreate --all --force`
6. Restart gateway (bind/tmpfs changes require container recreation)

### 6. Commit

Commit all local changes to `deploy/openclaw.json` and `deploy/sandbox-toolkit.yaml`.

## Files modified

- `deploy/openclaw.json` — tmpfs, binds (defaults + code agent)
- `deploy/sandbox-toolkit.yaml` — revert all brew workarounds

## Verification

1. **Tmpfs check**: `docker run --rm openclaw-sandbox-common:bookworm-slim mount | grep linuxbrew` — should show nothing (no tmpfs on linuxbrew)
2. **Brew tools in image**: `docker run --rm openclaw-sandbox-common:bookworm-slim bash -c 'gh --version && himalaya --version && gemini --version && asciinema --version && uv --version && nano-pdf --version'` — all should work
3. **Live sandbox test**: Send a message to code agent via `openclaw agent --agent code --message '...'` and verify tools work
4. **SSH agent test**: Run `./scripts/ssh-agent.sh code` to verify sandbox comes up and tools work inside

## Note for second pass

`/opt/skill-bins:/opt/skill-bins:ro` is kept for now. It exists so the gateway can run preflight checks (verifying binaries exist) before routing tool calls to sandboxes. The shims at `/opt/skill-bins/` satisfy these checks on the gateway side while real binaries live in sandbox images. Revisit whether this is still needed or if gateway preflight can be configured differently.
