# Plan: Deploy hooks from `deploy/hooks/` on fresh installs

## Context

We added a `debug-logger` managed hook in `deploy/hooks/debug-logger/` (HOOK.md + handler.js) and enabled it in `openclaw.json`, but there's no deployment mechanism to get hook files into the container. The entrypoint deploys plugins (section 1h) and has a compose bind mount for `deploy/plugins`, but hooks have no equivalent. Any hooks added to `deploy/hooks/` need to be automatically deployed on fresh installs.

## Files to modify

| File | Change |
|------|--------|
| `deploy/docker-compose.override.yml` | Add `deploy/hooks` bind mount |
| `deploy/entrypoint-gateway.sh` | Add section 1i: copy hooks to `~/.openclaw/hooks/` |
| `playbooks/04-vps1-openclaw.md` | Add section 4.8g for hook deployment |

## Changes

### 1. Compose: add `deploy/hooks` bind mount

Add after the existing `deploy/plugins` mount:

```yaml
      # Managed hooks: entrypoint copies these to ~/.openclaw/hooks/
      - ./deploy/hooks:/app/deploy/hooks:ro
```

### 2. Entrypoint: add section 1i after section 1h

Same pattern as plugin deployment — copy `deploy/hooks/*/` to `~/.openclaw/hooks/*/`:

```bash
# ── 1i. Deploy managed hooks ──────────────────────────────────────
# Hooks from deploy/hooks/ are copied to ~/.openclaw/hooks/ where the
# gateway discovers them. Each hook dir contains HOOK.md + handler.js.
# Hook entries must also be enabled in openclaw.json (hooks.internal.entries).
hooks_dir="/home/node/.openclaw/hooks"
deploy_hooks="/app/deploy/hooks"
if [ -d "$deploy_hooks" ]; then
  mkdir -p "$hooks_dir"
  for hook_dir in "$deploy_hooks"/*/; do
    hook_name=$(basename "$hook_dir")
    target="$hooks_dir/$hook_name"
    if [ ! -d "$target" ] || [ "$deploy_hooks/$hook_name/handler.js" -nt "$target/handler.js" ]; then
      rm -rf "$target"
      cp -r "$deploy_hooks/$hook_name" "$target"
      echo "[entrypoint] Deployed hook: $hook_name"
    fi
  done
  chown -R 1000:1000 "$hooks_dir"
  echo "[entrypoint] Hooks ready"
else
  echo "[entrypoint] No hooks to deploy"
fi
```

### 3. Playbook 04: add section 4.8g after 4.8f

```markdown
## 4.8g Deploy Managed Hooks

Custom managed hooks live in `deploy/hooks/<name>/` (HOOK.md + handler.js). The entrypoint copies them to `~/.openclaw/hooks/` on boot, and `openclaw.json` enables them via `hooks.internal.entries`.

SCP hooks to the VPS:

[bash block with scp + chown, same pattern as 4.8f plugins]
```

To add a new hook: create `deploy/hooks/<name>/` with HOOK.md + handler.js, add an entry to `openclaw.json` under `hooks.internal.entries`, SCP to VPS, restart.

## Verification

- Entrypoint logs show `Deployed hook: debug-logger` and `Hooks ready`
- `~/.openclaw/hooks/debug-logger/handler.js` exists inside the container
- Gateway loads the hook (check logs for hook registration)
- After a chat interaction, `~/.openclaw/logs/debug.log` contains JSONL entries
