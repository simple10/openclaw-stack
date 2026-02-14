# Coordinator Plugin

Dynamically builds a sub-agent routing table and injects it into the coordinator agent's context, enabling capability-based task delegation.

## Why

The coordinator pattern splits agents by capability: a main agent handles conversation and delegates skill-based tasks to specialized sub-agents. This plugin automates the routing — it reads each agent's `skills` filter from `openclaw.json` and tells the coordinator exactly which sub-agent handles each skill.

## How It Works

1. Gateway loads the plugin from `~/.openclaw/extensions/coordinator/`
2. On `before_agent_start` for the coordinator agent, the plugin reads agent configs
3. It builds a routing table from each agent's `skills` array
4. The table is injected via `prependContext` (outside `<available_skills>`)
5. The coordinator uses `sessions_spawn` to delegate skill tasks to the right sub-agent

### Skill Filtering

Per-agent skill filtering is configured in `openclaw.json` via `agents.list[].skills`:
- `"skills": []` — agent sees no skills (pure coordinator)
- `"skills": ["gifgrep", "weather"]` — agent only sees listed skills

The plugin reads these arrays to build the routing table automatically.

## Plugin Files

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest — `id`, `name`, `version`, and `configSchema` |
| `index.js` | Plugin logic — hooks `before_agent_start`, builds routing table, injects via `prependContext` |

## Configuration

Configuration lives in **`openclaw.json`**, not in the plugin directory.

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["coordinator"],
    "entries": {
      "coordinator": {
        "enabled": true,
        "config": {
          "coordinatorAgent": "main",
          // Static fallback — only used if api.runtime is unavailable
          "routes": [
            { "id": "code", "name": "Code Agent", "skills": ["coding-agent", "github"] },
            { "id": "skills", "name": "Skills Agent", "skills": ["gifgrep", "weather"] }
          ]
        }
      }
    }
  }
}
```

### Config fields

- **`coordinatorAgent`** — Agent ID that receives routing context (default: `"main"`)
- **`routes`** — Static fallback routes, used only when `api.runtime` is unavailable:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Sub-agent ID (e.g. `"skills"`) |
| `name` | string | Display name (e.g. `"Skills Agent"`) |
| `skills` | string[] | Skills this sub-agent handles |

## Auto-Discovery

When a new skill is installed:
1. Install skill globally (e.g. `~/.openclaw/skills/jira/`)
2. Add `"jira"` to the appropriate agent's `"skills"` array in `openclaw.json`
3. Restart gateway
4. Plugin reads updated configs — routing table automatically includes the new skill
5. Coordinator gets updated context on next message

Only step 2 is manual — deciding which agent handles the new skill.

## Deployment

The entrypoint (section 1h) copies this plugin from `/app/deploy/plugins/coordinator/` to `~/.openclaw/extensions/coordinator/` on boot. The compose override bind-mounts `deploy/plugins/` read-only into the container.

To update after changes: SCP to VPS, restart the gateway.

## Session Cache

After changing skill filters, clear session caches to force a skill snapshot rebuild:
```bash
docker exec openclaw-gateway sh -c 'find /home/node/.openclaw/agents -name "sessions.json" -exec sh -c '"'"'echo "{}" > "$1"'"'"' _ {} \;'
```
