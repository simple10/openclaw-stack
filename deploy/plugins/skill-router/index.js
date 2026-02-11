// Skill Router Plugin
// Rewrites skill descriptions in the system prompt so the main agent (no network)
// automatically delegates network-requiring skills to a sub-agent (bridge network).
//
// Config example (in openclaw.json → plugins.entries.skill-router.config):
//   { "rules": [{ "agent": "main", "delegateTo": "skills", "skills": ["gifgrep"] }] }

module.exports = {
  id: "skill-router",

  register(api) {
    const rules = api.pluginConfig?.rules || [];

    if (rules.length === 0) {
      api.logger.info("[skill-router] No routing rules configured");
      return;
    }

    // Build lookup: { agentId → Map<skillName, delegateTo> }
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

    api.logger.info(`[skill-router] Loaded ${rules.length} routing rules`);

    api.on("before_agent_start", async (event, ctx) => {
      const agentId = ctx.agentId;
      const agentRules = routingMap.get(agentId);

      if (!agentRules || agentRules.size === 0) return;

      // Rewrite <description> tags for delegated skills in the system prompt.
      // Skill blocks follow the pattern:
      //   <skill><name>X</name><description>Y</description>...</skill>
      let modified = event.prompt;
      let count = 0;

      modified = modified.replace(
        /<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>/gs,
        (match, name, desc) => {
          const delegateTo = agentRules.get(name.trim());
          if (!delegateTo) return match;

          count++;
          const newDesc =
            `DELEGATED — Do NOT run ${name.trim()} directly. ` +
            `Use sessions_spawn with agentId: '${delegateTo}' ` +
            `and include the user's request in the task.`;
          return match.replace(
            `<description>${desc}</description>`,
            `<description>${newDesc}</description>`
          );
        }
      );

      if (count > 0) {
        api.logger.info(
          `[skill-router] Rewrote ${count} skill descriptions for agent ${agentId}`
        );
        return { systemPrompt: modified };
      }
    });
  },
};
