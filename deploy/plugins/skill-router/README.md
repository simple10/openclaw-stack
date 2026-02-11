# Skill Router Plugin

Automatically delegates skills from one agent to another by rewriting skill descriptions in the system prompt at agent startup.

## Why

The main agent's sandbox runs with `network: "none"` — skills that need network access (gifgrep, weather, etc.) fail silently. The skills agent has `network: "bridge"` but doesn't receive slash commands directly. This plugin bridges the gap: when the main agent starts, it sees "DELEGATED" instructions for configured skills and uses `sessions_spawn` to hand them off to the skills agent.

## How It Works

1. Gateway loads the plugin from `~/.openclaw/extensions/skill-router/`
2. On `before_agent_start`, the plugin reads routing rules from its config
3. For the matching agent, it finds `<skill><name>X</name><description>...</description></skill>` blocks in the system prompt
4. Matched skill descriptions are replaced with delegation instructions pointing to the target agent
5. Non-matching skills are left untouched

## Plugin Files

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest — `id`, `name`, `version`, and `configSchema` (JSON Schema that validates the config and populates the plugins UI) |
| `index.js` | Plugin logic — hooks `before_agent_start`, rewrites skill descriptions |

## Configuration

Configuration lives in **`openclaw.json`**, not in the plugin directory. The plugin reads its config from `plugins.entries.skill-router.config` at load time.

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

### Config fields

- **`plugins.enabled`** — master switch for the plugin system
- **`plugins.entries.skill-router.enabled`** — toggle this plugin on/off without removing its config
- **`plugins.entries.skill-router.config.rules`** — array of routing rules:

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent that should delegate (e.g. `"main"`) |
| `delegateTo` | string | Agent that actually runs the skill (e.g. `"skills"`) |
| `skills` | string[] | Skill names to delegate (e.g. `["gifgrep"]`) |

### `configSchema` in `openclaw.plugin.json`

The `configSchema` field is a JSON Schema that validates the `config` object above. The gateway uses it to validate config at load time and to render settings in the plugins UI. You don't edit `configSchema` to configure the plugin — it defines the *shape* of the config; the actual values go in `openclaw.json`.

## Adding a New Delegated Skill

Append the skill name to the `skills` array in `openclaw.json` and restart:

```json
"skills": ["gifgrep", "weather", "new-skill"]
```

No new files needed. The `delegateTo` agent must have the sandbox capabilities the skill requires (e.g. network access, specific binaries).

## Prerequisites

The gateway needs a source patch to support `systemPrompt` in the `before_agent_start` hook result. This is applied automatically by `build-openclaw.sh` (patch #2 — `attempt.ts`). Without it, the plugin's returned `{ systemPrompt: modified }` is silently ignored.

## Deployment

The entrypoint (section 1h) copies this plugin from `/app/deploy/plugins/skill-router/` to `~/.openclaw/extensions/skill-router/` on boot. The compose override bind-mounts `deploy/plugins/` read-only into the container.

To update after changes: SCP to VPS, restart the gateway.
