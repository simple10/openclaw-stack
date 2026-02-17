# Skill Routing Architecture

How skills are filtered, routed, and delegated across agents in our multi-agent setup.

See also [SANDBOX-TOOLKIT.md](SANDBOX-TOOLKIT.md)

## Current Architecture

### Agent Topology

| Agent | Image | Role | Skills |
|-------|-------|------|--------|
| `main` | `openclaw-sandbox:bookworm-slim` (base) | Coordinator — routes tasks to sub-agents | `[]` (none) |
| `code` | `openclaw-sandbox-common:bookworm-slim` | Coding, GitHub, tool creation | `coding-agent`, `github`, `clawhub`, `skill-creator` |
| `skills` | `openclaw-sandbox-common:bookworm-slim` | All non-coding skills | `blogwatcher`, `gemini`, `himalaya`, etc. |

The main agent runs in `non-main` sandbox mode: operator DMs execute on the gateway host (full docker/filesystem access), while group chats and subagent spawns are sandboxed.

### Two Routing Mechanisms

Skills reach the right agent through two independent systems:

**1. Coordinator Plugin (prompt injection)**
The coordinator plugin reads each agent's `skills` array from `openclaw.json`, builds a routing table, and writes it to the main agent's `AGENTS.md` workspace file. OpenClaw injects `AGENTS.md` into the system prompt, so the coordinator LLM knows which sub-agent handles each skill and uses `sessions_spawn` to delegate.

**2. Skill Filtering (`shouldIncludeSkill`)**
When OpenClaw builds an agent's skill prompt, it filters skills through `shouldIncludeSkill()` (`src/agents/skills/config.ts`). This checks:

- `enabled: false` in skill config → excluded
- `metadata.always: true` → always included (bypasses all checks below)
- `metadata.requires.bins` → each binary must pass `hasBinary()` (or be available on a remote node)
- `metadata.requires.anyBins` → at least one binary must pass
- `metadata.requires.env` → each env var must be set
- `metadata.requires.config` → each config path must be truthy
- `metadata.os` → must match current platform (or a remote node's platform)

### The Binary Check Problem

`hasBinary()` (`src/shared/config-eval.ts`) scans `$PATH` directories using `fs.accessSync(candidate, X_OK)`. It runs **on the gateway process**, not inside sandbox containers. This creates a mismatch:

- Real tool binaries (gh, uv, himalaya, etc.) are baked into `sandbox-common` at image build time
- The gateway process runs on the host, where those binaries don't exist
- Without intervention, every skill with `requires.bins` would be filtered out on the gateway — even for agents whose sandboxes have the binaries

### The Skill-Bins Shim

The shim system bridges this gap:

1. **At gateway boot** (`entrypoint-gateway.sh` §1g), the entrypoint reads `sandbox-toolkit.yaml` and generates a shell shim for each declared binary in `/opt/skill-bins/`
2. `/opt/skill-bins` is added to the gateway's `$PATH`
3. The directory is bind-mounted read-only into all sandbox containers
4. `hasBinary()` finds the shim → skill passes the filter → skill appears in the agent's prompt

Each shim is a pass-through script:

- **Inside a sandbox** (where real binaries exist): the shim strips itself from `$PATH` and `exec`s the real binary
- **On the gateway host**: prints an error (shims are not meant to be executed there)

The bind mount into sandboxes (`/opt/skill-bins:/opt/skill-bins:ro`) is in the default `binds` array so all agents inherit it.

### Why Main Has `"skills": []`

The main agent's `"skills": []` config prevents OpenClaw from including any skill blocks in main's system prompt. This is intentional:

- Main uses `openclaw-sandbox:bookworm-slim` (base image) — it doesn't have the real binaries anyway
- Even if skills passed the binary check (via shims), main couldn't execute them
- The coordinator plugin's routing table in `AGENTS.md` is the only skill context main needs
- Setting `skills: []` keeps main's prompt clean and focused on coordination

## Why Not Just Use sandbox-common for Main?

If main used `sandbox-common`, all skills would have real binaries and pass `hasBinary()`. Skills would appear in main's prompt and main could execute them directly in its sandbox — no delegation needed.

### Arguments for sandbox-common on main

- **Simpler setup**: no shim system, no coordinator routing, skills just work
- **Lower latency**: direct execution vs spawn-wait-relay for every skill task
- **Better for single-agent setups**: new users get full capabilities without configuring routing
- **Fewer moving parts**: no coordinator plugin, no `AGENTS.md` injection, no shim generation

### Arguments for the current split

- **Principle of least privilege**: the coordinator shouldn't have tools it doesn't need. More binaries = more ways the LLM can go off-script instead of delegating
- **Resource isolation**: coding tasks get 4GB RAM / 4 CPU; lightweight API skills get 1GB / 1 CPU. A single fat agent wastes resources on idle capabilities
- **Security surface**: fewer binaries = fewer potential vulnerabilities (though Sysbox provides strong isolation regardless)
- **Credential isolation**: skills like `gh` need `GITHUB_TOKEN`, `himalaya` needs mail credentials. Splitting agents means credentials are scoped to the agent that needs them
- **Specialization**: the code agent has persistent workspace access, long prune windows, and network access. The skills agent is ephemeral and lightweight. These are fundamentally different profiles

### The pragmatic answer

The coordinator + shim pattern is a **power-user feature**. For a general-purpose default setup, sandbox-common on main would be simpler and less error-prone. The split matters when you care about credential scoping, resource isolation, or limiting LLM capabilities per agent.

## Timing: When Checks Run

The binary check is **lazy, not a startup gate**:

1. Gateway starts and generates shims (synchronous, in entrypoint)
2. `primeRemoteSkillsCache()` fires asynchronously (non-blocking, checks remote nodes only)
3. When a message arrives for an agent, the skill prompt is built
4. `filterSkillEntries()` → `shouldIncludeSkill()` → `hasBinary()` runs per-skill
5. Results are cached in `hasBinaryCache` (invalidated if `$PATH` changes)

The gateway does NOT block on binary checks at startup. A missing binary doesn't prevent the gateway from starting — it just silently excludes the skill from that agent's prompt.

## Extension Points

### Available today

- **`before_agent_start` hook**: plugins can inject context into `AGENTS.md` or other workspace files (this is what the coordinator plugin uses)
- **`metadata.always: true`**: skill authors can bypass all requirement checks in their frontmatter
- **Per-agent `skills` array**: explicitly controls which skills an agent sees (acts as an allowlist)

### Not available (potential upstream features)

- **No `skill_eligibility` hook**: plugins cannot dynamically override `shouldIncludeSkill` decisions
- **No `skipBinaryCheck` config**: no way to tell OpenClaw "trust me, this agent has this binary" without the shim
- **No per-skill `forceInclude`**: the `enabled` field can only disable (`false`), not force-enable

## File Map

| File | Role |
|------|------|
| `deploy/openclaw.json` | Agent configs, skill assignments, sandbox images, bind mounts |
| `deploy/sandbox-toolkit.yaml` | Tool declarations — bins listed here get auto-shimmed |
| `deploy/entrypoint-gateway.sh` §1g | Shim generation at gateway boot |
| `deploy/plugins/coordinator/index.js` | Builds routing table from agent configs → `AGENTS.md` |
| `source/openclaw/src/agents/skills/config.ts` | `shouldIncludeSkill()` — skill filtering logic |
| `source/openclaw/src/shared/config-eval.ts` | `hasBinary()` — binary existence check |
| `source/openclaw/src/agents/skills/workspace.ts` | `filterSkillEntries()` — applies filters when building prompt |

## Future Considerations

- **Default to sandbox-common for all agents**: simplifies initial setup, removes shim dependency for basic deployments. Power users can still customize images per-agent
- **Upstream `skill_eligibility` hook**: would let the coordinator plugin directly control skill filtering instead of relying on shims + prompt injection
- **Upstream `skipBinaryCheck` config option**: per-skill override to trust that the sandbox has the binary without needing a shim on the gateway
- **Image-aware skill filtering**: OpenClaw could inspect the agent's configured sandbox image to determine available binaries, eliminating the gateway/sandbox mismatch entirely
