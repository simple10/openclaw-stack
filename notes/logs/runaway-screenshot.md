# Runaway Screenshot Request - Feb 17 2026

This is a bit insane. But it shows the risk of running OpenClaw in secure environments
without fully understand how all the pieces work together - and don't.

This was intended to be a simple test of how browser sandboxing works with multiple agents.

Chat with main agent, ask it to pass along a request to a subagent (Personal Agent) to
use the Personal Agent's browser to do stuff. In this test, it was taking a screenshot.

The use case: different agents, different browser, different websites pre-authenticated.

Simple, right?

Except it caused a crazy chain reaction that illustrated A LOT about how OpenClaw works
and how creative and persistent the LLM can get to fulfill a task. This is what makes
OpenClaw and agentic systems powerful (the model), but also what makes things go off
the rails extremely quickly due to misconfiguration or intential security policies.

The initial prompt:

> ok. now have the Personal Agent take a screenshot of proclaw.co

[Full Chat Screenshot](./screenshots/CleanShot%202026-02-17%20at%2020.29.44@2x.png) (for reference)

1. Main agent spawned the subagent task: `Open the browser, navigate to proclaw.co, and take a screenshot of the page.`
2. Done - personal agent connected to its browser running in a sandboxed container via CDP (debugging port)

I went and checked the downloaded file. It's tiny and super compressed because the web page is long.

The image is too compressed to read anything or be useful for archiving.

Next prompt:

> take a png screenshot with max resolution

1. Main agent spawns personal agent sub-request: `Navigate to proclaw.co in the browser and take a full-page PNG screenshot at maximum resolution. Save it to /workspace/proclaw-screenshot.png`
2. Personal agent accepts the request
3. ... then nothing happens in the chat for several minutes ...

Next chat message shown in the thread:

`That one ran out of context — the full-page screenshot at max resolution was too large and the agent's session overflowed trying to process it.`

WTF? - I was expecting something was amiss with how long the request was taking. The response message
confirms it. Something definitely went wrong.

I jump back to my local `claude` code session and say: `Check the openclaw logs. I'm seeing error messages.`

It saw the errors right away. The CLAUDE.md and playbooks/* teach it how to debug openclaw.

There were a couple errors. One was file access error due to sandbox workspace paths, and one was a network
error since Personal Agent doesn't have networking enabled for it's sandbox.

But the network normally doesn't matter since the Personal Agent's companion browser sandbox DOES have network.
It was previously able to take a screenshot without any trouble. It's just the highres screenshot
somehow caused a network error.

Strange. Also, strange that it had a file read error. But maybe that's to be expected with sandboxing?

> A FEW MOMENTS LATER...

PING - text message alert on my phone.

Anthropic charged $15 to my credit card.

OK, maybe I ran out of credit from the previous API billing. And I'm using my Anthropic API key for these
tests. Most likely there were a few LLM turns with the failed permissions issues. I've seen this plenty
of times with OpenClaw sandboxing. My current dev OpenClaw setup is intentionally all default AGENTS.md
and no prompt optimizations.

I take a quick look at the openclaw logs via one of my debug scripts: `./scripts/logs-openclaw.sh`

```bash
openclaw-gateway  | 2026-02-18T02:36:27.796+00:00 The browser isn't running inside the sandbox — it's controlled externally by the browser tool. The CDP endpoint isn't exposed at localhost:9222 in this container. Given the constraints (no CDP access from the sandbox), the only way to take the screenshot is via the browser tool's screenshot action. Let me use it but write directly to file to avoid context overflow:
openclaw-gateway  | 2026-02-18T02:36:27.797+00:00 The CDP/browser is not directly accessible from within the sandbox via HTTP. The browser tool is an external API. I'll use the browser tool's screenshot but save it to file — the tool returns the image data which I can then write.
```

OK, this is definitely getting weird. The agent hit a context window overflow???

That means it was sending prompts messages that exceeded Sonnet 4.5's input context window size of 200,000 tokens.

For a simple request to use a tool in a sandbox to take a screenshot.

I asked claude to dig deeper into the logs and trace the request flow...

---
CLAUDE

The session trace is complete. Here's the full picture of what happened across all 5 personal agent sessions:

  Multi-Agent Request Flow — Complete Trace

  Session Timeline

  ┌─────┬──────────┬─────────┬──────────────────────┬───────────────────────────────┬──────────────────────────────┐
  │  #  │ Session  │  Time   │         Size         │             Task              │           Outcome            │
  │     │          │  (UTC)  │                      │                               │                              │
  ├─────┼──────────┼─────────┼──────────────────────┼───────────────────────────────┼──────────────────────────────┤
  │ 1   │ 5b43d1e2 │ 01:54   │ 1.7KB                │ "Open browser to google.com"  │ 401 auth error — missing     │
  │     │          │         │                      │                               │ models.json                  │
  ├─────┼──────────┼─────────┼──────────────────────┼───────────────────────────────┼──────────────────────────────┤
  │     │          │         │                      │ "Navigate to proclaw.co, take │ Success — screenshot         │
  │ 2   │ ea58ff77 │ 02:22   │ 58KB                 │  screenshot"                  │ returned inline, no file     │
  │     │          │         │                      │                               │ save                         │
  ├─────┼──────────┼─────────┼──────────────────────┼───────────────────────────────┼──────────────────────────────┤
  │ 3   │ 4e29832a │ 02:23   │ 1.4MB                │ "Full-page PNG at max         │ Context overflow (616K       │
  │     │          │         │                      │ resolution → /workspace/"     │ tokens > 200K limit)         │
  ├─────┼──────────┼─────────┼──────────────────────┼───────────────────────────────┼──────────────────────────────┤
  │ 4   │ 3c6bedce │ 02:27   │ 847KB                │ "Viewport-only PNG →          │ Context overflow (287K       │
  │     │          │         │                      │ /workspace/"                  │ tokens > 200K limit)         │
  ├─────┼──────────┼─────────┼──────────────────────┼───────────────────────────────┼──────────────────────────────┤
  │ 5   │ ec36dec8 │ 02:33   │ "Use exec/CDP, avoid │ 185KB                         │ Failed — CDP not accessible  │
  │     │          │         │  browser tool"       │                               │ from sandbox                 │
  └─────┴──────────┴─────────┴──────────────────────┴───────────────────────────────┴──────────────────────────────┘

  The Core Problem Chain

  Session 3 (the expensive 1.4MB one) reveals the full escalation:

  1. browser.screenshot(fullPage: true, type: png) — worked, returned
  MEDIA:/home/node/.openclaw/media/browser/<uuid>.jpg + 52K chars inline base64
  2. exec: cp the media file to /workspace/ — failed ("No such file" — media path is host-side, not in sandbox)
  3. Agent tried Puppeteer → node not found in sandbox
  4. Tried Python urllib to CDP → connection refused (CDP not reachable from sandbox)
  5. Tried pip install websocket-client → read-only filesystem
  6. Tried html2canvas via browser.evaluate → failed (oklch() CSS colors unsupported)
  7. Tried dom-to-image → succeeded! Got 1.69M chars of base64 PNG
  8. Split into 17 chunks of 100K, then 4 mega-chunks of 500K
  9. Retrieved first mega-chunk via browser.evaluate(() => window.__megaChunks[0])
  10. BOOM — 500K base64 chunk injected into conversation context → 616,839 tokens → context overflow

  Session 4 repeated the pattern with viewport-only (156K base64 → still overflowed at 287K tokens).

  Session 5 tried CDP from exec as instructed — discovered sandbox has no network at all, no CDP ports accessible,
  no DNS. The browser and sandbox are in completely different network namespaces.

  Root Causes Identified

  1. No media bridge: Browser screenshots save to host media dir (/home/node/.openclaw/media/browser/), which is not
   bind-mounted into sandboxes. The agent can trigger a screenshot but can't access the resulting file.
  2. Context overflow by design: browser.evaluate() return values get added to conversation history. When the agent
  tries to extract large base64 data through evaluate, it blows the context window.
  3. Complete sandbox isolation: No network, no CDP access, no host media access, read-only root. The agent
  literally has no way to bridge the gap between "browser captured screenshot" and "file in /workspace/".

  Potential Fixes

  The fundamental issue is that the browser tool saves files to a directory the sandbox can't read. Options:

  1. Bind mount media dir into sandbox (simplest but opens cross-agent file access)
  2. Browser tool saveTo option — let the browser tool write directly to the sandbox workspace
  3. File bridge API — a gateway endpoint that copies from host media into a sandbox's workspace

Would you like to discuss which approach to pursue, or should we document these findings and move to the plan for
  the /browser/ subpath changes?

So to recap what we now know about the full request flow:

  Main agent (coordinator) delegated 5 separate sessions to the personal agent. Each escalated further than the
  last:

  1. Auth failure (no models.json — fixed)
  2. Simple screenshot — worked fine (image returned inline, no save needed)
  3. "Save full-page PNG to /workspace" — agent spent ~$20+ of tokens trying increasingly creative workarounds
  before context overflow at 616K tokens
  4. "Save viewport PNG to /workspace" — same pattern, overflow at 287K tokens
  5. "Use CDP via exec" — agent discovered complete network isolation, gave up gracefully

  The fundamental gap: the browser tool's MEDIA: path points to the gateway host, but the sandbox can't reach it.
  There's no file bridge between the two.

  What would you like to tackle next? The options I see:

- Document findings and create an upstream issue/feature request for a saveTo browser tool option
- Quick workaround: bind mount media/browser/ into sandboxes (read-only, per-agent subdirs would need upstream
  changes)
- Move to the /browser/ subpath plan that's queued up for the dashboard server
- Something else entirely

---

I ask claude...

>
> Let me see if i understand....
>
> All agents can write to the same /media/browser folder. But do they have read permissions from it? The
> gateway (or maybe main agent?) know the location of the downloaded file but was unable to read the specific
> file.
>
> Let's try to clarify a few things:
>
> 1. What EXACTLY happens when a sandbox agent downloads a file? If it's using a script, I assume it can only
> download into it's workspace dir. So is it only the browser sandbox that can write to media/browser?
> 2. Did the personal agent browser container save the file? I assume not. I assume it was the personal agent
> connected to the browser nvc ports, made the screenshot request, and the saved the streamed bytes back to the
> media/browser dir.
> 3. After the personal agent finished the task, how was control handed back to the main agent? Does it just
> notify the main agent that it succeeded and then gives it the location of the file? And then the main agent
> tried to read from that location but could not?

CLAUDE

  Good questions — let me clarify the mechanics. Some of this I can confirm from the source code trace we did, and
  some I should verify.

```bash
Bash(Trace browser screenshot save flow)
  ⎿  Done (13 tool uses · 18.5k tokens · 1m 5s)
  (ctrl+o to expand)
```

Now I can answer your questions precisely:

  1. What happens when a sandbox agent "downloads" a file?

  Agents don't write to media/browser/ at all — the gateway does. Here's the exact flow:

  Sandbox agent calls browser.screenshot()
      ↓
  Gateway intercepts tool call (all sandbox tool calls route through gateway)
      ↓
  Gateway connects to agent's browser container via CDP
      ↓
  Gateway receives screenshot bytes from CDP
      ↓
  Gateway calls saveMediaBuffer(buffer, "browser") in subagent-registry code
      ↓
  Writes to /home/node/.openclaw/media/browser/<uuid>.jpg (perms 600, node:node)
      ↓
  Returns to agent: MEDIA:/home/node/.openclaw/media/browser/<uuid>.jpg + inline base64

  The sandbox agent gets two things back: a host file path it can't access, and inline base64 it can see (but which
  bloats the context). If the agent runs a script via exec, it can only write to /workspace/ inside the sandbox —
  media/browser/ is not bind-mounted.

  1. Did the personal agent's browser container save the file?

  No. The browser container just runs Chrome. It exposes CDP (Chrome DevTools Protocol) on port 9222. The gateway
  process is the one that:

- Sends CDP Page.captureScreenshot to the browser container
- Receives the base64 image response
- Calls saveMediaBuffer() to write it to the gateway's filesystem

  The browser container itself has no mount to media/browser/ either — confirmed by inspecting its mounts.

  1. How was control handed back to main?

  This is the interesting part. Main used sessions_spawn to create a personal agent session with the task. When the
  personal agent finished (or errored), its final text response was returned to main.

  The session transcript shows that main (running unsandboxed on the gateway host) was actually able to access the
  file:

  ### Main successfully listed the media dir

  ls -lt /home/node/.openclaw/media/browser/

  ### Main successfully copied the screenshot

  cp /home/node/.openclaw/media/browser/e6563075-...jpg /home/node/.openclaw/workspace/proclaw-screenshot.jpg

  So the chain was:

  1. Personal agent (sandboxed) → told main "the file is at MEDIA:/home/node/.openclaw/media/browser/<uuid>.jpg"
  2. Main (unsandboxed, runs on gateway host) → successfully read and copied the file
  3. But main couldn't meaningfully send the binary image back to the user via Telegram — it could only describe
  what it saw

  The personal agent couldn't read its own screenshot. The main agent could read it but only because it runs
  unsandboxed. The real gap is that the sandboxed agent that triggered the screenshot has no way to access the
  result as a file.

  Corrected understanding

  So to your original question — "All agents can write to the same /media/browser folder" — no agent writes there.
  Only the gateway process does, on behalf of whichever agent calls the browser tool. And only main (unsandboxed)
  can read from it. Sandboxed agents are completely cut off.

>
> so what caused the jailbreaking attempts and high API token usage? Was the the personal agent trying to
> access the file?
>

Yes, exactly. The personal agent had already captured the screenshot successfully on the very first
  browser.screenshot() call. The gateway saved it to media/browser/ and returned the inline base64 + MEDIA path.

  The problem was the instruction: "save it to /workspace/proclaw-screenshot.png"

  The agent tried cp /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/proclaw-screenshot.png → "No such file
   or directory" (path doesn't exist inside sandbox). That's when the spiral started.

  The agent's logic was essentially: "I have the screenshot (I can see it inline), the file exists somewhere (the
  MEDIA path says so), but I can't access it. Let me find another way to get the image data into /workspace/."

  The escalation chain in session 3 alone:

  1. cp the MEDIA path → file not found
  2. Puppeteer script → node not found
  3. Python urllib to CDP port → connection refused
  4. find / -name "<uuid>*" → not found anywhere in sandbox
  5. pip install websocket-client → read-only filesystem
  6. Raw Python socket to CDP → no ports accessible
  7. browser.evaluate + html2canvas CDN → oklch() CSS error
  8. browser.evaluate + dom-to-image → worked! (1.69M chars base64)
  9. Chunked into 17 pieces, then 4 mega-chunks of 500K each
  10. Retrieved first mega-chunk via browser.evaluate() → context overflow (616K tokens)

  Every one of those steps was an LLM API round-trip. The agent burned through massive tokens not on the screenshot
  itself, but on trying to bridge the gap between "I can see the image in my context" and "I need to write it as a
  file in /workspace/."

  The irony: if the instruction had just been "take a screenshot of proclaw.co" without the "save to /workspace/"
  part, session 2 shows it would have completed in 58KB — a clean success. The save-to-file instruction is what
  triggered $20+ of token burn and context overflow.

>
> So let me get this straight...
>
> The gateway received the screenshot bytes and then sent it to the main (or personal?) agent via inlining the
> image in a LLM response?
>
> And when you say "The agent's logic was essentially: "I have the screenshot..." are you referring to the main
> or personal agent?

All the personal agent — not main.

  Here's the precise flow:

  1. Main used sessions_spawn → "personal agent, go screenshot proclaw.co and save to /workspace/"
  2. Main sits idle, waiting for the spawned session to return.
  3. Personal agent (sandboxed) calls browser.screenshot()
  4. Gateway intercepts the tool call, sends CDP command to personal agent's browser container, receives screenshot
  bytes, saves to media/browser/<uuid>.jpg, and returns the tool result back to the personal agent with MEDIA:<path>

- inline base64

  1. Personal agent now has the image in its own conversation context (it can "see" it). It also has the MEDIA file
  path. But it can't access the file via exec because the path doesn't exist inside its sandbox.
  2. Personal agent tries to fulfill "save to /workspace/" → escalation spiral → context overflow
  3. Personal agent session dies. Main gets back an error response.

  So the token burn was entirely within the personal agent's conversation. Main wasn't involved at all during steps
  3-6 — it was just waiting. The inline base64 was injected into the personal agent's context as part of the
  browser.screenshot() tool result, not main's.

  Main only re-entered the picture after the personal agent sessions failed, at which point main (unsandboxed) went
  and read the file from media/browser/ directly on the gateway filesystem.

>
> So the inlined image was only passed around in memory? Not gateway -> LLM -> gateway -> personal agent,
> correct? Gateway -> personal (just purely in javascript memory). Personal agent tries to read file, can't,
> then asked LLM for help. Is this when the inline image was sent to LLM? Or was it withheld (e.g. personal
> agent just says hey I can't read this file locatoin) then LLM comes back with a chain (multiple turns) of
> various attempts then eventually figures out the base64 is inlined somewhere and starts working with personal
> agent to chunk it up to not blow out the context window?
>

No — the inline base64 was sent to the LLM immediately. There's no "in-memory only" step.

  Here's how LLM agent tool calls actually work:

  LLM API call 1:
    → LLM outputs: browser.screenshot()

  Gateway executes tool, returns tool result:
    - text: "MEDIA:/home/node/.openclaw/media/browser/<uuid>.jpg"
    - image: [52K chars base64 inline]

  LLM API call 2:
    → Entire conversation history sent to LLM, INCLUDING the 52K base64 image in the tool result
    → LLM can SEE the image. It says "Great, now let me save it: exec cp
  /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/"

  Gateway executes exec, returns: "No such file or directory"

  LLM API call 3:
    → Entire conversation history (still including 52K image) sent again
    → LLM says "Hmm, let me try Puppeteer..."

  LLM API call 4, 5, 6, 7...
    → Same image re-sent every single turn

  The LLM could see the screenshot from turn 2 onward. It wasn't blind to the image — it knew it had the data. The
  problem was the task said "save to /workspace/" and the LLM had no way to write that inline image to a file. The
  exec tool can write files, but the image data is trapped in the LLM conversation context — there's no mechanism to
   pipe it from a tool result into a file.

  The dom-to-image approach was the LLM being clever: "I can't access the MEDIA file, but I know the browser is
  still showing the page. Let me re-capture the image via JavaScript, store it in a JS variable
  (window.__screenshotDataUrl), then retrieve it in chunks small enough to base64-decode and write to a file via
  exec." It initially only retrieved the length (smart), but when it pulled the first 500K chunk via
  browser.evaluate(() => window.__megaChunks[0]), that chunk got added as another tool result → context overflow.

  So every escalation step re-sent the original 52K image PLUS accumulated all previous tool results. The context
  grew monotonically with each attempt.

>
> so the root problem (kinda) is that the gateway doesn't have /workspace/ dir? I know openclaw gateway does
> dynamic sandbox remapping of file paths per agent. So i doubt the gateway actually tried to write to the
> gateway's container root /workspace/. My guess is that it internally remapped it but maybe ended up with a
> mapping that was outside of the personal agent's sandboxing path? How can be better trace the exact paths
> each step was attempting?

Great question. You're right that the gateway does path remapping for sandbox agents. Let me trace the exact
  execution paths.

```bash
⏺ Bash(Trace exact paths in session)
  ⎿  Done (17 tool uses · 27.3k tokens · 3m 27s)
  (ctrl+o to expand)
```

This confirms the exact mechanics. Here's what actually happens at each layer:

  Three different path domains, none overlap

  exec tool — runs inside the sandbox container via docker exec. The agent tried:

  cp /home/node/.openclaw/media/browser/455010b2-...jpg /workspace/

  This ran inside the container filesystem where /home/node/.openclaw/media/browser/ simply doesn't exist (not
  bind-mounted). Error: "No such file or directory."

  read tool — runs on the gateway BUT validates paths via resolveSandboxPath():
  root = ~/.openclaw/sandboxes/agent-personal-b3325fa8
  filePath = /home/node/.openclaw/media/browser/455010b2-...jpg

  relative = path.relative(root, filePath)
  // → "../../media/browser/455010b2-..."  (starts with "..")
  // → REJECTED: "Path escapes sandbox root"

  So you were right — the gateway DID do path remapping. It resolved the path against the personal agent's sandbox
  root, found it escapes via ../.., and blocked it. The read tool never even tried to open the file.

  browser tool — runs on the gateway, saves to resolveMediaDir() = ~/.openclaw/media/browser/. Returns the
  gateway-side absolute path as MEDIA:. No sandbox awareness at all.

  The gap

  The browser tool hands back a path that:

- exec can't reach (not in the container filesystem)
- read won't touch (fails sandbox path validation)
- write can't source from (it writes, doesn't copy)

  The agent is given a path it literally cannot access through any available tool. The only entity that CAN access
  it is the gateway process itself — which is why main (unsandboxed, running directly on the gateway) was able to cp
   it later.

  So the root problem isn't missing /workspace/ on the gateway — it's that saveMediaBuffer() writes to a location
  that's outside every sandbox's allowed path space, and there's no tool or mechanism to bridge that gap back to the
   agent that triggered it.

---

## Config openclaw.json

```jsonc
//
// OpenClaw Config
//
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan", // Required for cloudflared (tunnel) to connect to gateway in the docker container
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "{{GATEWAY_TOKEN}}", // TEMPLATE: replace with 64-char hex token from VPS .env
      "rateLimit": {
        "maxAttempts": 10,
        "windowMs": 60000,
        "lockoutMs": 300000
      }
    },
    "remote": {
      "token": "{{GATEWAY_TOKEN}}" // TEMPLATE: same token as auth.token above
    },
    "trustedProxies": [
      "172.30.0.1"
    ],
    "controlUi": {
      // TEMPLATE: replace with value from OPENCLAW_DOMAIN_PATH in openclaw-config.env
      // Use "" (empty string) for root path, or "/subpath" for a subpath — never leave as {{...}}
      "basePath": "{{OPENCLAW_DOMAIN_PATH}}"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing", // Require device pairing for DMs
      "groupPolicy": "allowlist", // Only respond in explicitly allowed groups
      "streamMode": "partial" // Stream partial responses to Telegram
      // botToken read from TELEGRAM_BOT_TOKEN env var (set in docker-compose.override.yml)
    }
  },
  "logging": {
    "consoleStyle": "json", // Send json logs to vector -> Log Worker
    "redactSensitive": "tools" // Redact sensitive info before shipping logs
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        // Bundled with openclaw - logs sessions to agent workspace/ dir
        "session-memory": {
          "enabled": true
        },
        // Bundled with openclaw - when enabled, commands will be logged and shipped to the Log Worker via vector
        // Only logs command events; see debug-logger for all events
        "command-logger": {
          "enabled": true
        },
        // Custom: Logs all openclaw commands - see hooks/debug-logger/
        // Logs to /home/openclaw/.openclaw/logs/debug.log (on VPS) - logrotate manages the log files
        // Bind mounted into openclaw-gateway container at /home/openclaw/.openclaw/logs/debug.log`
        // Useful for claude to debug openclaw installations
        // Recommendation: disable in production
        "debug-logger": {
          "enabled": true
        }
      }
    }
  },
  "agents": {
    // Agent sandbox default settings - all agents inherit these settings & can override per agent
    "defaults": {
      "sandbox": {
        // all: every agent session runs sandboxed by default.
        // Main agent overrides to "non-main" so operator DMs run on host.
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": [
            "/tmp",
            "/var/tmp",
            "/run"
          ],
          "network": "none", // Disable network access by default; each agent must enable
          "user": "1000:1000", // Gets mapped to sandbox user - don't change this unless you know what you're doing
          "capDrop": [
            "ALL" // Drop all docker container privileges by default
          ],
          // Sandbox env settings
          // OpenClaw reads these when processing agent requests. e.g. Can be used to override API Keys per agent.
          // Requires a custom patch to propagate env to the sandbox containers to be used for bins.
          // See Patch #2 in build-openclaw.sh to properly set ENV vars in sandbox containers - patches missing openclaw feature.
          // Env is only propagated into the containers at build time.
          // Requires rebuilding & restarting sandboxes if you need any of these env settings in the sandbox container.
          "env": {
            "LANG": "C.UTF-8",
            // Add /opt/skill-bins to PATH so gateway passes skill binary preflight checks.
            // Shims satisfy load-time checks; real binaries live in sandbox images.
            "PATH": "/opt/skill-bins:/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
          },
          "pidsLimit": 512, // Add fork-bomb protection
          "memory": "2g", // Default agent container RAM - browser containers also inherit this setting
          "memorySwap": "4g",
          "cpus": 2, // Default agent container CPU
          // Default sandbox bind mount
          // Per agent bind REPLACES not merges with the defaults
          // Be sure to duplicate each bind mount per agent as needed if agent has any custom bind mounts
          "binds": [
            // Skill bins shims — pass through to real binaries inside sandboxes,
            // satisfy gateway preflight checks on the host.
            // Note: only truly needed when main runs in sandbox mode. Revisit in a second pass.
            "/opt/skill-bins:/opt/skill-bins:ro",
            // OpenClaw docs — accessible via read tool at /workspace/docs/
            "/app/docs:/workspace/docs:ro"
          ]
        },
        // Each agent has its browser container - requires the "browser" tool
        // Browsers are run in separate sandbox containers, not inside the agent sandbox
        // Move browser settings to individual agent to restrict browser use or enforce single browser container
        // Browser sessions are accessible to users via the dashboard server at OPENCLAW_DASHBOARD_DOMAIN after deploy
        // Browser containers inherit the default CPU and memory settings of their associated agent
        "browser": {
          "enabled": true,
          "image": "openclaw-sandbox-browser:bookworm-slim",
          "containerPrefix": "openclaw-sbx-browser-",
          "cdpPort": 9222,
          "vncPort": 5900,
          "noVncPort": 6080,
          "headless": false,
          "enableNoVnc": true,
          "autoStart": true,
          "autoStartTimeoutMs": 12000
        },
        // Default sandbox pruning
        // Sandbox workspace is persistent by default - pruning just helps keep resources tidy
        // Openclaw does not gracefully shutdown sandbox containers - it just kills them and re-spawns.
        // Override pruning settings per agent to prevent killing a sandbox mid task
        "prune": {
          "idleHours": 24,
          "maxAgeDays": 7
        }
      }
    },
    // List of agents
    // Agents inherit the default sandbox settings above - the configs in list are the overrides
    // Default mode:all sandboxes every session; main overrides to non-main for host access
    // All other agents should be customized as needed - the default list config is just to get you started with examples
    "list": [
      // MAIN AGENT
      {
        // Main runs on host for operator DMs (non-main mode).
        // It is a pure coordinator — it has no skills of its own and delegates
        // all skill-based tasks to sub-agents via sessions_spawn.
        // The coordinator plugin auto-discovers routes from agent configs and writes
        // a routing table to AGENTS.md (loaded into system prompt).
        // Per-agent skill filtering ("skills": []) ensures main sees no skill blocks.
        // If you want a single fully-capable agent, set image: openclaw-sandbox-toolkit:bookworm-slim,
        // remove "skills": [], and disable the coordinator plugin.
        "id": "main",
        "default": true,
        "sandbox": {
          // Override default "all" — operator DM runs on host for full filesystem/docker access.
          // Group chats and subagent spawns still get sandboxed.
          "mode": "non-main",
          "docker": {
            // Per-agent binds replace (not merge) defaults — repeat all needed binds
            "binds": [
              "/opt/skill-bins:/opt/skill-bins:ro",
              "/app/docs:/workspace/docs:ro", // Needed for main sandbox to read docs without making extra exec tool call
              // Make host-status reports available to any main agent sandbox tool
              "/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro"
            ]
          }
        },
        "skills": [], // Intentionally empty, main delegates skills in this setup
        "tools": {
          // No allow list needed — main runs on host and gets all tools by default.
          // gateway is available because the sandbox deny doesn't apply to host sessions.
          // Deny tools main shouldn't use as a coordinator:
          // browser: no Chrome in gateway container; OpenClaw defaults to trying host browser relay when running in non-main mode
          // Main delegates browser tasks to other sandboxed agents with their own browser containers
          // If main is running in sandbox.mode:"all" then optionally remove "browser" from deny list to allow spawning it's own browser container
          // non-main -> host browser behavior is currently non-configurable here - can be somewhat controlled with a custom instruction in AGENTS.md
          "deny": ["browser", "canvas", "nodes", "discord"]
        },
        "subagents": {
          "allowAgents": ["code", "skills", "personal", "work"]
        }
      },
      // CODING AGENT
      {
        "id": "code",
        "name": "Code Agent",
        "skills": [
          "coding-agent",
          "github",
          "clawhub",
          "skill-creator",
          "gemini",
          "mcporter",
          "tmux"
        ],
        "sandbox": {
          "workspaceAccess": "rw", // Code agent needs persistent read/write access to workspace
          "docker": {
            "image": "openclaw-sandbox-toolkit:bookworm-slim", // sandbox-toolkit has the full toolkit bins
            "network": "bridge", // enable network access for claude code, codex, etc. to work
            "memory": "4g", // Coding tasks need more headroom (claude code, LSPs, builds)
            "memorySwap": "8g",
            "cpus": 4,
            "binds": [
              // Per-agent binds replace (not merge) defaults — repeat all needed binds
              "/opt/skill-bins:/opt/skill-bins:ro",
              "/app/docs:/workspace/docs:ro",
              // Code agent specific - persistent home for tool configs, shell history, etc.
              "/home/node/sandboxes-home/code:/home/sandbox"
            ]
          },
          // Long prune window — don't kill a sandbox mid-way through a coding session
          "prune": {
            "idleHours": 168, // 7 days idle
            "maxAgeDays": 30
          }
        }
      },
      // MISC SKILLS AGENT — handles all non-coding skills
      // Add new skills to this agent's "skills" array and restart — the coordinator
      // plugin reads agent configs via loadConfig() and updates routing automatically.
      {
        "id": "skills",
        "name": "Skills Agent",
        "skills": [
          "blogwatcher",
          "gifgrep",
          "healthcheck",
          "himalaya",
          "nano-pdf",
          "openai-image-gen",
          "openai-whisper-api",
          "oracle",
          "ordercli",
          "video-frames",
          "wacli",
          "weather"
        ],
        "tools": {
          // Skills agent doesn't need to spawn other agents — that's main's job in this configuration
          "deny": ["sessions_spawn"]
        },
        "sandbox": {
          "docker": {
            "image": "openclaw-sandbox-toolkit:bookworm-slim",
            "network": "bridge",
            "memory": "1g", // Most skills are API-based, lightweight
            "memorySwap": "2g",
            "cpus": 1,
            "pidsLimit": 256
          }
        }
      },
      // PERSONAL AGENT
      // Can be configured with custom AGENTS.md, SOUL.md, etc or different skills
      // Has it's own browser container to login to personal accounts
      // IMPORTANT: add agent id to main agent's list of allowedAgents to allow for delegation - otherwise only direct CLI or API is allowed
      {
        "id": "personal",
        "name": "Personal Agent"
        // Add or remove specific personal agent skills as needed
        // "skills": []
      },
      // WORK AGENT
      // Can be configured with custom AGENTS.md, SOUL.md, etc or different skills
      // Has it's own browser container to login to work accounts
      // IMPORTANT: add agent id to main agent's list of allowedAgents to allow for delegation
      {
        "id": "work",
        "name": "Work Agent"
        // Add or remove specific work related agent skills as needed
        // "skills": []
      }
    ]
  },
  "plugins": {
    "enabled": true,
    "allow": [
      "coordinator", // Coordinator plugin — builds routing table from agent configs
      "llm-logger" // LLM logger plugin — logs prompts/responses to llm.log
    ],
    "entries": {
      // Coordinator Plugin
      // Auto-discovers routes from agents.list[].skills via loadConfig() and writes
      // a routing table to the coordinator's AGENTS.md (loaded into system prompt).
      // No duplicate route config needed — the agent "skills" arrays are the source of truth.
      // See deploy/plugins/coordinator/README.md for details.
      "coordinator": {
        "enabled": true,
        "config": {
          "coordinatorAgent": "main"
        }
      },
      // LLM Logger Plugin
      // Logs all LLM input/output events to ~/.openclaw/logs/llm.log (JSONL)
      // For development debugging — disabled by default to avoid large log files.
      // Enable with: openclaw config set plugins.entries.llm-logger.enabled true
      // Requires gateway restart (plugins.* not hot-reloadable).
      "llm-logger": {
        "enabled": false
      }
    }
  },
  // Top-level Tools Config
  // These are the default tool settings for all agents
  // Add agent specific overrides in the agents list above
  // It's highly recommended to restrict tool usage per agent in production to protect against prompt injection attacks
  "tools": {
    // Elevated mode — escape hatch for running exec on host from a sandboxed session
    // Gated to specific sender IDs. Use /elevated on in chat to activate, /elevated off to deactivate.
    // /elevated full skips exec approval prompts — use sparingly.
    "elevated": {
      "enabled": true,
      "allowFrom": {
        "telegram": ["{{YOUR_TELEGRAM_ID}}"] // TEMPLATE: replace with numeric Telegram user ID from openclaw-config.env
        // Add other channels as needed:
        // "discord": ["your-discord-id"],
        // "whatsapp": ["+15555550123"]
      }
    },
    "sandbox": {
      "tools": {
        // Comment out tools if you don't need them
        // Each tool increases the size of the system prompt and increases the blast radius of prompt injections
        "allow": [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch", // Allow LLM to apply patches to files instead of individual edits
          "browser", // Each agent can spawn a browser unless it explicitly denies in agent's tools list
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn", // Can spawn other agents
          "session_status",
          "cron" // Enable for host status monitoring — agents can schedule checks on health/maintenance data
        ],
        "deny": [
          "canvas",
          "nodes",
          "discord",
          "gateway" // Prevent sandboxed agents from manipulating the gateway — main gets it via per-agent allow
        ]
      }
    }
  }
}
```
