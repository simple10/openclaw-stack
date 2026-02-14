> we need to automate it as much as possible. otherwise there's no point in the skill routing and we might as well put
> them all on the main agent and just be done with it. let's take a step back and consider the root problem we're trying
> to solve: capability routing. We want to be able to easily create different agents that have different capabilities and
> access to data. e.g. a Personal Assistant agent that has access to my personal gmail account but doesn't have access to
> my bank login (i.e. no browser capability). That's ultimately what we're after. A flexible an intuitive config system
> that makes designing complicated and secure systems as easy as possible. The actual skills routing was just the first
> example we ran into. But we're really after a broader solution.
>
> So let's go back and forth for a bit. How about you come up with some example agents based on different network, tool
> and bins (skills) capabilities and let's design out our ideal config structure for how that might look (ignoring
> Openclaw limitations for a moment). Then we'll work backwards from the ideal.

⏺ Great framing. Let me think about this from the capability perspective.

  Example Agents by Capability Profile

  1. Main (Personal Assistant)

- Network: none (can't exfiltrate)
- Browser: sandbox (research, no host credentials)
- Data: personal files, memory, calendar context
- Can't do: anything requiring outbound network (API calls, email, GIF search, weather)

  1. Skills (Network Utility Runner)

- Network: bridge (internet access)
- Browser: none
- Data: none (no personal files, no memory)
- Can do: gifgrep, weather, web scraping, API calls
- Can't do: read personal data, access browser sessions

  1. Comms (Communication Agent)

- Network: bridge (email/messaging APIs)
- Browser: none
- Data: contacts, message templates (but not personal docs)
- Skills: himalaya, wacli, slack
- Can't do: browse the web, access financial data

  1. Code (Development Agent)

- Network: bridge (npm, pip, git clone)
- Browser: sandbox (for docs)
- Data: project repos only
- Skills: github, coding-agent
- Can't do: access personal files, send messages

  1. Finance (Sensitive Operations)

- Network: bridge (bank APIs only, restricted)
- Browser: isolated (bank credentials stored here)
- Data: financial records only
- Can't do: access personal messages, send emails

  Ideal Config (Ignoring OpenClaw Limitations)

```jsonc
  {
    agents: {
      defaults: {
        model: "claude-sonnet-4-5",
        // Secure by default — agents get nothing unless granted
        network: false,
        browser: false,
      },

      list: {
        main: {
          description: "Personal assistant — direct conversations",
          model: "claude-opus-4-6",

          // What this agent HAS
          capabilities: {
            network: false,
            browser: "sandbox",
            data: ["personal-files", "memory", "calendar"],
          },

          // What happens when a skill needs something this agent lacks
          routing: "auto",
          // ^ system automatically finds an agent with matching capabilities
          // or explicit overrides:
          // routing: { network: "skills", browser: "code" }
        },

        skills: {
          description: "Network utility runner — no personal data access",
          capabilities: {
            network: true,
            browser: false,
            data: [],  // explicitly: no data access
          },
        },

        comms: {
          description: "Communication — email, messaging, notifications",
          capabilities: {
            network: true,
            browser: false,
            data: ["contacts"],
          },
          skills: { allow: ["himalaya", "wacli", "slack"] },
        },

        code: {
          description: "Development — repos, builds, CI",
          capabilities: {
            network: true,
            browser: "sandbox",
            data: ["projects"],
          },
          skills: { allow: ["github", "coding-agent"] },
        },

        finance: {
          description: "Banking and expenses — isolated credentials",
          capabilities: {
            network: "restricted",  // allowlist of domains
            browser: "isolated",    // separate browser profile
            data: ["financial"],
          },
          networkAllowlist: ["api.bank.com", "plaid.com"],
        },
      },
    },

    // Skills declare what they NEED (could live in SKILL.md frontmatter)
    // This is metadata, not config — but shows the matching concept:
    //
    // gifgrep:   { requires: { network: true, bins: ["gifgrep"] } }
    // himalaya:  { requires: { network: true, bins: ["himalaya"] } }
    // github:    { requires: { network: true, bins: ["gh"] } }
    // tmux:      { requires: { bins: ["tmux"] } }  // no network needed
  }
```

  The key ideas:

  1. Capabilities, not routing rules — agents declare what they HAVE, skills declare what they NEED. The system matches
  automatically. No manual delegateTo mappings.
  2. Secure by default — agents get nothing unless explicitly granted. Main agent has no network, so anything requiring network
   gets auto-routed.
  3. Data scoping — agents can only access specific data domains. The comms agent can see contacts but not financial records.
  4. Routing is derived — if main gets a gifgrep request, the system sees gifgrep needs network: true, main doesn't have it,
  finds skills agent does → auto-delegates. No config entry needed per skill.
  5. Explicit overrides when needed — routing: { network: "skills" } for when auto-matching isn't enough.

  What's your reaction? Too abstract? Not abstract enough? Different capability dimensions you'd want?

---

> that's great. now we're thinking alike. i like the framing of agents defining their capabilities and then skills
> defining requirements. good separation of concerns. it sounds like we need a meta agent. the router agent. We have full
> control of the AGENTS.md and other files per agent. So if we make the main agent the meta router, let's explore how far
> we can get by just customizing the markdown files. How far would markdown get us? And what would still be missing?

⏺ Markdown gets us surprisingly far. Here's what it looks like and where it breaks down.

  What Markdown Routing Looks Like

  The main agent's AGENTS.md would have something like:

## Capability Routing

  You are the router. Before executing any task, check what it requires
  against the capability table. Handle it yourself or delegate.

### Agent Capabilities

  | Agent | Network | Browser | Data Access |
  |-------|---------|---------|-------------|
  | main (you) | ❌ | sandbox | personal files, memory |
  | skills | ✅ | ❌ | none |
  | code | ✅ | sandbox | project repos |
  | comms | ✅ | ❌ | contacts |

### Routing Rules

- Needs internet → `skills`
- Needs git/GitHub → `code`
- Needs email/messaging → `comms`
- Local file ops, thinking, memory → handle yourself

### How to Delegate

  sessions_spawn({ task: "<full user request>", agentId: "<agent>" })

  What Markdown Handles Well

- Routing decisions — LLMs are great at matching "user wants a GIF" → "needs network" → "delegate to skills"
- Delegation mechanics — sessions_spawn already works, agents already report back
- Per-agent identity — each agent's AGENTS.md/SOUL.md defines its own scope and behavior
- Flexible logic — complex routing trees, fallback chains, "try X then Y" all expressible in natural language
- Zero code changes — no patches, no plugins, no rebuilds

  Where Markdown Falls Short

  1. Skill description conflict (the problem we just hit)
  The hardcoded "Skills (mandatory)" section tells the LLM: "scan <available_skills>, find a match, read its SKILL.md, follow
  it." If gifgrep appears in the main agent's skill list, the LLM sees two competing instructions:

- Skills section: "gifgrep matches → read SKILL.md → run gifgrep search cats"
- AGENTS.md: "needs network → delegate to skills agent"

  The skills instruction is labeled "mandatory" and appears before AGENTS.md in the prompt. It may win.

  1. Skill visibility — no per-agent filtering
  All skills from /app/skills/ appear in <available_skills> for every agent. The main agent sees gifgrep even though it can't
  run it. We can't hide skills via markdown.

  2. Soft enforcement only
  Markdown is a suggestion. The LLM might ignore routing and try to run gifgrep directly. It would fail (no network in the
  sandbox), waste a turn, then hopefully delegate. Bad UX but not a security hole — the Docker network boundary is the real
  enforcement.

  3. No data isolation
  AGENTS.md can say "don't access financial data" but the filesystem mounts determine what's actually reachable. Markdown is
  policy, not enforcement.

  4. Token cost
  The routing table is in every single LLM request, even for "what time is it?" Capability tables for 5+ agents add up.

  5. Skill requirements aren't declared
  Skills don't currently say what they need. gifgrep's SKILL.md says "run gifgrep search" but never says "requires: network."
  The routing table has to hardcode this knowledge — it can't be derived automatically.

  Summary

  ┌──────────────────────┬────────────────────┬───────────────────────────────────────────┐
  │       Concern        │     Markdown?      │              What's Missing               │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Routing decisions    │ ✅ works well      │ —                                         │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Delegation mechanics │ ✅ sessions_spawn  │ —                                         │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Per-agent behavior   │ ✅ workspace files │ —                                         │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Skill conflicts      │ ❌                 │ Skills "mandatory" overrides AGENTS.md    │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Skill visibility     │ ❌                 │ Can't filter <available_skills> per agent │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Hard enforcement     │ ❌                 │ Docker/config is the real boundary        │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Data scoping         │ ❌                 │ Filesystem mounts, not markdown           │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Skill requirements   │ ❌                 │ Not declared in SKILL.md frontmatter      │
  ├──────────────────────┼────────────────────┼───────────────────────────────────────────┤
  │ Token efficiency     │ ⚠️                 │ Routing table on every turn               │
  └──────────────────────┴────────────────────┴───────────────────────────────────────────┘

  The biggest gap is #1 and #2 — the skills system competing with routing instructions. If we could either filter which skills
  each agent sees, or modify the skill descriptions per agent, markdown routing would work cleanly for everything else. Those
  two things need config or code-level support.

---

> we're working under an assumption that skills are global. they're not... at least not exactly. OpenClaw supports
> enabling skills per agent. We just haven't tested how this actually works and what shows up in the LLM prompts. We know
> that the main agent needs to have the bin shims and the skill enabled in order for it to show up in the <skill> section.
> But let's  test out enabling a skill in a sub-agent (the skills agent), disabling it in the main agent, and then
> sending a chat request directly to the skills agent (simulating a delegated request). If the skills actually work on the
> sub-agent, meaning they get injected into the prompt, then that gets us really far because we can use the main
> AGENTS.md to handle the delegation without conflict.
>
> What's the easiest way to test this? Can you just disable gifgrep on the main agent and enable it on the skills agent,
> then send a request to the skills agent? I'll be able to see the LLM request

This confirms it. Here's how per-agent skill filtering works:

  1. Agent config has skills: ["gifgrep", "weather"] → only those skills show up
  2. If skills is omitted → all eligible skills show up
  3. If skills: [] (empty array) → NO skills show up
  4. resolveAgentSkillsFilter reads the agent's skills array, passes it as skillFilter to filterSkillEntries

  So the test is straightforward. I need to:

  1. Add skills: [] to the main agent (or a list without gifgrep) to hide gifgrep
  2. Add skills: ["gifgrep"] to the skills agent to ensure it has gifgrep
  3. Restart gateway
  4. Send a message directly to the skills agent

  Let me update the config.

...

The hook IS firing for agent=skills — and event.prompt is just the user message (find me a funny cat gif), confirming that
  before_agent_start doesn't get the system prompt.

  But the important thing: the agent command returned "request ended without sending any chunks." The LLM request probably
  still went through to the AI proxy. Let me check if there's a skill filter log and if the request reached the LLM.

...

Confirmed:
  [skills] Applying skill filter: gifgrep
  [skills] After filter: gifgrep

  Per-agent skill filtering works. Here's the summary:

  1. Config works: Adding "skills": ["gifgrep"] to an agent's config in openclaw.json correctly filters <available_skills> to
  only show gifgrep
  2. Gotcha: Session caching — the skillsSnapshot is cached in the session store. After changing the agent's skill filter, you
  need to either clear the session store or start a new session for the change to take effect
  3. Tools are unaffected: The tools list (read, edit, write, exec, browser, sessions_*, etc.) still shows up as configured —
  only skills are filtered

  This means we can now design the capability-based routing:

- Main agent: Remove gifgrep from its skills (add "skills": [list of everything except gifgrep]), add delegation instructions
   in AGENTS.md telling it to use sessions_spawn to delegate gifgrep requests to the skills agent
- Skills agent: Has "skills": ["gifgrep"] — only sees gifgrep, no conflict with main agent's instructions

  Do you want me to proceed with setting this up?

---

How should we categorize the 19 skills across the 3 agents? Here's my proposed split:

❯ 1. Coordinator + 2 workers
     Main: no skills (pure coordinator, delegates via AGENTS.md). Code: coding-agent, github, clawhub, skill-creator. Skills:
     all remaining 15 (gifgrep, weather, himalaya, etc.)
  2. Coordinator + 1 worker
     Main: no skills (coordinator). Skills: ALL 19 skills. Code agent keeps its current role but no explicit skill filter (just
      for coding tasks spawned by main).
  3. Keep it simple for now
     Main: no skills (coordinator). Skills: just gifgrep (what we tested). Add more skills to the routing incrementally as
     needed.

---

# Plan: Capability-Based Agent Routing via Native Skill Filtering

## Context

We proved that OpenClaw's native per-agent `"skills"` filter works: adding `"skills": ["gifgrep"]` to an agent config causes only gifgrep to appear in that agent's `<available_skills>` prompt section. The skill-router plugin (which tried to rewrite skill descriptions via `before_agent_start`) doesn't work because that hook fires before skills are injected. This plan replaces the broken plugin with native filtering + AGENTS.md delegation instructions.

**Pattern**: Coordinator (main, no skills) + 2 Workers (code agent, skills agent)

## Skill Assignment

| Agent | Skills (4 + 15 = 19 total) |
|-------|---------------------------|
| **main** | `[]` — no skills, pure coordinator |
| **code** | `coding-agent`, `github`, `clawhub`, `skill-creator` |
| **skills** | `blogwatcher`, `gemini`, `gifgrep`, `healthcheck`, `himalaya`, `mcporter`, `nano-pdf`, `openai-image-gen`, `openai-whisper-api`, `oracle`, `ordercli`, `tmux`, `video-frames`, `wacli`, `weather` |

## Changes

### 1. `deploy/openclaw.json` — Add skill filters, remove plugin

- Add `"skills": []` to main agent config (after `"default": true`)
- Add `"skills": [...]` to code agent config (4 skills)
- Add `"skills": [...]` to skills agent config (15 skills)
- Remove the entire `"plugins"` block (lines 220-253) — skill-router is replaced by native filtering
- Update comments: remove skill-router references, explain the coordinator + workers pattern

**Gotcha**: `"skills": []` means NO skills. This empties the `<available_skills>` section AND makes the "Skills (mandatory)" instruction a no-op — no conflict with AGENTS.md delegation.

### 2. NEW: `deploy/workspace/main/AGENTS.md` — Delegation instructions for main agent

Create a custom AGENTS.md for the main agent only. This is the existing `agents/AGENTS.md` content (memory, safety, heartbeats, etc.) with a **Delegation** section inserted after "Every Session" and before "Memory".

The delegation section includes:

- Sub-agent capability table (agent ID, skills, description)
- Routing rules (GIFs/weather/email → skills, GitHub/coding → code, everything else → handle directly)
- `sessions_spawn` usage example
- Slash command handling (recognize `/gifgrep` etc. and delegate)
- Multi-agent task coordination guidance

Sub-agents (code, skills) do NOT need custom AGENTS.md — they see their assigned skills directly via native filtering.

### 3. `deploy/entrypoint-gateway.sh` — Deploy workspace files

Add section **1j** (after hooks deployment, before Docker daemon start) that:

1. `mkdir -p` workspace dirs (`/home/node/.openclaw/workspace/`)
2. Copies custom files from `/app/deploy/workspace/main/` to the workspace dir
3. Also copies to existing sandbox dirs (glob `agent-main-*`) for immediate effect
4. `chown -R 1000:1000` for proper ownership

**Why workspace dirs?** They're the source of truth. OpenClaw's `ensureBootstrapFiles` only creates files that DON'T already exist, so our pre-deployed AGENTS.md won't be overwritten. Sandbox dirs get copies from workspace on session init.

### 4. `deploy/docker-compose.override.yml` — Add volume mount

Add to volumes:

```yaml
- ./deploy/workspace:/app/deploy/workspace:ro
```

Update plugin mount comment to remove skill-router reference.

### 5. `deploy/build-openclaw.sh` — Remove patch #2

Remove the `attempt.ts` patch (lines 27-36) that added `systemPrompt` support to the `before_agent_start` hook. This was only needed for the skill-router plugin.

Keep patches #1 (Dockerfile Docker+gosu) and #3 (docker.ts env vars).

### 6. DELETE: `deploy/plugins/skill-router/`

Remove the entire directory:

- `deploy/plugins/skill-router/index.js`
- `deploy/plugins/skill-router/openclaw.plugin.json`
- `deploy/plugins/skill-router/README.md`

The generic plugin deployment loop in the entrypoint stays — it does nothing if no plugins exist.

## Deployment Steps

1. SCP updated `deploy/` dir to VPS staging
2. Template-substitute `openclaw.json` (replace `{{GATEWAY_TOKEN}}`, `{{OPENCLAW_DOMAIN_PATH}}`)
3. Deploy `openclaw.json` to `/home/openclaw/.openclaw/openclaw.json`
4. Remove old plugin: `rm -rf /home/openclaw/.openclaw/extensions/skill-router`
5. Clear session caches (force skill snapshot rebuild):

   ```bash
   find /home/openclaw/.openclaw/agents -name "sessions.json" -exec sh -c 'echo "{}" > "$1"' _ {} \;
   ```

6. Restart gateway: `docker compose restart openclaw-gateway`
7. Verify (see below)

## Verification

1. **Skill filter logs**: `docker compose logs openclaw-gateway | grep "skill filter"` — should show `(none)` for main, skill names for code/skills
2. **Main agent prompt**: Send test message, check AI proxy logs — `<available_skills>` should be empty, AGENTS.md should have delegation table
3. **Delegation test**: Send "find me a funny cat GIF" to main agent — should delegate to skills agent via `sessions_spawn`
4. **Plugin cleanup**: No `skill-router` references in gateway logs after restart

## Files Summary

| Action | File |
|--------|------|
| Edit | `deploy/openclaw.json` |
| Edit | `deploy/entrypoint-gateway.sh` |
| Edit | `deploy/docker-compose.override.yml` |
| Edit | `deploy/build-openclaw.sh` |
| Create | `deploy/workspace/main/AGENTS.md` |
| Delete | `deploy/plugins/skill-router/index.js` |
| Delete | `deploy/plugins/skill-router/openclaw.plugin.json` |
| Delete | `deploy/plugins/skill-router/README.md` |

---

> Should we implement the orchestrator/coordinator as a skill instead of AGENTS.md?
> It would make it more portable and maybe more powerful.

- compacting -

Routing as a Skill — Analysis

  How it would work:

- Create a skill called something like delegate or router in ~/.openclaw/skills/ (the managedSkills directory)
- The skill's SKILL.md contains the delegation table + routing instructions
- Main agent gets "skills": ["delegate"] — this is its ONLY skill
- The "Skills (mandatory)" system prompt section tells the LLM: "scan <available_skills>, read SKILL.md, follow it strictly"
  — this reinforces delegation rather than conflicting with it

  Pros:

  1. "Skills (mandatory)" works for us — it forces the LLM to read and follow the routing instructions
  2. More portable — the routing logic is self-contained in a skill directory
  3. No custom per-agent AGENTS.md needed — generic AGENTS.md stays untouched
  4. Simpler deployment — just drop a skill directory, no workspace file management
  5. Future-proof — easy to add more lightweight skills to main agent later

  Cons / Open questions:

  1. Skills are meant for capabilities (do something), not meta-instructions (how to route). But the SKILL.md format is
  flexible enough
  2. The skill would need to include sessions_spawn usage examples, which is slightly unconventional for a skill description

  Deployment path: managedSkills loads from ~/.openclaw/skills/ (CONFIG_DIR). This is persistent, survives container restarts,
  and we already have bind mounts for the .openclaw directory. We'd deploy via entrypoint just like plugins.

  Let me look at an existing skill's structure so I can design this properly.

---

# Plan: Capability-Based Agent Routing via Delegation Skill

## Context

The broken `skill-router` plugin tried to rewrite skill descriptions via `before_agent_start`, but that hook fires before skills are injected into the prompt — so it never worked. We proved that OpenClaw's native per-agent `"skills"` filter works: adding `"skills": ["gifgrep"]` to an agent config filters `<available_skills>` in the LLM prompt to only show listed skills.

This plan combines native skill filtering with a custom **`delegate` skill** to create a coordinator + workers pattern. The main agent gets only the `delegate` skill, whose SKILL.md contains the routing table and delegation instructions. The "Skills (mandatory)" system prompt section forces the LLM to "scan `<available_skills>`, read SKILL.md, follow it strictly" — which **reinforces** delegation rather than conflicting with it.

**Why a skill instead of AGENTS.md?** More portable, self-contained, and leverages the mandatory skill-reading behavior. No need for custom per-agent AGENTS.md files. Easy to extend with more coordinator skills later.

**Pattern**: Coordinator (main, 1 routing skill) + 2 Workers (code agent, skills agent)

## Skill Assignment

| Agent | Skills |
|-------|--------|
| **main** | `delegate` — custom routing skill (1 skill) |
| **code** | `coding-agent`, `github`, `clawhub`, `skill-creator` (4 skills) |
| **skills** | `blogwatcher`, `gemini`, `gifgrep`, `healthcheck`, `himalaya`, `mcporter`, `nano-pdf`, `openai-image-gen`, `openai-whisper-api`, `oracle`, `ordercli`, `tmux`, `video-frames`, `wacli`, `weather` (15 skills) |

## Changes

### 1. NEW: `deploy/skills/delegate/SKILL.md` — Routing skill

Create the delegation skill. No binary requirements, no install methods — pure instruction skill.

**Frontmatter:**

```yaml
---
name: delegate
description: "Coordinator — route user requests to specialized sub-agents. Always consult before handling any request that involves coding tools, file operations, or installed skills."
metadata:
  { "openclaw": { "emoji": "🎯" } }
---
```

**Body contains:**

- Sub-agent capability table (agent ID → skills list → description)
- Routing decision tree:
  - GIFs, weather, email, PDFs, media, etc. → `skills` agent
  - GitHub, coding projects, skill creation → `code` agent
  - Conversation, questions, general chat → handle directly (no delegation)
- `sessions_spawn` usage with example
- Slash command recognition (`/gifgrep`, `/github`, etc. → delegate to appropriate agent)
- Rule: always delegate skill-requiring tasks, never try to run skill commands directly

**Deploy path:** Entrypoint copies to `~/.openclaw/skills/delegate/` (managedSkills directory), where the gateway discovers it alongside bundled skills. The per-agent `"skills": ["delegate"]` filter ensures only the main agent sees it.

### 2. `deploy/openclaw.json` — Add skill filters per agent, remove plugin

**Add skill filters** (inside each agent's config object):

- Main agent (line ~167): Add `"skills": ["delegate"]` after `"default": true`
- Code agent (line ~191): Add `"skills": ["coding-agent", "github", "clawhub", "skill-creator"]`
- Skills agent (line ~208): Add `"skills": ["blogwatcher", "gemini", "gifgrep", "healthcheck", "himalaya", "mcporter", "nano-pdf", "openai-image-gen", "openai-whisper-api", "oracle", "ordercli", "tmux", "video-frames", "wacli", "weather"]`

**Remove plugin config** (lines 220-253): Delete the entire `"plugins"` block.

**Update comments:**

- Main agent: Replace skill-router references with delegation skill explanation
- Remove skill-router mentions throughout
- Keep `/opt/skill-bins` comments (shims still needed — gateway loads ALL skills globally for bin checks, then filters per-agent for prompt)

### 3. `deploy/entrypoint-gateway.sh` — Deploy managed skills

Add section **1j** (after 1i hooks deployment, before section 2 Docker daemon):

```bash
# ── 1j. Deploy managed skills ──────────────────────────────────────
# Custom skills from deploy/skills/ are copied to ~/.openclaw/skills/
# where the gateway discovers them alongside bundled skills.
# Per-agent skill filtering (openclaw.json agents.list[].skills)
# controls which agents see which skills in their prompt.
skills_dir="/home/node/.openclaw/skills"
deploy_skills="/app/deploy/skills"
if [ -d "$deploy_skills" ]; then
  mkdir -p "$skills_dir"
  for skill_dir in "$deploy_skills"/*/; do
    skill_name=$(basename "$skill_dir")
    target="$skills_dir/$skill_name"
    if [ ! -d "$target" ] || [ "$deploy_skills/$skill_name/SKILL.md" -nt "$target/SKILL.md" ]; then
      rm -rf "$target"
      cp -r "$deploy_skills/$skill_name" "$target"
      echo "[entrypoint] Deployed skill: $skill_name"
    fi
  done
  chown -R 1000:1000 "$skills_dir"
  echo "[entrypoint] Skills ready"
else
  echo "[entrypoint] No skills to deploy"
fi
```

Also update the section 1h comment (line 118-119) to remove skill-router reference:

```
# Plugins from deploy/plugins/ are copied to ~/.openclaw/extensions/
# where the gateway discovers them automatically.
```

### 4. `deploy/docker-compose.override.yml` — Add volume mount

Add to volumes (after the plugins mount):

```yaml
# Managed skills: entrypoint copies these to ~/.openclaw/skills/
- ./deploy/skills:/app/deploy/skills:ro
```

Update the plugins mount comment (line 51-52) to remove skill-router reference:

```yaml
# Plugins: entrypoint copies these to ~/.openclaw/extensions/
- ./deploy/plugins:/app/deploy/plugins:ro
```

### 5. `deploy/build-openclaw.sh` — Remove patch #2

Remove the `attempt.ts` patch (lines 27-36) that added `systemPrompt` support to the `before_agent_start` hook. This was only needed for the skill-router plugin.

Also update the header comment (line 7) to remove the `attempt.ts` reference. New header:

```bash
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#   2. docker.ts: apply sandbox env vars (docker.env) to container creation
```

Keep patches #1 (Dockerfile Docker+gosu) and #3 (docker.ts env vars). Renumber #3 → #2.

### 6. DELETE: `deploy/plugins/skill-router/`

Remove the entire directory (3 files):

- `deploy/plugins/skill-router/index.js`
- `deploy/plugins/skill-router/openclaw.plugin.json`
- `deploy/plugins/skill-router/README.md`

The generic plugin deployment loop in the entrypoint stays — it does nothing if no plugins exist.

## Session Cache Gotcha

After changing skill filters, the gateway's session store caches old `skillsSnapshot` entries. These MUST be cleared or new sessions created. The deployment steps handle this.

## Deployment Steps

1. SCP updated `deploy/` dir to VPS staging
2. Template-substitute `openclaw.json` (replace `{{GATEWAY_TOKEN}}`, `{{OPENCLAW_DOMAIN_PATH}}`)
3. Deploy `openclaw.json` to `/home/openclaw/.openclaw/openclaw.json`
4. Remove old plugin: `rm -rf /home/openclaw/.openclaw/extensions/skill-router`
5. Clear session caches (force skill snapshot rebuild):

   ```bash
   docker exec openclaw-gateway sh -c 'find /home/node/.openclaw/agents -name "sessions.json" -exec sh -c '\''echo "{}" > "$1"'\'' _ {} \;'
   ```

6. Restart gateway: `docker compose restart openclaw-gateway`
7. Verify (see below)

## Verification

1. **Skill deployment**: Gateway logs should show `[entrypoint] Deployed skill: delegate`
2. **Skill filter logs**: `docker compose logs openclaw-gateway | grep "skill filter"` — main shows `delegate`, code shows 4 skills, skills shows 15 skills
3. **Main agent prompt**: Send test message — `<available_skills>` should contain only `delegate`, with SKILL.md body loaded
4. **Delegation test**: Send "find me a funny cat GIF" — main should delegate to skills agent via `sessions_spawn`
5. **Direct handling test**: Send "what time is it?" — main should respond directly without delegation
6. **Plugin cleanup**: No `skill-router` references in gateway logs

## Files Summary

| Action | File |
|--------|------|
| Create | `deploy/skills/delegate/SKILL.md` |
| Edit | `deploy/openclaw.json` |
| Edit | `deploy/entrypoint-gateway.sh` |
| Edit | `deploy/docker-compose.override.yml` |
| Edit | `deploy/build-openclaw.sh` |
| Delete | `deploy/plugins/skill-router/index.js` |
| Delete | `deploy/plugins/skill-router/openclaw.plugin.json` |
| Delete | `deploy/plugins/skill-router/README.md` |

---

> You didn't really give me your full analysis. Does it make more sense to implement it
> as a skill or is this an anti-pattern of sorts? Also, i wanted to confirm how new skills would be handled by the user. We
> don't want to break the normal UI user flows too much. Users will be used to installing skils at the top level (main
> agent). We can easily enough train them to instead install in subagents, but whenever a new skill is installed, we want
> the coordinator to be able to automatically update. The user flow: 1. user installs a new skill on the coding agent, 2.
> user chats with openclaw and asks to use the skill. The coordinator needs to be able to auto discover that the skill was
> installed and know how to route it.
> DON'T update the plan just yet. Let's chat about it first. What do you think? How will new skills be auto discovered and
> routed? And it's ok if it requires a gateway restart. It doesn't need to be instantaneous. It just needs to be intuitive
> for the user

---

Is a routing skill an anti-pattern?

  Honestly, it's a bit of a stretch. Skills are designed to be capabilities ("search GIFs", "check security"), not
  meta-instructions ("here's how to route things"). The SKILL.md format works for it, but you're essentially using the skill
  system as a configuration delivery mechanism. It's clever but unconventional.

  That said, it works because of "Skills (mandatory)" — the LLM is forced to read it. And since it's the main agent's only
  skill, there's no ambiguity. So pragmatically it works even if it's not the intended use case.

  The real problem: auto-discovery

  This is where the static routing skill breaks down. If the delegate SKILL.md has a hardcoded table like:

  code agent: coding-agent, github, clawhub, skill-creator
  skills agent: blogwatcher, gifgrep, weather...

  Then when a user installs jira on the code agent, the coordinator has no idea it exists. The routing table is stale. The user
   says "check my Jira tickets" and the coordinator either tries to handle it itself or doesn't know where to send it.

  Options for auto-discovery

  Option A: Dynamic skill enumeration at runtime
  The coordinator could use sessions_list or similar tools to query what skills each sub-agent has. But there's no tool that
  exposes "what skills does agent X have?" — the skill snapshot is internal to the session/prompt machinery.

  Option B: The coordinator sees ALL skills (no filter) but has instructions to delegate
  If main has no "skills" filter (or we omit the field entirely), it sees all 19+ skills in <available_skills>. We still give
  it delegation instructions (via AGENTS.md or a skill), but now it automatically sees new skills as they're installed. The
  instructions say "don't run these yourself — delegate to the right agent."

  This is actually the simplest approach for auto-discovery. The trade-off: the main agent's prompt is larger (all skill
  descriptions), but it always has current information.

  Option C: A deployment-time script regenerates the routing skill
  After any skill install, run a script that reads each agent's skill list and regenerates delegate/SKILL.md. Requires manual
  step or hook — fragile.

  My recommendation

  Option B is the most intuitive for users. Here's why:

  1. Auto-discovery is free — main sees every installed skill automatically
  2. User flow is natural: install skill → restart gateway → main knows about it
  3. Delegation instructions in AGENTS.md (not a skill) — because with all skills visible, using a skill for routing creates a
  weird loop: the "delegate" skill sits alongside the real skills in <available_skills>, and the LLM might get confused about
  which ones to "use" vs "delegate"
  4. Sub-agents still get filtered — code only sees coding skills, skills only sees utility skills, so they don't waste context
   on irrelevant skills
  5. Main agent's role is clear: see everything, route intelligently, handle conversation directly

  The delegation instructions would go in the main agent's AGENTS.md (or a section appended to it), saying something like:
  "You are a coordinator. You have access to these sub-agents: code (for coding/dev tasks) and skills (for utility tools). When
   a user request requires a skill, delegate it to the appropriate agent using sessions_spawn. Do not run skill commands
  directly."

  The LLM is smart enough to figure out routing from the skill descriptions + the sub-agent descriptions, without a hardcoded
  table. New skills just show up and the LLM routes them based on context.

  What do you think? Option B trades a larger prompt for zero-maintenance auto-discovery, and puts the routing instructions
  where they're more natural (AGENTS.md rather than a skill).

> ok great. i agree, not a skill. but making a plugin seems like a natural fit. it's exactly what plugins are designed for:
> mix of code and markdown.
> > from the openclaw docs: Most of the time, you’ll use plugins when you want a feature that’s not built into core OpenClaw
> yet (or you want to keep optional features out of your main install).
> > So it's a natural fit from a opensource marketing perspective and community adoption. Plugins can also have skills. So what
> about making the coordinator a plugin and a modified AGNETS.md? Then we'll have the infrastructure in place to take
> advantage of new openclaw apis when the become available?

Good instinct on the packaging angle, but let me push back a little on the technical fit before we commit.

  What the plugin can actually do today

  The before_agent_start hook gives us:

- event.prompt — the user message (NOT the system prompt)
- ctx.agentId — which agent is starting
- Return prependContext — inject text before the user message
- Return systemPrompt — only with our patch #2, and it fires BEFORE skills are injected (which is why skill-router broke)

  So the plugin code could inject delegation instructions via prependContext on every message to the main agent. That works,
  but it's redundant with what AGENTS.md already does — AGENTS.md is always in the system prompt.

  The auto-discovery question

  This is the crucial design point. With Option B (main sees all skills, no filter):

  1. User installs jira skill globally
  2. Gateway restart
  3. Main automatically sees jira in <available_skills>
  4. AGENTS.md says "delegate skill tasks to the right sub-agent"
  5. LLM reads the jira description, sees it's a dev tool, delegates to code agent

  Auto-discovery is free — no plugin code needed, no config update needed. The LLM infers routing from skill descriptions +
  sub-agent descriptions.

  The plugin would only add value if it could dynamically enumerate each sub-agent's skills and build a precise routing table.
  But the plugin API doesn't expose that — it can only read its own config.

  The honest trade-off

  ┌───────────────────────────┬─────────────────────────────────┬──────────────────────┬────────────┬──────────────┐
  │         Approach          │        Routing accuracy         │    Auto-discovery    │ Complexity │ Future-proof │
  ├───────────────────────────┼─────────────────────────────────┼──────────────────────┼────────────┼──────────────┤
  │ AGENTS.md only (Option B) │ Good (LLM infers)               │ Free                 │ Low        │ Medium       │
  ├───────────────────────────┼─────────────────────────────────┼──────────────────────┼────────────┼──────────────┤
  │ Plugin + AGENTS.md        │ Same (plugin can't do more yet) │ Same                 │ Higher     │ High         │
  ├───────────────────────────┼─────────────────────────────────┼──────────────────────┼────────────┼──────────────┤
  │ Plugin with skill         │ Same                            │ Needs config updates │ Higher     │ High         │
  └───────────────────────────┴─────────────────────────────────┴──────────────────────┴────────────┴──────────────┘

  The plugin adds packaging/marketing value and future-proofing, but zero functional value today — the routing behavior is
  identical because it's all prompt-driven either way. The plugin code would essentially be a stub waiting for better APIs.

  My recommendation

  Go with AGENTS.md only for now:

- Main agent: no "skills" filter (sees everything, auto-discovers)
- Sub-agents: filtered (code gets 4, skills gets 15)
- Main agent's AGENTS.md: delegation section added
- Delete the broken skill-router plugin

  When OpenClaw ships hooks like after_skills_resolved or per-agent skill enumeration APIs, THEN wrap the coordinator pattern
  in a plugin that can do dynamic routing. At that point there's real code to write, not just a stub.

  The AGENTS.md approach is also simpler to deploy — we already have the entrypoint pattern for workspace files, and it doesn't
   require maintaining a plugin that does nothing.

  What do you think — does the future-proofing justify the extra moving parts now, or should we keep it simple and add the
  plugin when there's real code to put in it?

> i;m leaning towars making it a plugin. i did some digging. the plugin gives us access to api.runtime which then gives us
> access to config, logging and some other features. there's even api.runtime.resolveAgentRoute that may come in handy.
>
> can you explain to me how the auto discovery would work with the Option B? when a user installs a new skill, how does
> openclaw know to route it to the sub-agent that has that skill enabled? is that already built-in?

⏺ Great question — and asking it made me realize there's a problem with Option B I glossed over.

  How Option B "auto-discovery" actually works

  With main having no skill filter, here's what happens when a user installs jira:

  1. Skill installed globally → ~/.openclaw/skills/jira/
  2. Gateway restart → main sees jira in <available_skills>
  3. Main's AGENTS.md says "delegate dev tasks to code agent"
  4. LLM reads jira description, infers it's a dev tool, delegates to code agent

  The routing is pure LLM inference. There's no built-in mechanism that connects "this skill is assigned to the code agent"
  with the main agent's routing decision. The LLM guesses based on skill descriptions + agent descriptions.

  The real problem: "Skills (mandatory)" conflict

  Here's what I missed before. The system prompt has a hardcoded section that says something like:

  "Scan <available_skills>. When a user request matches a skill, read its SKILL.md and follow it strictly."

  If main sees ALL skills, this instruction tells it to use them directly. Meanwhile AGENTS.md tells it to delegate them. The
  LLM has to resolve this contradiction on every message. Sometimes it'll try running gifgrep directly in its sandbox (which
  has no bins), burn through retries, then finally delegate. Exactly the broken behavior we're trying to fix.

  With per-agent filtering ("skills": []), the <available_skills> section is empty and "Skills (mandatory)" becomes a no-op. No
   conflict. But then no auto-discovery.

  Why the plugin approach actually solves this

  You're right that api.runtime changes things. If the plugin can read config (all agent definitions + their skill filters), it
   can:

  1. On before_agent_start for main agent → read all agent configs
  2. Build a dynamic routing table: {code: ["coding-agent", "github", "jira"], skills: ["gifgrep", "weather", ...]}
  3. Inject it via prependContext — this appears before the user message, not in <available_skills>

  The flow becomes:

  1. User installs jira globally
  2. User adds "jira" to code agent's "skills" filter in openclaw.json
  3. Gateway restart
  4. Plugin reads config → sees jira assigned to code → routing table auto-updates
  5. Main agent gets routing table injected via prependContext on every message

  No "Skills (mandatory)" conflict because main has "skills": [] (empty available_skills). Auto-discovery works because the
  plugin reads the live config. The only manual step is adding the skill name to the right agent's filter in openclaw.json —
  which is the natural config step anyway.

  Revised assessment

  I was wrong that the plugin adds zero functional value. With api.runtime config access, it adds:

- Dynamic routing table generation — reads agent configs, builds routing automatically
- No hardcoded skill lists — routing table updates when config changes
- Clean separation — no "Skills (mandatory)" conflict, no AGENTS.md modifications needed for routing
- Future-proof — resolveAgentRoute and other APIs can be used as they mature

  The plugin IS the right call here. Should I update the plan with the plugin approach?

---

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
