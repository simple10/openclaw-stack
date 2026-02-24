# Coordinator Plugin

Auto-discovers sub-agent routes from `openclaw.json` agent configs and writes a routing table to the coordinator agent's `AGENTS.md` workspace file, enabling capability-based task delegation via the system prompt.

## Why

The coordinator pattern splits agents by capability: a main agent handles conversation and delegates skill-based tasks to specialized sub-agents. This plugin automates the routing — it reads each agent's `skills` array from `openclaw.json` and writes a routing table to `AGENTS.md` so the coordinator knows exactly which sub-agent handles each skill.

## How It Works

1. Gateway loads the plugin from `~/.openclaw/extensions/coordinator/`
2. At **registration time**, the plugin calls `api.runtime.config.loadConfig()` to read agent configs
3. It builds routes from agents that have a non-empty `skills` array (excluding the coordinator)
4. The routing section is written to:
   - The template workspace `AGENTS.md` (so new sandboxes inherit it)
   - The coordinator agent's existing sandbox `AGENTS.md` (for immediate effect)
5. OpenClaw's native workspace file injection loads `AGENTS.md` into the **system prompt**
6. The coordinator uses `sessions_spawn` to delegate skill tasks to the right sub-agent
7. On `before_agent_start`, the plugin also writes to `ctx.workspaceDir` to catch any new sandboxes created between restarts

### Single Source of Truth

The agent's `"skills"` array in `openclaw.json` is the single source of truth. It controls two things:
- **Skill filtering** (OpenClaw core): which skills appear in the agent's system prompt
- **Routing** (this plugin): which agent the coordinator delegates to for each skill

No duplicate route configuration is needed. Add a skill to an agent's `skills` array, restart, and the coordinator automatically knows about it.

### Why AGENTS.md?

OpenClaw only injects a [hardcoded list of workspace files](https://github.com/openclaw/openclaw/blob/main/src/agents/workspace.ts) into the system prompt (AGENTS.md, SOUL.md, TOOLS.md, etc.). Custom filenames like `ROUTING.md` are not auto-discovered. AGENTS.md is the natural home for agent instructions and routing context.

The routing section is wrapped in HTML comment sentinels (`<!-- coordinator-plugin:start -->` / `<!-- coordinator-plugin:end -->`) so it can be updated without disturbing user content.

## Plugin Files

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest — `id`, `name`, `version`, and `configSchema` |
| `index.js` | Plugin logic — auto-discovers routes and writes routing table to AGENTS.md |

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
          "coordinatorAgent": "main"
        }
      }
    }
  }
}
```

### Config fields

- **`coordinatorAgent`** — Agent ID that acts as coordinator (default: `"main"`)
- **`routes`** *(optional)* — Static fallback routes, only used if `loadConfig()` is unavailable. Normally not needed since routes are auto-discovered from agent configs.

## Adding a New Skill

1. Install the skill globally (e.g. `~/.openclaw/skills/jira/`)
2. Add `"jira"` to the appropriate agent's `"skills"` array in `openclaw.json`
3. Restart gateway — plugin reads updated agent configs and writes updated routing to AGENTS.md
4. Clear session caches if needed (see below)

Only step 2 is manual — deciding which agent handles the new skill.

## Deployment

The entrypoint (section 1h) copies this plugin from `/app/deploy/plugins/coordinator/` to `~/.openclaw/extensions/coordinator/` on boot. The compose override bind-mounts `deploy/plugins/` read-only into the container.

To update after changes: SCP to VPS, restart the gateway.

## Session Cache

After changing skill filters, clear session caches to force a skill snapshot rebuild:
```bash
docker exec openclaw-main-claw sh -c 'find /home/node/.openclaw/agents -name "sessions.json" -exec sh -c '"'"'echo "{}" > "$1"'"'"' _ {} \;'
```

## Technical Notes

- **Routes are auto-discovered** — the plugin calls `api.runtime.config.loadConfig()` which returns the full `OpenClawConfig` including `agents.list` with each agent's `skills` array
- **Static fallback** — if `loadConfig()` is unavailable, the plugin falls back to `routes` in plugin config (optional, normally not configured)
- **AGENTS.md is written at registration time** — before any messages, so the system prompt has routing context from the first interaction
- **The `before_agent_start` hook** is kept as a fallback to catch new sandboxes created after registration
- **No `prependContext`** — earlier versions used `prependContext` which polluted the user message bubble in the chat UI. The AGENTS.md approach puts routing in the system prompt cleanly
