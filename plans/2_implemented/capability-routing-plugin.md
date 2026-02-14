# Plan: Coordinator Plugin — Capability-Based Agent Routing

## Context

The `skill-router` plugin tried to rewrite skill descriptions via `before_agent_start`, but that hook fires before skills are injected — so it never worked. We proved that OpenClaw's native per-agent `"skills"` filter works: adding `"skills": ["gifgrep"]` to an agent config filters `<available_skills>` to only show listed skills.

This plan replaces the broken plugin with a **coordinator plugin** that dynamically builds a routing table from agent configs and injects it via `prependContext`. Combined with per-agent skill filtering, the main agent becomes a pure coordinator: no skills of its own, but knows exactly what each sub-agent can do and delegates accordingly.

**Why a plugin?** Plugins are the natural home for features not built into core OpenClaw. The coordinator pattern — reading agent configs, building routing tables, injecting context — maps cleanly to the plugin API (`api.on`, `api.runtime`, `prependContext`). It's portable, distributable, and ready to leverage new OpenClaw APIs as they mature.

**Why not a skill or AGENTS.md?** A skill creates a "Skills (mandatory)" conflict (instructions to use skills vs. instructions to delegate them). AGENTS.md modifications require custom workspace file management. The plugin avoids both — it injects routing context via `prependContext` (outside `<available_skills>`) and needs no per-agent file customization.

**Pattern**: Coordinator (main, `skills: []`) + 2 Workers (code, skills — filtered)

## Skill Assignment

| Agent | Skills filter |
|-------|--------------|
| **main** | `[]` — no skills, pure coordinator |
| **code** | `coding-agent`, `github`, `clawhub`, `skill-creator` (4) |
| **skills** | `blogwatcher`, `gemini`, `gifgrep`, `healthcheck`, `himalaya`, `mcporter`, `nano-pdf`, `openai-image-gen`, `openai-whisper-api`, `oracle`, `ordercli`, `tmux`, `video-frames`, `wacli`, `weather` (15) |

## Auto-Discovery Flow

When a user installs a new skill:

1. User installs skill globally (e.g. `jira` → `~/.openclaw/skills/jira/`)
2. User adds `"jira"` to the appropriate agent's `"skills"` filter in `openclaw.json`
3. Gateway restart
4. Plugin reads updated agent configs → routing table automatically includes `jira` under the correct agent
5. Main agent gets updated routing context on next message

Only step 2 is manual — and it's the natural config step (deciding which agent handles the new skill).

## Changes

### 1. NEW: `deploy/plugins/coordinator/` — Coordinator plugin (3 files)

**`index.js`** — Plugin logic:

- Hooks `before_agent_start` for the coordinator agent (configurable, defaults to `main`)
- Reads agent configs dynamically via `api.runtime` to get each agent's `skills` array
- Falls back to static routes from plugin config if `api.runtime` isn't available
- Builds a routing table and injects it via `prependContext`
- Routing context includes: sub-agent table, `sessions_spawn` usage, when to delegate vs handle directly

```javascript
export default {
  id: 'coordinator',
  register(api) {
    const coordinatorAgent = api.pluginConfig?.coordinatorAgent || 'main';

    api.on('before_agent_start', async (event, ctx) => {
      if (ctx.agentId !== coordinatorAgent) return;

      // Dynamic: read agent configs from runtime
      let routes = [];
      try {
        const agents = api.runtime?.config?.agents?.list || [];
        routes = agents
          .filter(a => a.id !== coordinatorAgent && a.skills?.length > 0)
          .map(a => ({ id: a.id, name: a.name || a.id, skills: a.skills }));
      } catch (e) {
        api.logger.warn(`[coordinator] runtime config unavailable: ${e.message}`);
      }

      // Fallback: static routes from plugin config
      if (routes.length === 0 && api.pluginConfig?.routes) {
        routes = api.pluginConfig.routes;
        api.logger.info('[coordinator] Using static routes from plugin config');
      }

      if (routes.length === 0) {
        api.logger.warn('[coordinator] No sub-agent routes found');
        return;
      }

      // Build and inject routing context
      const table = routes
        .map(r => `- **${r.name}** (agentId: \`${r.id}\`): ${r.skills.join(', ')}`)
        .join('\n');

      const prependContext = `## Sub-Agent Routing\n\n` +
        `You are a coordinator. You do NOT have skill binaries installed.\n` +
        `When a task requires a skill listed below, delegate to the appropriate ` +
        `sub-agent using \`sessions_spawn\`.\n` +
        `Handle conversation, questions, and general chat directly.\n\n` +
        `### Sub-Agents\n${table}\n\n` +
        `### Delegation\n` +
        `Use \`sessions_spawn\` with the sub-agent's \`agentId\` and include the ` +
        `user's full request.\nWait for the result and relay it to the user.\n`;

      api.logger.info(`[coordinator] Injected routing for ${routes.length} sub-agents`);
      return { prependContext };
    });

    api.logger.info('[coordinator] Plugin registered');
  }
};
```

**`openclaw.plugin.json`** — Plugin manifest with config schema.

**`README.md`** — Plugin documentation (what it does, config, auto-discovery flow).

### 2. `deploy/openclaw.json` — Add skill filters, replace plugin config

**Add skill filters** to each agent (inside agent config objects):

- Main (after `"default": true`): `"skills": []`
- Code: `"skills": ["coding-agent", "github", "clawhub", "skill-creator"]`
- Skills: `"skills": ["blogwatcher", "gemini", "gifgrep", ...]` (all 15)

**Replace `plugins` block** (lines 220-253) — swap `skill-router` for `coordinator`:

```json5
"plugins": {
  "enabled": true,
  "allow": ["coordinator"],
  "entries": {
    "coordinator": {
      "enabled": true,
      "config": {
        "coordinatorAgent": "main",
        // Static fallback routes — used only if api.runtime unavailable.
        // When api.runtime works, routes are built dynamically from agents.list[].skills.
        "routes": [
          { "id": "code", "name": "Code Agent", "skills": [...] },
          { "id": "skills", "name": "Skills Agent", "skills": [...] }
        ]
      }
    }
  }
}
```

**Update comments:** Replace skill-router references with coordinator explanations. Keep `/opt/skill-bins` comments (shims still needed for gateway-level skill binary checks).

### 3. `deploy/build-openclaw.sh` — Remove patch #2

Remove the `attempt.ts` patch (lines 27-36). It added `systemPrompt` to the `before_agent_start` hook — only needed for skill-router. The coordinator uses `prependContext` which is natively supported.

Update header comment, renumber patch #3 → #2. Keep patches #1 (Dockerfile Docker+gosu) and #3→#2 (docker.ts env vars).

### 4. `deploy/entrypoint-gateway.sh` — Update comments only

Update section 1h comment (lines 118-119) to remove skill-router reference. No structural changes — the existing plugin deployment loop handles the coordinator plugin automatically.

### 5. `deploy/docker-compose.override.yml` — Update comments only

Update plugins mount comment (line 51) to remove skill-router reference. No new volume mounts needed.

### 6. DELETE: `deploy/plugins/skill-router/` (3 files)

- `index.js`, `openclaw.plugin.json`, `README.md` — replaced by `deploy/plugins/coordinator/`

## Session Cache Gotcha

After changing skill filters, the gateway's session store caches old `skillsSnapshot` entries. Must be cleared for changes to take effect. Deployment steps handle this.

## Deployment Steps

1. SCP updated `deploy/` dir to VPS staging
2. Template-substitute `openclaw.json` (replace `{{GATEWAY_TOKEN}}`, `{{OPENCLAW_DOMAIN_PATH}}`)
3. Deploy `openclaw.json` to `/home/openclaw/.openclaw/openclaw.json`
4. Remove old plugin: `rm -rf /home/openclaw/.openclaw/extensions/skill-router`
5. Clear session caches (force skill snapshot rebuild):

   ```bash
   docker exec openclaw-gateway sh -c 'find /home/node/.openclaw/agents -name "sessions.json" -exec sh -c '"'"'echo "{}" > "$1"'"'"' _ {} \;'
   ```

6. Restart gateway: `docker compose restart openclaw-gateway`
7. Verify (see below)

## Verification

1. **Plugin loaded**: Gateway logs show `[coordinator] Plugin registered`
2. **Routing injected**: Gateway logs show `[coordinator] Injected routing for 2 sub-agents` on first message
3. **Skill filters applied**: `grep "skill filter"` in gateway logs — main shows `(none)`, code/skills show their filtered lists
4. **Delegation test**: Send "find me a funny cat GIF" → main delegates to skills agent via `sessions_spawn`
5. **Direct handling test**: Send "what time is it?" → main responds directly
6. **No skill-router remnants**: No `skill-router` in gateway logs

## Implementation Note: `api.runtime` Verification

The `api.runtime` API needs to be probed during implementation:

1. Add `api.logger.info(JSON.stringify(Object.keys(api)))` to dump available API surface
2. If `api.runtime?.config?.agents?.list` works → dynamic routing is active
3. If not → static fallback from plugin config kicks in automatically
4. Log which path was taken so we know what worked

## Files Summary

| Action | File |
|--------|------|
| Create | `deploy/plugins/coordinator/index.js` |
| Create | `deploy/plugins/coordinator/openclaw.plugin.json` |
| Create | `deploy/plugins/coordinator/README.md` |
| Edit | `deploy/openclaw.json` |
| Edit | `deploy/build-openclaw.sh` |
| Edit | `deploy/entrypoint-gateway.sh` (comments only) |
| Edit | `deploy/docker-compose.override.yml` (comments only) |
| Delete | `deploy/plugins/skill-router/index.js` |
| Delete | `deploy/plugins/skill-router/openclaw.plugin.json` |
| Delete | `deploy/plugins/skill-router/README.md` |
