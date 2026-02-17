# Review of Current Sandbox Bind Mount Architecture

> let's take a step back and fully consider how we're handling sandbox workspace files per agent. Please look
> carefully at the build scripts, playbooks and docker files and openclaw.json to create a full map of the bind
> mounts and tmpfs layers being used in the sandboxes. make a note of what is added at build time vs runtime
> and who (openclaw or one of our scripts) is adding the layer.
>
> we need this map to fully understand if we're using hacks because of a misunderstanding of the available
> openclaw.json sandbox config settings.

Complete Sandbox Filesystem Layer Map

  A. Build-Time Layers (Baked Into Images)

  Gateway Image (openclaw:local)

  Built by: Our build-openclaw.sh
  What's in it:

  ┌───────────────────────────┬───────────────────────────────────────┬─────────────────────┐
  │           Path            │               Contents                │      Who Added      │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ /app/                     │ OpenClaw Node.js app                  │ Upstream Dockerfile │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ /app/docs/                │ OpenClaw documentation                │ Upstream Dockerfile │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ /app/openclaw.mjs         │ CLI entrypoint                        │ Upstream Dockerfile │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ /app/Dockerfile.sandbox   │ Base sandbox Dockerfile               │ Upstream            │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ /app/scripts/sandbox-*.sh │ Sandbox image build scripts           │ Upstream            │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ Docker + gosu             │ Nested Docker support                 │ Our patch #1        │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ Clean jiti cache          │ Prevent root-owned temp files         │ Our patch #2        │
  ├───────────────────────────┼───────────────────────────────────────┼─────────────────────┤
  │ docker.ts env propagation │ Pass sandbox.docker.env to containers │ Our patch #3        │
  └───────────────────────────┴───────────────────────────────────────┴─────────────────────┘

  Base Sandbox (openclaw-sandbox:bookworm-slim)

  Built by: Upstream sandbox-setup.sh, called from our rebuild-sandboxes.sh

  ┌───────────────────────┬───────────────────────────────────┬───────────┐
  │         Path          │             Contents              │ Who Added │
  ├───────────────────────┼───────────────────────────────────┼───────────┤
  │ /home/sandbox         │ Home dir, user sandbox (uid 1000) │ Upstream  │
  ├───────────────────────┼───────────────────────────────────┼───────────┤
  │ /home/linuxbrew       │ Homebrew home, user linuxbrew     │ Upstream  │
  ├───────────────────────┼───────────────────────────────────┼───────────┤
  │ Minimal Debian + bash │ Base OS                           │ Upstream  │
  └───────────────────────┴───────────────────────────────────┴───────────┘

  Common Sandbox (openclaw-sandbox-common:bookworm-slim)

  Built by: Upstream sandbox-common-setup.sh + our rebuild-sandboxes.sh layering

  Path: All base image contents
  Contents: Inherited
  Who Added: Upstream
  ────────────────────────────────────────
  Path: apt packages (git, nodejs, python3, etc.)
  Contents: Dev tools
  Who Added: Our config (sandbox-toolkit.yaml)
  ────────────────────────────────────────
  Path: /usr/local/bin/ tools (gifgrep, claude, etc.)
  Contents: Custom tool installs
  Who Added: Our config (sandbox-toolkit.yaml)
  ────────────────────────────────────────
  Path: /home/linuxbrew/.linuxbrew/bin/ (gh, himalaya, etc.)
  Contents: Brew tools
  Who Added: Our config (sandbox-toolkit.yaml)
  ────────────────────────────────────────
  Path: Image labels (config hash, build date)
  Contents: Change detection/staleness
  Who Added: Our rebuild-sandboxes.sh

  ---
  B. Container Creation Layers (Set When docker create Runs)

  These are set by OpenClaw's docker.ts when it creates a sandbox container. They cannot change without recreating
  the container.

  Automatic (OpenClaw core, no config needed)

  Mount: Workspace
  Source (gateway path): ~/.openclaw/sandboxes/agent-<id>-<hash>/
  Target (sandbox path): /workspace
  Mode: rw (confirmed, agents can write here)
  Notes: The workdir. OpenClaw copies template workspace files here on first agent start

  From openclaw.json config — Global Defaults

  ┌──────────────────────┬─────────────────┬─────────────────┬──────────────┬───────┐
  │        Mount         │     Source      │     Target      │     Mode     │ Type  │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Skill shims          │ /opt/skill-bins │ /opt/skill-bins │ ro           │ bind  │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Docs (friendly path) │ /app/docs       │ /workspace/docs │ ro           │ bind  │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Docs (default path)  │ /app/docs       │ /app/docs       │ ro           │ bind  │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Writable /tmp        │ —               │ /tmp            │ rw           │ tmpfs │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Writable /var/tmp    │ —               │ /var/tmp        │ rw           │ tmpfs │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Writable /run        │ —               │ /run            │ rw           │ tmpfs │
  ├──────────────────────┼─────────────────┼─────────────────┼──────────────┼───────┤
  │ Writable brew home   │ —               │ /home/linuxbrew │ rw, uid=1000 │ tmpfs │
  └──────────────────────┴─────────────────┴─────────────────┴──────────────┴───────┘

  Plus flags: readOnlyRoot: true, capDrop: ["ALL"], user: "1000:1000", pidsLimit: 512, memory: 2g, memorySwap: 4g,
  network: "none" (default)

  From openclaw.json config — Code Agent Overrides

  ┌─────────────────┬────────────────────────────────┬───────────────┬──────┬──────┐
  │      Mount      │             Source             │    Target     │ Mode │ Type │
  ├─────────────────┼────────────────────────────────┼───────────────┼──────┼──────┤
  │ Persistent home │ /home/node/sandboxes-home/code │ /home/sandbox │ rw   │ bind │
  └─────────────────┴────────────────────────────────┴───────────────┴──────┴──────┘

  Plus overrides: network: "bridge", image: openclaw-sandbox-common:bookworm-slim

  From openclaw.json config — Env Vars (via our docker.ts patch)

  ┌──────┬─────────────────────────────────────────────┬─────────────────────┐
  │ Var  │                Default Value                │ Code Agent Override │
  ├──────┼─────────────────────────────────────────────┼─────────────────────┤
  │ LANG │ C.UTF-8                                     │ inherited           │
  ├──────┼─────────────────────────────────────────────┼─────────────────────┤
  │ PATH │ /opt/skill-bins:... (prepended)             │ inherited           │
  ├──────┼─────────────────────────────────────────────┼─────────────────────┤
  │ HOME │ not set (uses image default: /home/sandbox) │ not set             │
  └──────┴─────────────────────────────────────────────┴─────────────────────┘

  ---
  C. Runtime Layers (After Container Starts)

  Entrypoint Actions (our entrypoint-gateway.sh, runs before gateway)

  Action: Ownership fix: sandboxes-home
  What It Does: chown -R 1000:1000 /home/node/sandboxes-home
  Affects Sandbox?: Yes — sandbox bind mount
  ────────────────────────────────────────
  Action: Ownership fix: .openclaw
  What It Does: chown -R 1000:1000 /home/node/.openclaw
  Affects Sandbox?: Yes — workspace dirs
  ────────────────────────────────────────
  Action: Shim generation
  What It Does: Creates pass-through scripts in /opt/skill-bins/
  Affects Sandbox?: Yes — bind mounted into sandboxes
  ────────────────────────────────────────
  Action: Dotfile seeding
  What It Does: Extracts /etc/skel/ into sandboxes-home/<agent>/
  Affects Sandbox?: Yes — seeds .bashrc, .profile
  ────────────────────────────────────────
  Action: Plugin deploy
  What It Does: Copies to ~/.openclaw/extensions/
  Affects Sandbox?: No (gateway only)
  ────────────────────────────────────────
  Action: Hook deploy
  What It Does: Copies to ~/.openclaw/hooks/
  Affects Sandbox?: No (gateway only)
  ────────────────────────────────────────
  Action: Start nested dockerd
  What It Does: Creates docker socket at /var/run/docker.sock
  Affects Sandbox?: Yes — used to create sandboxes
  ────────────────────────────────────────
  Action: Sandbox image builds
  What It Does: Calls rebuild-sandboxes.sh
  Affects Sandbox?: Builds images used BY sandboxes

  Gateway Actions (OpenClaw core, at agent session start)

  Action: ensureBootstrapFiles()
  What It Does: Creates AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, BOOTSTRAP.md in template workspace IF
    they don't exist
  ────────────────────────────────────────
  Action: Copy to sandbox
  What It Does: Copies template workspace files into ~/.openclaw/sandboxes/agent-<id>-<hash>/
  ────────────────────────────────────────
  Action: System prompt injection
  What It Does: Reads workspace .md files and injects into LLM system prompt (hardcoded file list)

  Plugin Actions (our coordinator plugin)

  ┌─────────────────────────┬────────────────────┬─────────────────────────────────────────────────────────────────┐
  │         Action          │        When        │                         Where It Writes                         │
  ├─────────────────────────┼────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Build routing table     │ Plugin             │ Template workspace AGENTS.md + all existing coordinator         │
  │                         │ registration       │ sandboxes                                                       │
  ├─────────────────────────┼────────────────────┼─────────────────────────────────────────────────────────────────┤
  │ Hook:                   │ Each agent start   │ That sandbox's AGENTS.md                                        │
  │ before_agent_start      │                    │                                                                 │
  └─────────────────────────┴────────────────────┴─────────────────────────────────────────────────────────────────┘

  ---
  D. Things That Are NOT Mounted (Common Misconceptions)

  Path: ~/.openclaw/workspace/
  Why It's Not Accessible: Not a child of sandboxRoot (which is ~/.openclaw/sandboxes/agent-xxx/)
  Current Workaround: Files copied INTO sandbox; read tool resolves against sandbox workdir
  ────────────────────────────────────────
  Path: ~/.openclaw/media/
  Why It's Not Accessible: Sibling of sandboxRoot, not child
  Current Workaround: None — browser screenshots broken with scope: "agent"
  ────────────────────────────────────────
  Path: ~/.openclaw/host-status/
  Why It's Not Accessible: Not under sandbox root
  Current Workaround: Double-write to workspace/host-status/ which gets... wait

  ---
  E. The Critical Question Mark

  Here's where the analysis gets interesting. The read tool resolves relative paths against the sandbox workdir
  (/workspace). But the workspace is a copy of the template, not a live mount. So:

  1. host-alert.sh writes health.json to ~/.openclaw/workspace/host-status/
  2. OpenClaw copies template workspace files into the sandbox dir at agent start
  3. But host-status/ is NOT a bootstrap file — it's not in the hardcoded list
  4. So it won't get copied to ~/.openclaw/sandboxes/agent-main-xxx/host-status/

  If agents ARE successfully reading host-status/health.json, it's either because:

- The read tool resolves against the template workspace, not the sandbox copy (gateway-mediated, not filesystem)
- Or scope: "agent" sandbox dirs mount the entire template workspace as an overlay (not just a copy of bootstrap
  files)

  This is the key unknown. The read tool routing through the gateway might bypass sandboxRoot path validation
  entirely for cron agents (which run unsandboxed in the main agent loop?).

  F. Identified Hacks vs Config Options

  ┌────────────────────────────────────┬─────────────────────────────┬─────────────────────────────────────────────┐
  │             What We Do             │      Hack or Correct?       │             Better Alternative?             │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │                                    │                             │ Drop it. /app/docs:/app/docs:ro is          │
  │ /app/docs:/workspace/docs:ro bind  │ Hack — duplicate mount      │ sufficient since the system prompt          │
  │                                    │                             │ references /app/docs                        │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │                                    │ Correct — matches where     │                                             │
  │ /app/docs:/app/docs:ro bind        │ gateway tells agents docs   │ Keep                                        │
  │                                    │ live                        │                                             │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │ sandboxes-home/code:/home/sandbox  │ Correct — intentional       │ Keep. Could also use a hypothetical         │
  │ bind                               │ persistent home             │ persistentHome config if OpenClaw adds one  │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │ Double-write host-status to        │ Probably unnecessary —      │                                             │
  │ workspace                          │ depends on how read tool    │ Needs VPS verification                      │
  │                                    │ resolves paths              │                                             │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │ docker.ts env patch                │ Hack — upstream bug         │ Remove when upstream fixes docker.env       │
  │                                    │ workaround                  │ propagation                                 │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │                                    │ Correct — brew needs        │                                             │
  │ /home/linuxbrew tmpfs              │ writable home, separate     │ Keep                                        │
  │                                    │ from $HOME                  │                                             │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │ scope: "agent" with no             │ Limits us — media           │ scope: "shared" + workspaceRoot:            │
  │ workspaceRoot                      │ inaccessible, workspace     │ "/home/node/.openclaw" would fix media      │
  │                                    │ files may not reach sandbox │ access and simplify workspace file access   │
  ├────────────────────────────────────┼─────────────────────────────┼─────────────────────────────────────────────┤
  │                                    │ Missing — REQUIREMENTS.md   │ Add "HOME": "/home/sandbox" to code agent   │
  │ env.HOME not set for code agent    │ says it should be           │ env                                         │
  │                                    │ /home/sandbox               │                                             │
  └────────────────────────────────────┴─────────────────────────────┴─────────────────────────────────────────────┘

  Want me to verify on the VPS how the read tool actually resolves paths (template workspace vs sandbox copy)? That
  would confirm whether the double-write pattern is actually working or if we've been lucky.

---

> Re: asked another claude to confirm or deny host-status issue

 The bind mount was never added to openclaw.json. It was in the plan but got missed during implementation.

  The chain:

  1. Host cron → writes to /home/openclaw/.openclaw/workspace/host-status/
  2. Docker compose OPENCLAW_CONFIG_DIR mount → visible inside gateway at /home/node/.openclaw/workspace/host-status/
  3. Agent sandbox → no bind mount → files invisible to the read tool

  The read tool runs inside the sandbox container. With scope: "agent", /workspace/ is the agent's sandbox directory,
  not the gateway's template workspace. host-status/ is not a bootstrap file so it never gets copied in.

  The fix is adding the bind to the sandbox defaults in openclaw.json:

⏺ Update(deploy/openclaw.json)
  ⎿  Added 3 lines, removed 1 line
      124              "/opt/skill-bins:/opt/skill-bins:ro",
      125              // Add openclaw docs to each agent - helps agents answer openclaw usage questions without
           relying on LLM fetching of docs
      126              "/app/docs:/workspace/docs:ro", // Agents can use 'read' tool to access docs here - requir
           es customizing AGENTS.md to use /workspace/docs location
      127 -            "/app/docs:/app/docs:ro" // Default location of docs - openclaw's default instructions dir
          -ect agents to look here - requires 'exec' to access
      127 +            "/app/docs:/app/docs:ro", // Default location of docs - openclaw's default instructions di
          +rect agents to look here - requires 'exec' to access
      128 +            // Host health & maintenance data — written by host cron scripts, read-only for agents
      129 +            "/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro"
      130            ]
      131          },
      132          // Each agent has it's browser container - requires the "browser" tool

⏺ Now deploy it. You'll need to:

  1. SCP the updated openclaw.json to the VPS
  2. Restart the gateway (sandbox config changes require restart — they're in the agents section which is kind: "none"
  for hot-reload)
  3. The sandbox containers will be recreated with the new bind mount on next agent start

  After restart, the main agent's read tool will see host-status/health.json and host-status/maintenance.json at
  /workspace/host-status/.

  To test immediately on the VPS (before restarting), you can trigger the maintenance checker to confirm the files exist
   at the gateway level:

# Verify files exist on the host

  cat /home/openclaw/.openclaw/workspace/host-status/health.json
  cat /home/openclaw/.openclaw/workspace/host-status/maintenance.json

# If either is missing, trigger them

  sudo /home/openclaw/scripts/host-alert.sh
  sudo /home/openclaw/scripts/host-maintenance-check.sh

  Want me to walk through the deploy commands, or do you want to handle it?

---

> After deploying sandbox changes including missing bind mount

/workspace/host-status/ files now exists in sandboxes.

---

## Tool `Read` Trace

Test Results & Findings

  Test Procedure

  1. Created probe file read-probe-test.txt with content PROBE_TEST_2026_02_16_readpath_verification in the template
   workspace ONLY (~/.openclaw/workspace/)
  2. Verified it was NOT in any sandbox dir via find
  3. Sent interactive test via openclaw agent --agent main --message "read read-probe-test.txt"
  4. Result: FAILED — gateway logged: Sandbox FS error (ENOENT):
  /home/node/.openclaw/sandboxes/agent-main-0d71ad7a/read-probe-test.txt
  5. Copied probe into sandbox dir, retested — SUCCEEDED, returned file contents
  6. Cleaned up both files

  Key Discovery: workspaceDir Differs by Session Type

  Extracted from debug.log bootstrap events:

  ┌─────────────────────────────────┬─────────────────────────────────────────────┐
  │          Session Type           │                workspaceDir                 │
  ├─────────────────────────────────┼─────────────────────────────────────────────┤
  │ agent:main:main (interactive)   │ ~/.openclaw/sandboxes/agent-main-0d71ad7a   │
  ├─────────────────────────────────┼─────────────────────────────────────────────┤
  │ agent:code:main (interactive)   │ ~/.openclaw/sandboxes/agent-code-d70aca26   │
  ├─────────────────────────────────┼─────────────────────────────────────────────┤
  │ agent:skills:main (interactive) │ ~/.openclaw/sandboxes/agent-skills-e087ba68 │
  ├─────────────────────────────────┼─────────────────────────────────────────────┤
  │ agent:main:cron:*(cron)        │ ~/.openclaw/workspace                       │
  ├─────────────────────────────────┼─────────────────────────────────────────────┤
  │ agent:skills:cron:* (cron)      │ ~/.openclaw/workspace-skills                │
  └─────────────────────────────────┴─────────────────────────────────────────────┘

  What This Means

  The read tool resolves relative paths against workspaceDir on the gateway filesystem. This is gateway-mediated,
  not sandbox-filesystem-mediated.

- Interactive sessions: workspaceDir = the per-agent sandbox dir. Files MUST be in
  ~/.openclaw/sandboxes/agent-<id>-<hash>/ to be readable
- Cron sessions (isolated): workspaceDir = the template workspace. Files in ~/.openclaw/workspace/ ARE readable
- Each agent gets its own cron workspace: workspace for main, workspace-<agentId> for others

  Impact on Current Architecture

  (This analysis was BEFORE the bind mount was fixed in openclaw.json - no longer accurate)

  1. The host-status workspace copy pattern works for cron jobs — the daily health check cron runs as
  agent:main:cron:* with workspaceDir: ~/.openclaw/workspace, so host-status/health.json IS accessible at relative
  path host-status/health.json
  2. Interactive agents CANNOT read host-status data — the file is not in the sandbox dir. If you asked the main
  agent in a Telegram chat "how's the VPS doing?", the read tool would fail
  3. The "bind mounts don't work" issue is separate — even if we could add a bind mount, the read tool path
  validation runs on the gateway side against sandboxRoot, not the container filesystem. A bind mount at
  /workspace/host-status in the sandbox container wouldn't help because the gateway resolves paths before executing
  in the sandbox
  4. MEMORY.md's claim was partially wrong — "Files placed in workspace are readable by agents via the read tool" is
   only true for cron agents, not interactive agents. Updated memory.

> Rerun tests after bind mount fix deployed

Updated Results After Bind Mount Fix

  Test 2: With Bind Mount

  The other session added this bind to openclaw.json defaults:
  "/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro"

  After sandbox recreation, I reran the test:

  1. Created probe read-bind-probe.txt in ~/.openclaw/workspace/host-status/ (the host dir that's bind-mounted)
  2. Verified it appears inside the sandbox container at /workspace/host-status/read-bind-probe.txt via docker exec
  3. Interactive read test → SUCCEEDED — agent returned exact file contents
  4. Real file test (host-status/health.json) → SUCCEEDED — agent returned disk_pct: 52, memory_pct: 20

  How It Works

  The bind mount workspace/host-status:/workspace/host-status:ro overlays onto the sandbox's /workspace workdir.
  When the gateway resolves relative path host-status/health.json, it checks <sandboxRoot>/host-status/health.json.
  The bind mount makes this path exist inside the container even though the file is physically in the template
  workspace directory.

  Two Corrected Assumptions

  1. Bind mounts DO work — they just require sandbox container recreation (not just gateway restart). Our earlier
  "binds are broken" finding was wrong; we likely didn't recreate sandbox containers after the config change.
  2. Per-agent binds REPLACE defaults, they don't merge — the code agent config now manually repeats all 4 default
  binds plus its own. This contradicts the config.ts:55 concatenation reference from the earlier plan doc. Either
  the behavior changed or that reference was wrong.

  Remaining Finding Still Valid

  The workspaceDir difference between interactive and cron sessions is confirmed and unchanged:

- Interactive: resolves against sandbox dir (bind mounts needed for extra files)
- Cron (isolated): resolves against template workspace directly (no bind needed)

The cron session's workspaceDir is /home/node/.openclaw/workspace (the template workspace, not a sandbox dir). This
  confirms that isolated cron sessions read directly from the template workspace — meaning host-status/health.json was
  accessible at /home/node/.openclaw/workspace/host-status/health.json even before we added the bind mount.

  The bind mount we added is still needed for interactive sessions (where workspaceDir is the per-agent sandbox dir),
  but the cron was already working because isolated cron sessions use the template workspace directly.

  The HEARTBEAT_OK result and 5s duration confirms the agent successfully read both files and found everything healthy.
  The cron job is working correctly.

---

> Run another read test to the code agent to confirm it's reading openclaw docs from /app/docs in one shot

Here are the definitive results:

  Docs Read Test Summary

  ┌────────────────────────┬──────────────────────────┬───────────────────────────────────────────────────────┐
  │          Test          │           Path           │                        Result                         │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────┤
  │ Relative path          │ docs/index.md            │ Works — resolves to /workspace/docs/ inside container │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────┤
  │ Absolute sandbox-style │ /workspace/docs/index.md │ Works                                                 │
  ├────────────────────────┼──────────────────────────┼───────────────────────────────────────────────────────┤
  │ Absolute /app/docs     │ /app/docs/index.md       │ Works — via the second bind mount                     │
  └────────────────────────┴──────────────────────────┴───────────────────────────────────────────────────────┘

  What the System Prompt Actually Says

  OpenClaw docs: /home/node/.openclaw/sandboxes/agent-main-0d71ad7a/docs

  That's the gateway-side equivalent of /workspace/docs inside the container. No reference to /app/docs anywhere in
  the system prompt.

  Which Bind Does What

  Bind: /app/docs:/workspace/docs:ro
  Purpose: Serves docs at docs/ relative to workdir
  Referenced by system prompt?: Yes — this is the path agents are told to use
  ────────────────────────────────────────
  Bind: /app/docs:/app/docs:ro
  Purpose: Serves docs at absolute /app/docs
  Referenced by system prompt?: No — nothing directs agents here

  Conclusion

  The /app/docs:/app/docs:ro bind is safe to remove. The system prompt exclusively points agents to
  <sandboxRoot>/docs which is served by the /workspace/docs bind. The only way an agent would hit /app/docs is if
  explicitly told to by a user — and even then, the docs are available at docs/ which is the documented path.

  Also a bonus finding from this test: the read tool executes inside the sandbox container, not on the gateway
  filesystem. The gateway-side docs/ dir is completely empty, yet reads succeed because the bind mount provides
  content inside the container.

---

## Linuxbrew Issues

> let's give it some more thought. the original reason /home/linuxbrew was added to tmpfs we to allow rapidly
> updating tools like claude code to be able to auto update. How can we solve both problems? Isn't there a way to
> make /home/linuxbrew an overlay instead of replace?

⏺ Good instinct. Let me think through this properly.

  The tmpfs on /home/linuxbrew doesn't actually achieve what it's meant to. Here's why:

  Why tmpfs doesn't enable auto-updates:

- readOnlyRoot: true means the entire image filesystem is read-only
- The tmpfs gives a writable but empty /home/linuxbrew — so any "update" means installing from scratch into empty
  tmpfs RAM, on every container start
- Claude Code auto-update (npm install -g) writes to /usr/local/ which is on the read-only root — it would fail
  regardless of the linuxbrew tmpfs
- Any runtime install into tmpfs is lost on restart anyway

  So the tmpfs is causing breakage without actually enabling the feature it was added for.

  Can we do an overlay instead of a replace? Docker's --mount only supports bind, tmpfs, and volume — no native overlay
   option. To get overlay behavior:

  ┌───────────────────────────────────────────────┬────────────────────────────┬──────────────────────────────────────┐
  │                   Approach                    │            Pros            │                 Cons                 │
  ├───────────────────────────────────────────────┼────────────────────────────┼──────────────────────────────────────┤
  │ fuse-overlayfs in entrypoint                  │ True overlay, writable +   │ Needs /dev/fuse, may not work with   │
  │                                               │ base content               │ capDrop: ALL                         │
  ├───────────────────────────────────────────────┼────────────────────────────┼──────────────────────────────────────┤
  │ Entrypoint copies brew from /opt/linuxbrew/   │ Writable + base content    │ Slow startup, uses 500MB+ RAM per    │
  │ snapshot into tmpfs                           │                            │ container                            │
  ├───────────────────────────────────────────────┼────────────────────────────┼──────────────────────────────────────┤
  │ Entrypoint symlinks tmpfs → /opt/linuxbrew/   │ Fast, base content works   │ Runtime brew install fails           │
  │                                               │                            │ (read-only target)                   │
  ├───────────────────────────────────────────────┼────────────────────────────┼──────────────────────────────────────┤
  │ Remove tmpfs entirely                         │ Simplest, everything works │ No runtime installs (but those don't │
  │                                               │                            │  work now either)                    │
  └───────────────────────────────────────────────┴────────────────────────────┴──────────────────────────────────────┘

  The last option is the right one. The tmpfs was well-intentioned but counterproductive given readOnlyRoot: true. If
  we ever need runtime tool updates, the right mechanism is rebuilding the sandbox image or setting tool-specific
  writable prefixes (e.g., NPM_CONFIG_PREFIX=/tmp/npm).
