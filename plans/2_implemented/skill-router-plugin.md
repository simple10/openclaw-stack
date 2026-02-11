# Plan: Skill Router Plugin for OpenClaw

## Context

Network-requiring skills (gifgrep, weather, etc.) fail in the main agent's sandbox (`network: "none"`). We currently solve this with per-skill workspace override SKILL.md files that rewrite the `description` field to include delegation instructions. This works but doesn't scale — every new skill that needs network requires a manual override file.

**This plugin solves the general problem**: it intercepts the system prompt via the `before_agent_start` hook and rewrites skill descriptions based on configurable routing rules, so the main agent automatically delegates skills that require capabilities its sandbox lacks.

**Why a plugin (not prependContext)**: We proved that the skill `description` field is the only reliable channel — AGENTS.md and other workspace docs were overridden by the skill system's "read SKILL.md, follow it" instruction. Prepending context is the same tier as AGENTS.md. Modifying descriptions in the prompt itself is the proven mechanism.

**Key finding**: The `before_agent_start` hook type already defines `systemPrompt` return value, and the merge function in `hooks.ts` handles it, but `attempt.ts` never checks it — only `prependContext` is implemented. A 2-line patch to `attempt.ts` enables `systemPrompt` support, letting the plugin modify the prompt directly.

## Files to create/modify

| File | Change |
|------|--------|
| `deploy/plugins/skill-router/index.js` | **New** — plugin code |
| `deploy/plugins/skill-router/openclaw.plugin.json` | **New** — plugin manifest |
| `deploy/build-openclaw.sh` | Add patch #2: `attempt.ts` systemPrompt support |
| `deploy/entrypoint-gateway.sh` | Replace section 1h: copy plugin to extensions dir |
| `deploy/docker-compose.override.yml` | Replace `deploy/skills` mount with `deploy/plugins` mount |
| VPS `openclaw.json` | Add plugin config with delegation rules |

### Cleanup (remove old approach)

| File | Change |
|------|--------|
| `deploy/skills/gifgrep/SKILL.md` | **Delete** — replaced by plugin |
| `deploy/entrypoint-gateway.sh` | Remove old section 1h (skill override copying) |
| `deploy/docker-compose.override.yml` | Remove `deploy/skills` bind mount |

## Changes

### 1. Source patch: `attempt.ts` systemPrompt support

Add to `deploy/build-openclaw.sh` as patch #2. The types (`PluginHookBeforeAgentStartResult.systemPrompt`) and merge function (`hooks.ts:192`) already handle this — only the runner is missing it.

**Patch target**: `src/agents/pi-embedded-runner/run/attempt.ts` (~line 740)

```
Before:
            if (hookResult?.prependContext) {
              effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;

After:
            if (hookResult?.systemPrompt) {
              effectivePrompt = hookResult.systemPrompt;
            } else if (hookResult?.prependContext) {
              effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
```

Auto-skip: check `grep -q 'hookResult?.systemPrompt' attempt.ts` before patching.

### 2. Plugin: `deploy/plugins/skill-router/openclaw.plugin.json`

```json
{
  "id": "skill-router",
  "name": "Skill Router",
  "description": "Automatically delegates skills to sub-agents based on sandbox capabilities",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "rules": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "agent": { "type": "string", "description": "Agent ID to apply this rule to" },
            "delegateTo": { "type": "string", "description": "Agent ID to delegate to" },
            "skills": { "type": "array", "items": { "type": "string" }, "description": "Skill names to delegate" }
          },
          "required": ["agent", "delegateTo", "skills"]
        }
      }
    },
    "required": ["rules"]
  }
}
```

### 3. Plugin: `deploy/plugins/skill-router/index.js`

Plain JS (no build step needed). Core logic:

```javascript
module.exports = {
  id: "skill-router",

  register(api) {
    const rules = api.pluginConfig?.rules || [];

    if (rules.length === 0) {
      api.logger.info("[skill-router] No routing rules configured");
      return;
    }

    // Build lookup: { agentId: { skillName: delegateTo } }
    const routingMap = new Map();
    for (const rule of rules) {
      if (!routingMap.has(rule.agent)) {
        routingMap.set(rule.agent, new Map());
      }
      const agentRules = routingMap.get(rule.agent);
      for (const skill of rule.skills) {
        agentRules.set(skill, rule.delegateTo);
      }
    }

    api.logger.info(`[skill-router] Loaded ${rules.length} rules`);

    api.on("before_agent_start", async (event, ctx) => {
      const agentId = ctx.agentId;
      const agentRules = routingMap.get(agentId);

      if (!agentRules || agentRules.size === 0) return;

      // Parse and rewrite <description> tags for delegated skills
      let modified = event.prompt;
      let count = 0;

      // Match <skill>...<name>X</name>...<description>Y</description>...</skill> blocks
      modified = modified.replace(
        /<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>/gs,
        (match, name, desc) => {
          const delegateTo = agentRules.get(name.trim());
          if (!delegateTo) return match;

          count++;
          const newDesc = `DELEGATED — Do NOT run ${name.trim()} directly. ` +
            `Use sessions_spawn with agentId: '${delegateTo}' ` +
            `and include the user's request in the task.`;
          return match.replace(
            `<description>${desc}</description>`,
            `<description>${newDesc}</description>`
          );
        }
      );

      if (count > 0) {
        api.logger.info(`[skill-router] Rewrote ${count} skill descriptions for agent ${agentId}`);
        return { systemPrompt: modified };
      }
    });
  }
};
```

### 4. Build script patch: `deploy/build-openclaw.sh`

Add patch #2 after the existing Dockerfile patch:

```bash
# ── 2. Patch attempt.ts to support systemPrompt in before_agent_start hook ──
# The hook type and merge function already handle systemPrompt, but the runner
# only checks prependContext. This enables plugins to modify the full prompt.
ATTEMPT_FILE="src/agents/pi-embedded-runner/run/attempt.ts"
if [ -f "$ATTEMPT_FILE" ] && ! grep -q 'hookResult?.systemPrompt' "$ATTEMPT_FILE"; then
  echo "[build] Patching attempt.ts for systemPrompt support..."
  sed -i 's/if (hookResult?.prependContext) {/if (hookResult?.systemPrompt) {\n              effectivePrompt = hookResult.systemPrompt;\n              log.debug(`hooks: replaced system prompt via systemPrompt (${hookResult.systemPrompt.length} chars)`);\n            } else if (hookResult?.prependContext) {/' "$ATTEMPT_FILE"
else
  echo "[build] attempt.ts already supports systemPrompt (already patched or upstream fix)"
fi
```

Update the git checkout restore on line 30 to also restore `attempt.ts`:

```bash
git checkout -- Dockerfile "$ATTEMPT_FILE" 2>/dev/null || true
```

### 5. Entrypoint: `deploy/entrypoint-gateway.sh`

**Replace** section 1h (skill override copying) with plugin deployment:

```bash
# ── 1h. Deploy plugins to global extensions dir ────────────────────
# Plugins from deploy/plugins/ are copied to ~/.openclaw/extensions/
# where the gateway discovers them automatically.
global_extensions="/home/node/.openclaw/extensions"
deploy_plugins="/app/deploy/plugins"
if [ -d "$deploy_plugins" ]; then
  mkdir -p "$global_extensions"
  for plugin_dir in "$deploy_plugins"/*/; do
    plugin_name=$(basename "$plugin_dir")
    target="$global_extensions/$plugin_name"
    # Copy if new or source is newer
    if [ ! -d "$target" ] || [ "$deploy_plugins/$plugin_name/index.js" -nt "$target/index.js" ]; then
      rm -rf "$target"
      cp -r "$deploy_plugins/$plugin_name" "$target"
      echo "[entrypoint] Deployed plugin: $plugin_name"
    fi
  done
  chown -R 1000:1000 "$global_extensions"
  echo "[entrypoint] Plugins ready"
else
  echo "[entrypoint] No plugins to deploy"
fi
```

### 6. Compose: `deploy/docker-compose.override.yml`

Replace the `deploy/skills` bind mount with:

```yaml
- ./deploy/plugins:/app/deploy/plugins:ro
```

### 7. VPS `openclaw.json` — plugin configuration

Add to the existing `openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "skill-router": {
        "enabled": true,
        "config": {
          "rules": [
            {
              "agent": "main",
              "delegateTo": "skills",
              "skills": ["gifgrep"]
            }
          ]
        }
      }
    }
  }
}
```

Adding a new delegated skill is just appending to the `skills` array — no files to create.

## Deploy steps

1. SCP `deploy/plugins/skill-router/` to VPS
2. SCP updated `deploy/build-openclaw.sh` to VPS
3. SCP updated `deploy/entrypoint-gateway.sh` to VPS
4. Update compose to mount `deploy/plugins` instead of `deploy/skills`
5. Rebuild image: `sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh`
6. Update `openclaw.json` with plugin config
7. Restart: `docker compose down && docker compose up -d`
8. Remove old `deploy/skills/` directory from VPS

## Verification

1. **Build**: `build-openclaw.sh` logs both patches applied
2. **Entrypoint**: Logs show `Deployed plugin: skill-router` and `Plugins ready`
3. **Plugin loaded**: Gateway logs should show plugin registration
4. **Webchat test**: Start new session, run `/gifgrep cats`
   - Main agent should see DELEGATED description → calls `sessions_spawn`
   - Skills agent runs gifgrep with network → returns results
5. **AI Gateway log**: Check the system prompt — `<description>` for gifgrep should contain "DELEGATED"
6. **Non-delegated skills**: Other skills (coding-agent, healthcheck) should work normally (descriptions unchanged)
7. **Skills agent**: Verify skills agent still sees original descriptions (plugin only modifies for `agent: "main"`)
