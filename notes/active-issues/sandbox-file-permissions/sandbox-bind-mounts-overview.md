Layer 1: Host -> Gateway Container (docker-compose.override.yml)

  ┌─────────────────────────────────┬────────────────────────────────────┬──────┬─────────────────────────────────┐
  │            Host Path            │       Gateway Container Path       │ Mode │             Purpose             │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./scripts/entrypoint-gateway.sh │ /app/scripts/entrypoint-gateway.sh │ ro   │ Entrypoint                      │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ /home/openclaw/sandboxes-home   │ /home/node/sandboxes-home          │ rw   │ Persistent agent home dirs      │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./data/docker                   │ /var/lib/docker                    │ rw   │ Nested Docker image persistence │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/plugins                │ /app/deploy/plugins                │ ro   │ Plugin code                     │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/hooks                  │ /app/deploy/hooks                  │ ro   │ Hook handlers                   │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/sandbox-toolkit.yaml   │ /app/deploy/sandbox-toolkit.yaml   │ ro   │ Toolkit config                  │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/parse-toolkit.mjs      │ /app/deploy/parse-toolkit.mjs      │ ro   │ Toolkit parser                  │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/rebuild-sandboxes.sh   │ /app/deploy/rebuild-sandboxes.sh   │ ro   │ Sandbox builder                 │
  ├─────────────────────────────────┼────────────────────────────────────┼──────┼─────────────────────────────────┤
  │ ./deploy/dashboard.mjs           │ /app/deploy/dashboard.mjs           │ ro   │ Dashboard server                │
  └─────────────────────────────────┴────────────────────────────────────┴──────┴─────────────────────────────────┘

  Plus the upstream compose (not in override) mounts:

- OPENCLAW_CONFIG_DIR (/home/openclaw/.openclaw) -> /home/node/.openclaw — rw (config, workspace, state)
- OPENCLAW_WORKSPACE_DIR (/home/openclaw/.openclaw/workspace) -> gateway workspace — rw

  Layer 2: Gateway Container -> Sandbox Containers (openclaw.json binds)

  Defaults (all agents inherit):

  ┌─────────────────┬─────────────────┬──────┬───────────────────────────────────────┐
  │  Gateway Path   │  Sandbox Path   │ Mode │                Purpose                │
  ├─────────────────┼─────────────────┼──────┼───────────────────────────────────────┤
  │ /opt/skill-bins │ /opt/skill-bins │ ro   │ Skill binary shims                    │
  ├─────────────────┼─────────────────┼──────┼───────────────────────────────────────┤
  │ /app/docs       │ /workspace/docs │ ro   │ OpenClaw docs (agent-friendly path)   │
  ├─────────────────┼─────────────────┼──────┼───────────────────────────────────────┤
  │ /app/docs       │ /app/docs       │ ro   │ OpenClaw docs (default expected path) │
  └─────────────────┴─────────────────┴──────┴───────────────────────────────────────┘

  Code agent only:

  ┌────────────────────────────────┬───────────────┬───────────────┬─────────────────────┐
  │          Gateway Path          │ Sandbox Path  │     Mode      │       Purpose       │
  ├────────────────────────────────┼───────────────┼───────────────┼─────────────────────┤
  │ /home/node/sandboxes-home/code │ /home/sandbox │ rw (implicit) │ Persistent home dir │
  └────────────────────────────────┴───────────────┴───────────────┴─────────────────────┘

  Layer 3: Agent Workspace (implicit, no bind mount)

  The workspace at /home/node/.openclaw/workspace/ is NOT bind-mounted into sandboxes. Agents access it via the read
   tool through the gateway, not through the filesystem. This is the mechanism used for host-status/health.json and
  host-status/maintenance.json.

  Sandbox filesystem access summary

  ┌─────────────────────────┬───────────────────────────────┬──────────────────────────────────────────────────────┐
  │          Path           │           Writable?           │                         How?                         │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /workspace/             │ Yes                           │ workdir, managed by OpenClaw (overlay/sandbox root)  │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /home/sandbox           │ No (default agents) / Yes     │ Default: read-only root. Code: bind mount from       │
  │                         │ (code agent)                  │ sandboxes-home/code                                  │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /home/linuxbrew         │ Yes                           │ tmpfs (ephemeral, per tmpfs config)                  │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /tmp, /var/tmp, /run    │ Yes                           │ tmpfs                                                │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /opt/skill-bins         │ No                            │ ro bind                                              │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ /workspace/docs,        │ No                            │ ro bind                                              │
  │ /app/docs               │                               │                                                      │
  ├─────────────────────────┼───────────────────────────────┼──────────────────────────────────────────────────────┤
  │ Everything else         │ No                            │ readOnlyRoot: true                                   │
  └─────────────────────────┴───────────────────────────────┴──────────────────────────────────────────────────────┘

  ---
  Key Issues

  1. Bind mounts we discovered don't hot-reload. The agents section is kind: "none" — adding new binds to
  openclaw.json requires a full sandbox rebuild cycle, not just a gateway restart. This burned us with the
  host-status bind mount attempt.
  2. Duplicate docs mount. /app/docs is mounted to two sandbox paths (/workspace/docs:ro and /app/docs:ro). This was
   a hedge — the default OpenClaw agent instructions point to /app/docs, but agents using read tool work better with
   /workspace/docs. Both are read-only, so no harm, but it's redundant.
  3. Workspace files (host-status) use a copy workaround. host-alert.sh and host-maintenance-check.sh write to
  /home/openclaw/.openclaw/host-status/ (host-level) AND copy to /home/openclaw/.openclaw/workspace/host-status/
  because agents can only access workspace via the read tool. This double-write only exists because we couldn't get
  a bind mount working.
  4. Only the code agent has a persistent home. Main and skills agents lose all home dir state on prune/restart. If
  they ever need persistent config, they'd need the same sandboxes-home pattern.

  ---
  What OpenClaw Config Could Replace

  So — to your question about config settings vs bind mounts. There are a few areas worth discussing:

  1. sandbox.scope — Currently "agent" (each agent gets its own sandbox root under ~/.openclaw/sandboxes/). Changing
   to "shared" would make all agents share one workspace root, which could simplify file sharing between agents but
  has security trade-offs.
  2. The docs binds — OpenClaw already bundles docs at /app/docs in the image. The bind to /workspace/docs:ro is
  just a convenience alias. If agents are configured properly in their system prompts, one mount suffices.
  3. The host-status workspace workaround — Instead of the double-write + copy pattern, if the upstream compose
  already mounts OPENCLAW_CONFIG_DIR (which includes the workspace), agents should already be able to read files in
  the workspace without needing bind mounts into sandboxes at all. The read tool routes through the gateway, not the
   sandbox filesystem. So this is working as designed — the copy to workspace/ is the correct approach, and the bind
   mount attempt was wrong.
  4. sandbox.docker.env.HOME — The code agent overrides this in REQUIREMENTS.md but it's not in the current
  openclaw.json. If we want $HOME to point to /home/sandbox (the persistent bind) for the code agent, that should be
   set.

  What aspects do you want to dig into? The main choices are:

- Simplify the docs bind mounts (drop one of the two)
- Evaluate scope: "shared" vs scope: "agent" for workspace sharing
- Clean up the host-status pattern (confirm it's correct, remove the memory note about bind mounts being broken)
- Add persistent homes for other agents if needed

> Re: double mounting /host-status/ files

You're right to question this. Here's what's going on:

  Two consumers, two paths:

  Consumer: host-alert.sh --report
  Runs where: Host cron (root)
  Reads from: HOST_STATUS_DIR = /home/openclaw/.openclaw/host-status/
  ────────────────────────────────────────
  Consumer: OpenClaw agent (cron job)
  Runs where: Main agent loop
  Reads from: WORKSPACE_STATUS_DIR = /home/openclaw/.openclaw/workspace/host-status/ (relative path
    host-status/health.json)

  The workspace copy exists because during the sandbox bind mount debugging, I discovered new bind mounts don't take
  effect, so I moved to the workspace approach for agent access. But as you point out — the cron job runs on the main
  agent loop, not in a sandbox.

  However, the agent read tool resolves relative paths against the workspace directory regardless of sandboxing. So the
  agent does need files in the workspace path.

  The real question is: can we eliminate HOST_STATUS_DIR and only write to WORKSPACE_STATUS_DIR? The only consumer of
  HOST_STATUS_DIR is host-alert.sh --report, which reads maintenance.json from there. That script runs on the host and
  can just as easily read from the workspace path (/home/openclaw/.openclaw/workspace/host-status/).

  So yes — we can simplify to a single write location: the workspace dir. Both host scripts and agents can read from
  there. The double-write is unnecessary.
