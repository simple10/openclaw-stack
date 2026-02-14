// Coordinator Plugin
// Builds a sub-agent routing table from agent configs and injects it into the
// coordinator agent's context via prependContext. Combined with per-agent skill
// filtering (agents.list[].skills in openclaw.json), the coordinator delegates
// skill-based tasks to the appropriate sub-agent via sessions_spawn.
//
// Config (in openclaw.json -> plugins.entries.coordinator.config):
//   coordinatorAgent: agent ID that acts as coordinator (default: "main")
//   routes: static fallback routes if api.runtime is unavailable

// Gateway package.json has "type": "module" — plugins must use ESM exports
export default {
  id: 'coordinator',

  register(api) {
    const coordinatorAgent = api.pluginConfig?.coordinatorAgent || 'main'

    // Log available API surface for runtime discovery
    api.logger.info(`[coordinator] API keys: ${Object.keys(api).join(', ')}`)

    api.on('before_agent_start', async (event, ctx) => {
      if (ctx.agentId !== coordinatorAgent) return

      // Dynamic: read agent configs from runtime
      let routes = []
      try {
        const agents = api.runtime?.config?.agents?.list || []
        if (agents.length > 0) {
          routes = agents
            .filter(a => a.id !== coordinatorAgent && a.skills?.length > 0)
            .map(a => ({ id: a.id, name: a.name || a.id, skills: a.skills }))
          if (routes.length > 0) {
            api.logger.info(`[coordinator] Built dynamic routes from ${routes.length} agents`)
          }
        }
      } catch (e) {
        api.logger.warn(`[coordinator] runtime config unavailable: ${e.message}`)
      }

      // Fallback: static routes from plugin config
      if (routes.length === 0 && api.pluginConfig?.routes) {
        routes = api.pluginConfig.routes
        api.logger.info('[coordinator] Using static routes from plugin config')
      }

      if (routes.length === 0) {
        api.logger.warn('[coordinator] No sub-agent routes found')
        return
      }

      // Build and inject routing context
      const table = routes
        .map(r => `- **${r.name}** (agentId: \`${r.id}\`): ${r.skills.join(', ')}`)
        .join('\n')

      const prependContext =
        `## Sub-Agent Routing\n\n` +
        `You are a coordinator. You do NOT have skill binaries installed.\n` +
        `When a task requires a skill listed below, delegate to the appropriate ` +
        `sub-agent using \`sessions_spawn\`.\n` +
        `Handle conversation, questions, and general chat directly.\n\n` +
        `### Sub-Agents\n${table}\n\n` +
        `### Delegation\n` +
        `Use \`sessions_spawn\` with the sub-agent's \`agentId\` and include the ` +
        `user's full request.\nWait for the result and relay it to the user.\n`

      api.logger.info(`[coordinator] Injected routing for ${routes.length} sub-agents`)
      return { prependContext }
    })

    api.logger.info('[coordinator] Plugin registered')
  }
}
