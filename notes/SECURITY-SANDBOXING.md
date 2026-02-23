# Security Sandboxing Exploration

## Core Problems Exposed

1. No media bridge — browser.screenshot() saves to gateway's media/browser/, which isn't bind-mounted into sandboxes.
  The agent gets a path it literally cannot access through any tool.
2. LLM has no awareness of sandbox constraints — The system prompt lists tools but says nothing about network
isolation, read-only filesystem, or missing binaries. The LLM discovers every limitation through expensive trial and
error.
3. No guardrails on escalation — OpenClaw doesn't limit turns, token spend, or retry attempts. The LLM burned 133
tool calls across 5 sessions with zero intervention.
4. Error reporting is ambiguous — isError is never set to true; errors are embedded as JSON text in normal tool
results. The LLM has to parse text to know something failed.
5. Context grows monotonically — Every tool result (including large base64 data) accumulates in conversation history,
  making overflow inevitable for large data operations.

## Strategy Areas to Discuss

I see four categories of defense:

```text
┌───────────────────────────┬───────────────────────────────────────────────────┬───────────────────────────────┐
│         Strategy          │                 What it addresses                 │          Complexity           │
├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────┤
│ A. Constraint disclosure  │ Tell agents what they can/can't do in AGENTS.md   │ Low — just prompt engineering │
├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────┤
│ B. Media/file bridge      │ Bind mount media/browser/ or add a copy mechanism │ Medium — config change        │
├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────┤
│ C. Turn/token limits      │ Cap agent sessions to prevent runaway spend       │ Medium — OpenClaw config      │
├───────────────────────────┼───────────────────────────────────────────────────┼───────────────────────────────┤
│ D. Tool scoping per agent │ Only give agents tools they actually need         │ Low — already in config       │
└───────────────────────────┴───────────────────────────────────────────────────┴───────────────────────────────┘
```

## D. Tool Scoping per Agent

Current Tool Landscape

```text
  Agent: main
  Tools it gets: Everything minus browser/canvas/nodes/discord
  What it actually needs: sessions_spawn, sessions_list, session_status, read, exec
  ────────────────────────────────────────
  Agent: code
  Tools it gets: All sandbox defaults (12 tools)
  What it actually needs: exec, read, write, edit, apply_patch, process, browser
  ────────────────────────────────────────
  Agent: skills
  Tools it gets: All sandbox defaults minus sessions_spawn
  What it actually needs: exec, read, write (most skills are CLI wrappers)
  ────────────────────────────────────────
  Agent: personal
  Tools it gets: All sandbox defaults (12 tools!)
  What it actually needs: browser, read, write, maybe exec
  ────────────────────────────────────────
  Agent: work
  Tools it gets: All sandbox defaults (12 tools!)
  What it actually needs: browser, read, write, maybe exec
```

  The Problem from the Writeup

  Personal agent had access to 12 tools including exec, process, sessions_spawn, and cron — none of which helped it
  save a screenshot, but all of which gave the LLM more things to try. The runaway spiral was partly fueled by:

  1. exec — let it try cp, find, Puppeteer, Python scripts, pip install, port scanning, HTTP servers...
  2. process — could inspect running processes
  3. sessions_spawn — could theoretically spawn other agents
  4. cron — totally irrelevant for a browser agent

  The more tools available, the more creative escape routes the LLM explores when blocked.

  Proposed Scoping

  Personal/Work agents — browser-focused, minimal tools:

  allow: ["browser", "read", "write"]
  deny: ["exec", "process", "sessions_spawn", "cron", "gateway"]

  Removing exec is the big one. It eliminates the entire class of "let me try shell commands" escalation. Without exec,
   the LLM can't attempt cp, find, pip install, Python scripts, port scanning, or HTTP servers. The 50-step spiral
  would have stopped at step 1.

  The tradeoff: the agent can't run any scripts. If it needs to process data, it has to use browser.evaluate() or ask
  main to delegate to another agent.

  Skills agent — tighter:

  allow: ["exec", "read", "write", "edit"]
  deny: ["browser", "process", "sessions_spawn", "cron", "gateway", "apply_patch"]

  Skills are CLI wrappers — they need exec but not browser, session management, or cron.

  Code agent — needs the most, but still can trim:

  allow: ["exec", "read", "write", "edit", "apply_patch", "process", "browser"]
  deny: ["sessions_spawn", "cron", "gateway"]

>> let's pop up a level and think about the main entry point, the main agent coordinator. It's the heard and soul
> of the system. The friendly voice and know who the primary user is. It makes sense that it would have a rich
> AGENTS.md and related md files rolled up in it's prompt. But what would it look like if it had no tools or
> skills (in the traditional OpenClaw sense) but was still able to effectively process requests? I could image a
> system prompt that's more high level and routing and capability focused. So if a user is just chatting with it
> about misc stuff, it can quickly and reliably answer (just LLM interactions). Then when the user ask it to do
> something: e.g. What's the summary of today's personal email? It knows how to route based on context but doesn't
> know how to execute.
>
> Does that make sense?

⏺ Yes, that makes total sense. You're describing what I'd call a "brain with no hands" pattern — main is the
  personality, memory, and routing intelligence, but it physically cannot do anything except talk and delegate.

  What Main Actually Needs

  Strip it down to the absolute minimum:

```text
  ┌──────────────────┬──────────────────────────────────┐
  │       Tool       │               Why                │
  ├──────────────────┼──────────────────────────────────┤
  │ sessions_spawn   │ Delegate tasks to sub-agents     │
  ├──────────────────┼──────────────────────────────────┤
  │ sessions_list    │ See what's running               │
  ├──────────────────┼──────────────────────────────────┤
  │ session_status   │ Check on delegated work          │
  ├──────────────────┼──────────────────────────────────┤
  │ sessions_send    │ Follow up on an existing session │
  ├──────────────────┼──────────────────────────────────┤
  │ sessions_history │ Review past interactions         │
  └──────────────────┴──────────────────────────────────┘
```

  That's it. Five tools. No exec, no read, no write, no browser, no cron.

  What This Buys You

  Security: Main is the most exposed agent — it receives raw user input from Telegram, WhatsApp, whatever. It also runs
   non-main mode, meaning operator DMs execute on the host unsandboxed. Right now, if someone prompt-injects main via a
   forwarded message or a crafted link, main has exec on the gateway host. That's game over. Removing all execution
  tools from main means a successful prompt injection can only... spawn a sub-agent. Which runs sandboxed.

  Cost control: The runaway spiral happened because the agent had tools to keep trying. A main with no exec literally
  cannot spiral — it either delegates successfully or tells the user "I can't do that."

  Simplicity: Main's system prompt shrinks dramatically. No tool documentation for exec, read, write, edit,
  apply_patch, process, browser, cron. That's easily 5-10K tokens of system prompt removed per turn. Every turn is
  cheaper and faster.

  The Conversational Flow

  User: "What's the summary of today's personal email?"

  Main thinks:
    - This is an email task
    - Routing table says: himalaya skill → skills agent
    - I need to spawn skills agent with clear instructions

  Main calls: sessions_spawn("skills",
    "Check today's personal email using himalaya.
     Return a brief summary of each message: sender, subject,
     and one-line synopsis. No need to save files.")

  Skills agent: runs himalaya, processes, returns text summary

  Main receives result, reformulates in its own voice:
    "You've got 3 emails today:
     - Mom: Dinner Sunday? She's making lasagna.
     - AWS: Your bill is $47.23, up 12% from last month.
     - Newsletter: React 20 announced, drops class components."

  The key insight: main never touches the email. It just knows who to ask and how to frame the request, then translates
   the result into its own personality.

  The Hard Question: What About Quick Tasks?

  The tradeoff is latency. Currently main can read a file or exec a quick command directly. Under this model:

- "What time is it?" — Pure LLM, no tools needed. Fast.
- "Read my AGENTS.md" — Has to spawn a sub-agent just to read a file. Slower.
- "What's in /workspace/notes.md?" — Same, needs delegation.

  Three options for handling this:

  1. Accept the latency. Spawning a sub-agent adds ~5-10s. For most real tasks (email, browser, coding), users already
  wait. The security gain is worth it.
  2. Give main read only. One read-only tool. Can't write, can't exec. Still dramatically reduces attack surface. But
  now main running on host can read any file the gateway user can access.
  3. Give main read but only in sandbox mode. Main's non-main sessions (operator DMs) get no tools. Main's sandboxed
  sessions (group chats, spawned contexts) get read. This actually matches the threat model — DMs from Telegram are the
   highest-risk input.

  What's your instinct? Pure delegation (no tools at all), or read-only as a compromise?

---

> ts discuss B. we need to protect against agents being able to access other agent's downloaded data unless
> explcitly authorized (via config). research to see how the openclaw community and official openclaw docs or code
> recommends handling this. Agents need to be able to access data the download (per agent scope - if an agent can
> access a website, it should have full access to the data), but no agent-to-agent cross access by default unless
> explicitly granted

⏺ Good question. Let me research how OpenClaw actually handles media storage and what isolation mechanisms exist (or
  don't).

⏺ 2 agents finished (ctrl+o to expand)
   ├─ Explore (Research OpenClaw media isolation) · 76 tool uses · 120.7k tokens
   │  ⎿  Done
   └─ Task (Search web for OpenClaw media isolation) · 20 tool uses · 33.7k tokens
      ⎿  Done

⏺ Excellent research. Here's the full picture:

  Current State: No Per-Agent Media Isolation

  ~/.openclaw/media/browser/ is a single shared directory. Every agent's browser screenshots land there with UUID
  filenames, 0o600 permissions, all owned by the node user. There's no per-agent subdirectory, no agent-ID scoping, no
  access control.

  The saving grace for sandboxed agents: they can't directly read this path. The gateway reads the file, base64-encodes
   it, and returns it inline in the tool result. So a sandboxed agent only ever receives its own screenshot as inline
  data — it never gets filesystem access to the shared media dir.

  But — the main agent (running non-main on the host) can ls and cp from ~/.openclaw/media/browser/ freely. And any
  agent with exec + network: bridge could potentially discover paths through session history or inter-agent messages.

  The Isolation Layers That Already Exist

  ┌───────────────────────────────┬───────────────────────────────┬───────────────────────────────────────────────────┐
  │             Layer             │       What it protects        │                    Limitations                    │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────────────────────────┤
  │ Sandbox path validation       │ Blocks read tool from         │ Only applies to read/write/edit — not exec        │
  │ (resolveSandboxPath)          │ escaping sandbox root         │                                                   │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────────────────────────┤
  │                               │ Sandboxed agents only see     │ media/browser/ is not mounted, so agents can't    │
  │ Bind mount isolation          │ /workspace/ + explicit mounts │ read it... but also can't access their own        │
  │                               │                               │ downloads                                         │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────────────────────────┤
  │ Agent-scoped local roots      │ Media serving validates       │ Only for outbound media delivery, not for tool    │
  │                               │ against agent's workspace     │ access                                            │
  ├───────────────────────────────┼───────────────────────────────┼───────────────────────────────────────────────────┤
  │ UUID filenames                │ No collision between agents   │ Security through obscurity, not access control    │
  └───────────────────────────────┴───────────────────────────────┴───────────────────────────────────────────────────┘

  The Gap

  The writeup nailed it: the browser tool returns a MEDIA: path that points to gateway-side storage the agent can't
  reach. This is actually accidental isolation — it prevents cross-agent access, but it also prevents self-access. The
  agent can see its own screenshot inline (bloating context) but can't save it as a file.

  What Upstream Is Doing

  From the GitHub issues:

- #7722 (closed Feb 14, 2026) — Filesystem sandboxing config. Supposedly implemented but details unclear.
- #10004 (open, stale) — Multi-agent per-org isolation. Proposes workspace isolation, session visibility, credential
  scoping. Not implemented.
- #7827 (open) — Secure defaults proposal. Sandboxing should be opt-out, not opt-in.
- #12202 (closed as dup of #7722) — Per-agent file path allowlists.

  No one upstream has addressed the media/browser/ shared directory specifically. The term "media bridge" doesn't
  appear in any official docs.

  Design Options for Our Config

  Given that upstream hasn't solved this, here's what we can do with current config:

  Option 1: Rely on Sandbox Isolation (Current Behavior, Documented)

  Sandboxed agent → browser.screenshot() → gateway saves to media/browser/
                                          → returns inline base64 to agent
                                          → agent sees image but can't access file

  Pros: Already works. No cross-agent access for sandboxed agents.
  Cons: Agent can't save its own screenshot to /workspace/. The exact problem from the writeup.

  Option 2: Bind Mount Per-Agent Media Subdirectory

  Create per-agent media dirs on the host and bind-mount them:

  // personal agent
  "binds": [
    "/home/node/.openclaw/media/personal:/workspace/media:ro",
    // ... other binds
  ]

  Problem: saveMediaBuffer doesn't support per-agent subdirs. Screenshots still go to media/browser/, not
  media/personal/. We'd need a post-save hook or symlink structure that doesn't exist upstream.

  Option 3: Post-Screenshot Copy via Gateway Hook

  Use an OpenClaw hook to intercept browser tool results and copy the media file into the agent's sandbox workspace:

  browser.screenshot() completes
    → hook fires: cp media/browser/<uuid>.jpg → sandboxes/agent-personal-<hash>/media/
    → tool result includes /workspace/media/<uuid>.jpg (sandbox-local path)

  Problem: OpenClaw hooks fire on events like agent:bootstrap, gateway:startup — not on individual tool results. No
  tool:complete hook exists.

  Option 4: The Pragmatic Answer — Accept Inline + Deny exec

  For agents that use browser:

  {
    "id": "personal",
    "tools": {
      "allow": ["browser", "read", "write"],
      "deny": ["exec", "process", "sessions_spawn", "cron", "gateway"]
    }
  }

- Agent gets screenshots inline (via tool result) — can see and describe them
- Agent can write files to /workspace/ — but only text, not binary from inline images
- Without exec, the entire 50-step spiral is impossible
- If the agent needs to save an image: main (coordinator) can retrieve it from media/browser/ and write it to the
  agent's workspace (since main runs on host)

  This doesn't solve the "save screenshot to file" use case, but it prevents the runaway and prevents cross-agent
  access by removing the tools that enable both.

  ---
  What's your take? Option 4 is the most pragmatic with zero upstream changes. The "save to file" gap is real but could
   be papered over with a coordinator flow (main copies the file after the sub-agent reports success).
