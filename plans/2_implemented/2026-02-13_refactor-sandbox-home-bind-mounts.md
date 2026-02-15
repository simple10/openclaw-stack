# Plan: Refactor Sandbox Home Directory Bind Mounts

## Context

The code agent sandbox currently uses a `.claude-sandbox` bind mount to provide Claude Code credentials at `/home/linuxbrew/.claude`. The `HOME` env is overridden to `/home/linuxbrew` (a tmpfs) because the native `/home/sandbox` is read-only. This was a special-case workaround for one agent.

We're replacing it with a general-purpose pattern: any agent that wants a persistent home directory simply adds a bind mount in `openclaw.json` for `/home/node/sandboxes-home/[agent-id]:/home/sandbox`. The infrastructure (compose mount, ownership fix) is agent-agnostic.

**Result:** SSH keys, git config, credentials, and dotfiles placed in `sandboxes-home/code/` on the VPS appear at standard `~/` paths inside the code sandbox.

## New Bind Mount Chain

```
VPS Host                                   Gateway Container                      Sandbox
/home/openclaw/sandboxes-home/      →     /home/node/sandboxes-home/
                          /code/                                /code/       →    /home/sandbox  ($HOME)
```

Any agent can opt in by adding the bind to its openclaw.json config. No playbook or entrypoint changes needed per agent.

## Changes

### 1. `deploy/openclaw.json`

**defaults.docker section:**

- **Add** `/home/sandbox:uid=1000,gid=1000` to `tempfs`
  (Keep `/home/linuxbrew` — it's Homebrew's home, needs writable tmpfs for package installs)
- **Remove** `"HOME": "/home/linuxbrew"` from `env`
  (OpenClaw's native `$HOME=/home/sandbox` takes effect for all agents)

**code agent section (lines 109-111):**

```json
// Before:
"binds": ["/home/node/.claude-sandbox:/home/linuxbrew/.claude"]
// After:
"binds": ["/home/node/sandboxes-home/code:/home/sandbox"]
```

### 2. `deploy/docker-compose.override.yml` (line 39-40)

```yaml
# Before:
# Claude Code sandbox credentials (isolated from gateway creds, shared with sandboxes via openclaw.json binds)
- /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox
# After:
# Persistent sandbox home directories — agents opt in via openclaw.json binds
- /home/openclaw/sandboxes-home:/home/node/sandboxes-home
```

### 3. `deploy/entrypoint-gateway.sh` (section 1c, lines 25-35)

Generalize from `.claude-sandbox` to `sandboxes-home`:

```bash
# Before:
claude_dir="/home/node/.claude-sandbox"
# After:
sandboxes_dir="/home/node/sandboxes-home"
```

Same `chown -R 1000:1000` logic, updated path, variable name, comments, and log messages. This is the only infrastructure needed — it handles ownership for all agent dirs at once.

### 4. `deploy/rebuild-sandboxes.sh` — add home seeding at the end

Add `seed_agent_homes()` after all image builds:

- Creates `/home/node/sandboxes-home/[agent-id]/` if missing
- If `.bashrc` doesn't exist there yet, extracts `/etc/skel/` dotfiles from the common sandbox image via `docker run --rm`
- Fixes ownership to `1000:1000`
- Skipped in `--dry-run` mode

This ensures the bind mount dir has default shell configs so they aren't lost when shadowing `/home/sandbox`.

### 5. `playbooks/06-backup.md` (section 6.1)

Add `sandboxes-home` to the backup tar paths.

### 6. `playbooks/04-vps1-openclaw.md` (section 4.3)

- Add `sandboxes-home/` to directory creation
- Remove any `.claude-sandbox` directory creation

### 7. `REQUIREMENTS.md`

- Remove all `.claude-sandbox` references
- Update sections 3.3 (dir structure), 3.5 (entrypoint), 3.7 (openclaw.json), 3.9 (sandbox credentials) to document the new `sandboxes-home/[agent-id]` pattern
- Document that agents opt in to persistent home by adding a bind in openclaw.json

## Files Modified

| File | Change |
|------|--------|
| `deploy/openclaw.json` | Add tempfs entry, remove env.HOME, update code agent binds |
| `deploy/docker-compose.override.yml` | Volume mount path + comment |
| `deploy/entrypoint-gateway.sh` | Section 1c: generalize to `sandboxes-home` |
| `deploy/rebuild-sandboxes.sh` | New `seed_agent_homes()` function |
| `playbooks/04-vps1-openclaw.md` | Directory creation, remove `.claude-sandbox` |
| `playbooks/06-backup.md` | Add `sandboxes-home` to backup |
| `REQUIREMENTS.md` | Remove `.claude-sandbox`, document new pattern |

## VPS Migration (operational)

```bash
# Create new structure
sudo mkdir -p /home/openclaw/sandboxes-home/code
# Migrate existing Claude Code credentials
sudo cp -a /home/openclaw/.claude-sandbox/. /home/openclaw/sandboxes-home/code/.claude/
# Fix ownership
sudo chown -R 1000:1000 /home/openclaw/sandboxes-home
# Restart gateway (compose up -d picks up new mount, rebuild-sandboxes seeds dotfiles)
# After verifying: sudo rm -rf /home/openclaw/.claude-sandbox
```

## Verification

1. **Compose mount**: `docker inspect openclaw-gateway | grep sandboxes-home`
2. **Dotfile seeding**: `docker exec openclaw-gateway ls -la /home/node/sandboxes-home/code/` shows `.bashrc`, `.profile`
3. **Gateway health**: `docker exec openclaw-gateway openclaw health`
4. **Backup**: Run backup, verify tar includes `sandboxes-home/`
5. **SSH key test**: Place key in VPS `sandboxes-home/code/.ssh/`, verify at `~/.ssh/` in a code sandbox
