# Fix Claude Code CLI in OpenClaw Sandbox

## Context

Claude Code runs inside sandbox containers via the `coding-agent` skill (using `bash pty:true`). Two issues prevent it from working:

1. **`readOnlyRoot: true`** causes Docker's `--read-only` flag, blocking Claude Code from writing `~/.claude.json` (its config/state file)
2. **Credentials isolation** — the gateway's `.claude` OAuth credentials are device-bound and don't work in sandbox containers. Sandboxes need their own credentials.

## Approach

Keep the skill-based approach (no separate agent). Fix the read-only issue and set up isolated credentials.

## Changes

### 1. Add `/home/linuxbrew` to sandbox tmpfs (writable home dir)

**File (VPS-1):** `openclaw.json` at `/home/openclaw/.openclaw/openclaw.json`

Add `/home/linuxbrew` to `agents.defaults.sandbox.docker.tmpfs`:

```json
"tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew"]
```

This makes the home directory writable (for `~/.claude.json` etc.) while keeping the rest of the filesystem read-only. The `~/.claude` bind mount sits on top of the tmpfs, so credentials persist independently.

**Note:** tmpfs contents are lost when the container is destroyed, but with `scope: "agent"` the container persists between tool calls.

### 2. Use separate credentials directory for sandboxes

**File (VPS-1):** `docker-compose.override.yml`

Change the `.claude` bind mount to use a separate sandbox-specific dir:

```yaml
# Before:
- /home/openclaw/.claude:/home/node/.claude

# After:
- /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox
```

**File (VPS-1):** `openclaw.json`

Update the sandbox binds to use the separate dir:

```json
"binds": ["/home/node/.claude-sandbox:/home/linuxbrew/.claude"]
```

**On host:** Create the directory:

```bash
sudo -u openclaw mkdir -p /home/openclaw/.claude-sandbox
```

The gateway keeps its own `/home/node/.claude` (no change). Sandboxes get `/home/openclaw/.claude-sandbox` mounted as their `~/.claude`. User authorizes Claude once in a sandbox and credentials persist on the host.

### 3. Increase sandbox prune times

**File (VPS-1):** `openclaw.json`

Update `agents.defaults.sandbox.prune`:

```json
"prune": {
  "idleHours": 168,
  "maxAgeDays": 60
}
```

### 4. Fix entrypoint `.claude` ownership step

**File (VPS-1):** `scripts/entrypoint-gateway.sh`

Update the chown step (section 1c) to fix `.claude-sandbox` instead of `.claude`:

```bash
claude_dir="/home/node/.claude-sandbox"
```

### 5. Update playbook documentation

**File (local):** `playbooks/extras/sandbox-and-browser.md`

Update entrypoint, compose override, and openclaw.json sections to reflect all changes.

## Files Modified

| Location | File | Change |
|----------|------|--------|
| VPS-1 | `/home/openclaw/.openclaw/openclaw.json` | Add tmpfs, update binds, update prune |
| VPS-1 | `/home/openclaw/openclaw/docker-compose.override.yml` | Change bind mount to `.claude-sandbox` |
| VPS-1 | `/home/openclaw/openclaw/scripts/entrypoint-gateway.sh` | Fix chown path |
| VPS-1 host | `/home/openclaw/.claude-sandbox/` | Create directory |
| Local | `playbooks/extras/sandbox-and-browser.md` | Update docs |

## Verification

1. Restart gateway: `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway'`
2. Wait for sandbox images to rebuild (~5 min on cold start)
3. SSH into sandbox and verify:

   ```bash
   ssh -t -p 222 adminclaw@VPS1_IP \
     "sudo docker exec -it openclaw-gateway \
       docker run --rm -it --user 1000:1000 --read-only \
         --tmpfs /home/linuxbrew \
         -v /home/node/.claude-sandbox:/home/linuxbrew/.claude \
         openclaw-sandbox-common:bookworm-slim bash"
   ```

4. Inside sandbox: `claude --version` (should work)
5. Inside sandbox: `touch ~/.claude.json` (should succeed — tmpfs)
6. Inside sandbox: `claude login` to authorize (one-time)
7. Test via OpenClaw webchat: ask it to use Claude Code for a task
