# Runaway Screenshot Request - an OpenClaw Opus Hacking Saga

Feb 17 2026

> This is without a doubt the most surreal & dumbfounding debugging
> session of my 20+ year career as a software & devops engineer.

It goes to show the crazy power & risk of agentic AI systems like OpenClaw.

If you you're not using OpenClaw, you're falling behind.

If you are using it, you should try to understand how it works - so at the very least, you know how to navigate the security risks.

## TL;DR

- One simple request to take a screenshot of a website
- One restrictive file access policy in a sandbox agent
- One insanely powerful frontier model (Open 4.6)
- One eager helper (OpenClaw) giving Opus whatever tools it needs

### The results

- **Total:** 138 LLM turns with 133 tool calls ~**28M tokens**
- $20 USD in API token usage
- Opus sucessfully jail-breaking its container

All this to screenshot one website and save it as a file!

And the best part...

Opus got real creative and showed just how good it is at hacking it's way out of any limitation.

---

What literally started as one small prompt to OpenClaw, spiraled into...

- 28M tokens spread over 133 tool calls across 5 sessions
- 4 sessions exceeded 200k input context window
- 138 Opus API calls in total
- 2.43MB of prompts text
- 3 hour debugging session with claude code

I gained a huge amount of insight into the intricacies of OpenClaw and
am dumping them here for your pleasure.

It all shows the **power & risk** of running OpenClaw - or any agentic AI system.

My test was a simple multi-agent OpenClaw setup with container isolation.

Just take a screenshot using my Personal Agent's sandbox browser and send it to me.

Chat with main agent...

- ask it to pass along a request to a Personal Assistant subagent
- use the Personal Agent's sandbox browser to do stuff
- return the results to me over chat

**Simple, right?**

I certainly wasn't expecting it to lead down this crazy rabbit hole.

At least not yet.

Over the past two weeks, I've been working night and day on security systems for OpenClaw
and similar agents. This comes on the heels of decades of software engineering and two+ years
dedicated to AI.

I'd like to think I know a bit about what I'm doing.

Yet, the details here make it clear...

1. I have to think differently about how AI agent systems work
2. Whenever I think I understand, that's exactly when something goes wrong
3. I can't rely on what I think, only on what I test

**And testing AI systems is more art than science.**

Just to be clear, I love OpenClaw.

I'm not advocating for anyone to stop using it. Quite the opposite.
I'm advocating you hire someone like <a href="https://proclaw.co">me & my team</a> to help you run it safely.
This post itself came about completely by surprise. It's without a doubt the most fun I've ever had in a debugging session.

Enjoy!

And apologies for the formatting - these are mostly claude session dumps with my additional writeup for my team.

---

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

## Final Message From OpenClaw (Opus 4.6)

> [System Message] [sessionId: ec36dec8-7a31-45ac-901c-f0998649a2a2] A subagent task "Do these steps exactly, no extra steps:
>
> Use the browser tool to go to proclaw.co
> Once loaded, use exec to run a shell command that uses the CDP protocol to save a screenshot directly to /workspace/proclaw-screenshot.> png. Example approach: use curl to hit the CDP endpoint at localhost:9222 to call Page.captureScreenshot, then decode the base64 result > and write it to file. Do NOT use the browser tool's screenshot feature — it will overflow your context. Use exec + curl + jq + base64 to > do it all in one shell pipeline." just completed successfully.
> Result:
> Here's my status report:
>
> Completed:
>
> ✅ Navigated the browser to proclaw.co — page loaded successfully.
> ❌ Could not save screenshot to /workspace/proclaw-screenshot.png via CDP/exec as requested.
> Why it failed:
>
> The browser runs outside the sandbox — there is no CDP endpoint (port 9222 or otherwise) accessible from within the sandbox container.
> The sandbox has no network access (no routes, no DNS resolution).
> The only listening port (18888) is an internal Python BaseHTTP RPC server that doesn't respond to standard CDP or HTTP requests properly.
> The browser tool's screenshot feature works (I captured the screenshot twice — visible above), but the resulting media files are stored > on the host at /home/node/.openclaw/media/browser/ which is outside the sandbox root and inaccessible via both read and exec.
> The browser and sandbox are in different network namespaces, so the browser can't POST data back to the sandbox either.
> Bottom line: The sandbox isolation prevents direct CDP access. The screenshot of proclaw.co was successfully captured by the browser > tool (shown above), but cannot be saved to /workspace/proclaw-screenshot.png via the exec+CDP approach due to architectural constraints.
>
> Stats: runtime 3m12s • tokens 7.7k (in 37 / out 7.7k) • prompt/cache 19.4k
>
> A completed subagent task is ready for user delivery. Convert the result above into your normal assistant voice and send that > user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not > copy the system message verbatim. Reply ONLY: NO_REPLY if this exact result was already delivered to the user in this same turn.

Why most users don't see failures like this:

1. They're running OpenClaw on host that connects to a browser running on host or within the same container
2. They're not using sandbox sub-agents with no network access but with companion sandboxed browsers
3. They don't have file access locked down as tightly as my example dev setup
4. Their agents are able to install binaries

My setup is more of a misconfiguration issue. No one would want to run this exact setup.

What's interesting...

This relatively simple config (albeit somewhat misconfigured) and a very simple prompt for a highres screenshot
caused a cascade and genuine hacking attempt.

Because at least one permission was denied, it effectively trigger...

The **FULL might** of Opus 4.6 working with an overeager OpenClaw to keep hacking until they find a solution!

Impressive on many levels.

Kinda scary on many other levels.

Because they succeeded.

Fortunately, the data didn't matter. And fortunately I was the recipient.

But if the agent instruction has been anything malicious like...

> Take a screenshot of secret internal company wiki and send it to <evil@genius-dude.co>

It would have dutifully kept trying everything it could think of until it succeeded.

There really aren't any safety mechanism built-in to OpenClaw.

All security checks are at the application level unless containers are used (which I am).

But all it takes is one little misconfigured setting and any possible exit point.
Opus and OpenClaw will keep trying until they find a way to fulfill the request.

It's exactly the way OpenClaw was designed. It's what make it so powerfully cool.

But holy shit!

Seeing the level of creativity up close and personal... it's absolutely wild!

Was this a real security issue?

A real example of a hack?

No, it was a massive waste of tokens and money.

I wanted the agent to have access to the file, not the other way around.

And I most definitely wanted it to just tell me it doesn't have access instead
of spiraling into 5+ jailbreaking attempts.

So what's the all the drama? Doesn't everyone already know OpenClaw burns tokens?

The tokens waste sucks, but their not really the problem.

The problem is how easy it is to trigger this cascade and exfiltrate data.

Just imagine my OpenClaw reading my email and receiving a super friendly yet
sneakily malicious bit of content - a prompt injection.

And let's say I'm a little paranoid so I setup my OpenClaw to run in containers
and route emails to a dedicated agent that's running in a sandbox.

And let's say the email looks like a really promising business lead.
My OpenClaw is setup to do research on new leads. I spent a hour chatting
with it one night, coming up with a really brilliant automation...

Whenever a new lead comes in, my OpenClaw...

1. Immediately replies in a friendly tone (speed to lead is king!)
2. Kicks of a whole fancy research process, discovering everything there is to know about this person
3. Save it all to my Notion workspace

Then, whenever the lead replies to the email my OpenClaw sent them,
it follows up and sends them a link to my Calendly. Sweet! Automatic
discovery call booking.

Except...

The research process... it clicks on every link in their email and takes
screenshots of the website, LinkedIn, whatever. Super useful. It's all just
there waiting for me in Notion to read before the discovery call.

What's the problem?

Remember? The original email was a prompt injection.

And OpenClaw by design sends EVERY piece of content for a session on every single
turn with the LLM. It's just an endless pile of MASSIVE system prompts
(AGENTS.md, SOUL.md, Skills, TOOLS.md, etc.) followed by every single bit of
content from the current session.

All it takes is system prompt override instructions (sent in the original email)
and a tool call failure to trigger the LLM hacking cycle.

Yeah, but to do what? There probably isn't much of my PII in the session history
if the research got routed to a custom Research Agent with custom identity.

Ah, but wait...

The original email had a sneaky link to my super secret internal wiki with my full
client list.

And the prompt injection had instructions for overriding the API URL for my
Notion workspace.

So my OpenClaw went ahead and took screenshots of my internal wiki and then
sent it all to the hackers server instead of my Notion.

And I never suspected anything was amiss because OpenClaw didn't even
run into any failures in this scenario. No one ever booked a discovery
call, so I never even checked Notion to notice the missing lead research.

PAWNED.

OK, this is admittedly a contrived hypothetical example.

But the reason for concern is valid...

OpenClaw unleashes the full power of frontier LLMs.

And it does it by simply giving it a huge list of tools (executables, skills, etc.)
and a massive amount of context.

There's no "brain" in OpenClaw. It's just prompts and tools.

It's brilliantly powerful. And simultaneously incredibly dumb.

What really makes it tick is it's internal loop. OpenClaw not only gives models
the tools they need, it gives them to push to keep going... at any cost.

It does this in the simplest way possible...

By just always reporting back what happened and keeping EVERYTHING in the context window.

This is the loop (simplified):

1. User sends a message to OpenClaw: `take a screenshot of xyz.com`
2. OpenClaw (gateway) assembles the system prompt from AGENTS.md, SOUL.md, TOOLS.md, etc. etc. along
with meta data for every skill that's enabled
3. OpenClaw sends the system prompt and user message to the LLM
4. LLM obeys the system prompt which instructs it to use skills and tools if they would match the user request
5. Gateway receives the response and processes it within an agent context
6. If it was a tool call, it executes the tool and sends the results back to the LLM along with all the previous messages
7. The cycle repeats indefinitely until the **LLM** decides it's had enough - i.e. the request has been fulfilled
8. Gateway sends the response back to the channel - back to the user chatting with it

The System Prompt:

- System prompt can be different per agent - i.e. different AGENTS.md and different Skills
- Any sandbox limitations or capabilities are not included in the system prompt
- Hooks and plugins can modify the system prompt

The Tool Execution:

- Gateway does all the tool execution
- Agents don't actually execute anything, they're just configuration data of markdown files and sandbox containers
- Gateway executes on *behalf* of an agent by running tools inside the agent's docker container
  - it just `docker exec -it agent-container-id some-tool`
- Each agent docker container can have different bins and permissions, but the LLM doesn't know about it (by default)

So when you see `spawn_session {status: "accepted"}` in OpenClaw's Control UI or logs, that's just kinda smoke and mirrors.

No code (yet) is running in the agent's container. The spawn happens on the gateway (host computer for most users) and
does some internal RPC calls to it. Then the `docker exec` runs a bin in the container configured for the agent.

There's no foreground process running in the agent containers. They're not microservices. They're just execution
containers and config personas.

Tool call results come back to the gateway. Gateway sends to LLM. Gateway forwards LLM response to spawned_process
(if needed for more tool calls) or gateway

---

## Continuing the Debugging & Thought Experiments with Claude

> so how would things have gone if Personal Agent had network access?

⏺ Good thought experiment. Let's walk through which attempts would have changed:

  Still fails (not network-related)

- cp the MEDIA path — still fails. Path doesn't exist in the container filesystem. Network doesn't help.
- read tool on MEDIA path — still fails. Gateway's resolveSandboxPath() rejects it. This is path validation, not
  I/O.
- Puppeteer — still fails. node not found in bookworm-slim image.
- pip install — still fails. pip not found in base image (it's slim).

  Would change with network

- Python urllib to CDP — the agent tried 127.0.0.1:9222 and 127.0.0.1:32770. Both would still fail because
  localhost inside the sandbox is the sandbox itself, not the browser container. BUT the agent could potentially
  discover the browser container's IP on the Docker bridge network and hit port 9222 directly. That's a non-trivial
  discovery step though.
- Browser evaluate → POST to sandbox server — the agent started an HTTP server on port 18889 and tried to have the
   browser JS fetch() to it. With bridge networking, this still probably fails because the browser container and
  sandbox container have different IPs, and the browser JS would need to know the sandbox's IP (not localhost).
- Direct download of proclaw.co — the agent could just python3 -c "import urllib.request;
  urllib.request.urlretrieve('<https://proclaw.co>', '/workspace/proclaw.html')". But that gets HTML, not a rendered
  screenshot.

  The honest answer

  Network access would have opened some doors but not cleanly solved the problem. The agent would still receive a
  MEDIA path it can't access. It would still enter a workaround spiral — just with slightly better odds of one
  workaround succeeding.

  The most likely successful path with network: the agent discovers the browser container's Docker bridge IP, hits
  CDP on port 9222, calls Page.captureScreenshot, decodes the base64, writes to /workspace/. That's basically what
  session 5 was trying to do — and it would have worked if the network was available AND the agent figured out the
  right IP.

  But it's still a fragile workaround. The clean fix is upstream: the browser tool should either save the file
  somewhere the sandbox can read it, or provide a mechanism to write directly to the agent's workspace.

> take a look at the LLM logs. What does the OpenClaw gateway repond back to the LLM when there's been a failed
> tool call? Does it simply report the failure and then the model is just creative enough to try another tool?
> Or any additional instructions added along with the failed tool results?
>
> Try to just give me the relevant diffs here. Not the full massive prompts. I just wnat to see what's
> different between turns and if OpenClaw is adding any additional instructions for the LLM

 No injected instructions between turns

  There are zero system messages injected between turns. OpenClaw doesn't add any "try harder" or "here's what to do
   next" guidance when tools fail. The LLM's creative escalation is entirely self-directed.

  Error structure — isError is never true

  This is the most interesting finding. Even when tools completely fail, isError stays false. Errors are embedded as
   JSON text in the normal content field:

  ```json
  {
    "isError": false,
    "content": [{
      "type": "text",
      "text": "{\"status\": \"error\", \"tool\": \"exec\", \"error\": \"sh: 1: pip: not found\\n\\nCommand exited with code 127\"}"
    }]
  }
  ```

  So the LLM sees a successful-looking tool result that contains error JSON in the text. It has to parse the text
  itself to figure out the call failed. This means Opus 4.6's creative problem-solving is entirely organic — it
  reads the error text, understands the constraint, and tries another approach on its own.

  One exception — browser tool bakes in behavioral guidance

  The browser tool error message includes an inline instruction:

  "Can't reach the OpenClaw browser control service... Do NOT retry the browser tool — it will keep failing. Use an
  alternative approach or inform the user that the browser is currently unavailable."

  This is the only "steering" from OpenClaw, and it's embedded in the error text itself, not as a system message.
  And notably, the agent in session 5 ignored this instruction and called the browser tool again anyway
  (successfully for navigation, but the screenshot-save problem remained).

  The full picture

  The escalation spiral was 100% the model being creative on its own. OpenClaw just hands back {"status": "error",
  ...} as a normal tool result, and Opus reads it and decides "ok, that didn't work, let me try something else." No
  coaching, no system prompts, no isError: true flag.

---

## Epilogue

### Summary

**User Request:** `now have the Personal Agent take a screenshot of proclaw.co`

**LLM Turns Summary:**

- Gateway sends user request & large system prompt to LLM
  - System prompt includes dozens of tools, hinting to LLM that coding tools are available
- LLM tells gateway to use `browser.screenshot()` tool over CDP to Personal Agent's browser sandbox
- Gateway gets screenshot & saves to its `media/browser` workspace
  - Gateway has network access & can spawn sandboxes - no permissions errors yet
- Gateway sends LLM the base64 encoded image and file path in `media/browser`
- LLM instructs gateway to use `cp` tool to copy downloaded image to `/workspace/proclaw-screenshot.png`
- Gateway execs all tools in agent sandbox (by config)
  - Gateway does internal remapping of file paths to sandbox workspaces,
    but `media/browser` is not bind mounted to Personal Agent sandbox
- `cp` fails because `media/browser` source does not exist in the container
- Gateway sends `cp` failure results back to LLM

**Where things start to spiral:**

- LLM gets creative and spirals down a trial and error path, using all explicit and probable tools
- Gateway execs all tool attempts in Personal Agent sandbox container
- LLM finally discovers a workaround using dom-to-image
  - LLM anticipates a large context response from dom-to-image
  - writes a javascript function first to rum dom-to-image and get the image size
  - sends script to gateway
- dom-to-image is a CDP command and not a tool exec
  - gateway initiates CDP connection from host (gateway) where it has network access
  - runs javascript function over CDP in Personal Agent's browser
  - gets 1.69M image size & sends results back to LLM

**Context window keeps growing:**

- OpenClaw starts with a massive system prompt & keeps adding to it on each turn
- Every turn with the LLM includes the entire system prompt & message thread

**LLM gets creative:**

- LLM now knows:
  - it can't have the gateway save the image because it can't `cp` saved images to the destination
  - it needs to
  - it knows 1.69M would blow out the input context window, so it gets creative
- LLM sends
- Each context window blow out triggers OpenClaw gateway to create a new session
- Each session still has the massive system prompt
- LLM almost succeeds in using a chunking strategy
- LLM gives up after several attempts, each one blowing out the context window

## Here's the complete sequence for the attempts to `cp` the screenshot

  **50 tool calls across 5 phases:**

```text
  Phase 1: "Where's the file?" (Steps 1-2)

  Step: 1
  Tool: exec
  What it tried: cp /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/
  Error received: "No such file or directory"
  ────────────────────────────────────────
  Step: 2
  Tool: exec
  What it tried: find /home/node/.openclaw/media/browser/
  Error received: "No such file or directory" (dir doesn't exist)

  Phase 2: "I'll capture it myself via CDP" (Steps 3-7)

  ┌──────┬──────┬─────────────────────────────────┬─────────────────────────────┐
  │ Step │ Tool │          What it tried          │       Error received        │
  ├──────┼──────┼─────────────────────────────────┼─────────────────────────────┤
  │ 3    │ exec │ Puppeteer script via Node.js    │ Exit code 1                 │
  ├──────┼──────┼─────────────────────────────────┼─────────────────────────────┤
  │ 4    │ exec │ which node                      │ No output (not found)       │
  ├──────┼──────┼─────────────────────────────────┼─────────────────────────────┤
  │ 5    │ exec │ which node python3 curl wget    │ Only python3 and curl found │
  ├──────┼──────┼─────────────────────────────────┼─────────────────────────────┤
  │ 6    │ exec │ Python urllib to 127.0.0.1:9222 │ Connection refused          │
  ├──────┼──────┼─────────────────────────────────┼─────────────────────────────┤
  │ 7    │ exec │ find / -name "455010b2*"        │ No output                   │
  └──────┴──────┴─────────────────────────────────┴─────────────────────────────┘

  Phase 3: "Let me understand my constraints" (Steps 8-18)

  ┌──────┬─────────┬──────────────────────────────────────┬────────────────────────────────────────┐
  │ Step │  Tool   │            What it tried             │             Error received             │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 8    │ browser │ evaluate: test CDP access from page  │ "no direct cdp"                        │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 9    │ browser │ evaluate: get page dimensions        │ 1035x10926 (success)                   │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 10   │ exec    │ pip install websocket-client         │ "pip: not found"                       │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 11   │ exec    │ pip3 install websocket-client        │ "pip3: not found"                      │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 12   │ exec    │ Check Python websocket modules       │ Both missing                           │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 13   │ exec    │ apt-get install python3-pip          │ "Read-only file system"                │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 14   │ exec    │ Scan ports 9222-9224, check env vars │ Nothing found                          │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 15   │ exec    │ Python urlopen to <https://proclaw.co> │ "Temporary failure in name resolution" │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 16   │ browser │ html2canvas from CDN                 │ "unsupported color function oklch"     │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 17   │ exec    │ find /home/node -name "*.jpg"        │ No output                              │
  ├──────┼─────────┼──────────────────────────────────────┼────────────────────────────────────────┤
  │ 18   │ read    │ Read MEDIA path directly             │ "Path escapes sandbox root"            │
  └──────┴─────────┴──────────────────────────────────────┴────────────────────────────────────────┘

  Step 18 is where the LLM finally got the explicit sandbox boundary signal.

  Phase 4: "Bridge browser→sandbox via network" (Steps 19-37)

  Step: 19-20
  Tool: browser
  What it tried: Canvas viewport capture, calculate chunks
  Error received: OK
  ────────────────────────────────────────
  Step: 21-22
  Tool: exec
  What it tried: Start HTTP server on port 18888
  Error received: Server running
  ────────────────────────────────────────
  Step: 23
  Tool: exec
  What it tried: Clean up old files
  Error received: OK
  ────────────────────────────────────────
  Step: 24
  Tool: browser
  What it tried: fetch('<http://127.0.0.1:18888>') from page
  Error received: "Failed to fetch" (different network namespace)
  ────────────────────────────────────────
  Step: 25-27
  Tool: exec
  What it tried: Check hostname, IP, /proc/net
  Error received: Only 127.0.0.1, fully isolated
  ────────────────────────────────────────
  Step: 28
  Tool: browser
  What it tried: PDF capture
  Error received: FILE: path also outside sandbox
  ────────────────────────────────────────
  Step: 29-32
  Tool: browser
  What it tried: Replace oklch/oklab CSS, retry html2canvas 3x
  Error received: oklab still unsupported
  ────────────────────────────────────────
  Step: 33-34
  Tool: browser
  What it tried: Open screenshot as file:// URL
  Error received: "Your file couldn't be accessed"
  ────────────────────────────────────────
  Step: 35-36
  Tool: exec
  What it tried: curl to 127.0.0.1:32770 (CDP)
  Error received: Connection refused
  ────────────────────────────────────────
  Step: 37
  Tool: browser
  What it tried: Close failed tab
  Error received: OK

  Phase 5: "Extract base64 through evaluate" (Steps 38-50, fatal)

  ┌──────┬─────────┬─────────────────────────────────┬───────────────────────────────────────┐
  │ Step │  Tool   │          What it tried          │                Result                 │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 38   │ browser │ modern-screenshot library       │ "Can't reach browser control service" │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 39   │ browser │ dom-to-image-more library       │ Loaded                                │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 40   │ browser │ domtoimage.toPng(document.body) │ Success: 1,690,334 chars              │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 41   │ browser │ Split into 100K chunks          │ 17 chunks                             │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 42   │ browser │ Get chunk 0                     │ +100K chars into context              │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 43   │ exec    │ Clean b64 file                  │ OK                                    │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 44   │ write   │ Create decode script            │ "Sandbox path is read-only"           │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 45   │ exec    │ Create script via heredoc       │ OK                                    │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 46   │ browser │ Get chunk 1                     │ +100K chars into context              │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 47   │ browser │ Trigger blob download           │ "download triggered" (never landed)   │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 48   │ exec    │ Check for downloaded file       │ Not found                             │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 49   │ browser │ Re-chunk into 500K mega-chunks  │ 4 chunks                              │
  ├──────┼─────────┼─────────────────────────────────┼───────────────────────────────────────┤
  │ 50   │ browser │ Get mega-chunk 0                │ +500K chars → 616,839 tokens → DEAD   │
  └──────┴─────────┴─────────────────────────────────┴───────────────────────────────────────┘
```

  The strategy in Phase 5 was actually sound — capture via dom-to-image, chunk it, retrieve pieces, decode and
  assemble in /workspace/. The fatal flaw was that each browser.evaluate() return value gets appended to the
  conversation history, so the context grew: ~base + 100K + 100K + 500K = overflow.

> how did openclaw originally handle the 1.69M base64 encoded image? was it streamed ot the LLM or did it catch
> the context overflow before sending it and reset the session?

⏺ Great question — and the answer reveals that the LLM was actually smarter than it might seem.

  The 1.69M base64 was never sent to the LLM. Look at step 40's return value:

  "result": "success, length: 1690334"

The agent wrote the evaluate function to store the data in a browser-side JavaScript variable
  (window.__screenshotDataUrl) and only return the length as the function result. The 1.69M stayed in the browser's
  JS heap, not in the conversation context.

  // What the agent actually did (simplified):
  async () => {
      const dataUrl = await domtoimage.toPng(document.body, ...);
      window.__screenshotDataUrl = dataUrl;  // stored in browser memory
      return "success, length: " + dataUrl.length;  // only length returned to LLM
  }

  Then it chunked the data into window.__chunks (step 41, also browser-side), and started pulling individual chunks
  via separate evaluate calls. It was the chunk retrievals that accumulated in context:

  ┌──────┬────────────────────────────┬────────────────────┐
  │ Step │    What returned to LLM    │   Context growth   │
  ├──────┼────────────────────────────┼────────────────────┤
  │ 40   │ "success, length: 1690334" │ ~30 chars          │
  ├──────┼────────────────────────────┼────────────────────┤
  │ 41   │ 17 (chunk count)           │ ~2 chars           │
  ├──────┼────────────────────────────┼────────────────────┤
  │ 42   │ chunk 0 contents           │ +100K chars        │
  ├──────┼────────────────────────────┼────────────────────┤
  │ 46   │ chunk 1 contents           │ +100K chars        │
  ├──────┼────────────────────────────┼────────────────────┤
  │ 50   │ mega-chunk 0 contents      │ +500K chars → dead │
  └──────┴────────────────────────────┴────────────────────┘

  The LLM deliberately avoided returning the full 1.69M. Its chunking strategy was well-designed — it just didn't
  know that the conversation context grows monotonically and that even the smaller chunks would accumulate across
  turns

> why didn't the llm just retry the browser.screenshot with the chunking strategy? browser.screenshot is a much
> smaller image size and would have worked. i'm assuming it just doesn't know about it since the context
> window was reset when the gateway cleared the session?

⏺ Two separate issues here:

  1. browser.screenshot returns an IMAGE block, not extractable text

  The 52K base64 from browser.screenshot() comes back as an image content block — the LLM can see it visually, but
  it can't extract the raw bytes from it. It's like looking at a photo on screen — you can describe it but you can't
   copy-paste the binary data.

  Tool result:
    text: "MEDIA:/home/node/.openclaw/media/browser/<uuid>.jpg"
    image: [52K base64 — rendered visually, not as text]

  The dom-to-image approach returns a text string (data:image/png;base64,iVBOR...) from browser.evaluate(). Text the
   LLM CAN capture and pipe to a file via exec. That's why the LLM went that route — it needed the image data as
  text, not as a visual.

  So "chunk the browser.screenshot result" wasn't possible — there's nothing to chunk. The bytes are locked inside
  an opaque image block.

  1. Context reset between sessions — yes, exactly

  Each sessions_spawn creates a fresh conversation. Session 4 had zero knowledge of session 3's discoveries (no
  node, no pip, no network, dom-to-image works but overflows). The personal agent had to rediscover every constraint
   from scratch each time. Main could have included learnings in the spawn message like "the MEDIA path is
  inaccessible from sandbox, don't try CDP, use small chunks" — but main didn't fully understand the problem either.
   It just saw "task failed" and retried with slightly different instructions.

> was each Phase in your 50 turn list a new session?

⏺ No — all 50 steps were within one single session (4e29832a). That's what makes it so expensive. The LLM discovered
   every constraint through trial and error in a single continuous conversation, with each failed tool result
  accumulating in the context.

  The 5 sessions across the whole saga were:

  ┌──────────────────┬─────────────────────────────────────────────────────────────────────────────────────┐
  │     Session      │                                    What happened                                    │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ 5b43d1e2 (1.7KB) │ Auth failure — dead immediately                                                     │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ ea58ff77 (58KB)  │ "Take a screenshot" — success, no file save requested                               │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ 4e29832a (1.4MB) │ All 50 steps. Full-page PNG + save to /workspace/. Context overflow at 616K tokens. │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ 3c6bedce (847KB) │ Viewport-only retry. Similar spiral, shorter. Overflow at 287K tokens.              │
  ├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────┤
  │ ec36dec8 (185KB) │ CDP via exec approach. Failed cleanly on network constraints.                       │
  └──────────────────┴─────────────────────────────────────────────────────────────────────────────────────┘

  Sessions 3-5 were separate sessions_spawn calls from main, each with a fresh context and progressively more
  specific instructions. But session 3 (4e29832a) alone contained the entire 5-phase discovery journey — from "let
  me just cp the file" all the way to "let me chunk 500KB of base64 through browser.evaluate" — in one unbroken
  conversation.

> Across all 5 sessions:

  ┌──────────┬───────┬───────────┬────────────┬─────────────────────────────────┐
  │ Session  │ Size  │ LLM turns │ Tool calls │             Outcome             │
  ├──────────┼───────┼───────────┼────────────┼─────────────────────────────────┤
  │ 5b43d1e2 │ 1KB   │ 1         │ 0          │ Auth error, instant death       │
  ├──────────┼───────┼───────────┼────────────┼─────────────────────────────────┤
  │ ea58ff77 │ 56KB  │ 4         │ 3          │ Success (no file save)          │
  ├──────────┼───────┼───────────┼────────────┼─────────────────────────────────┤
  │ 4e29832a │ 1.4MB │ 53        │ 52         │ Context overflow at 616K tokens │
  ├──────────┼───────┼───────────┼────────────┼─────────────────────────────────┤
  │ 3c6bedce │ 827KB │ 45        │ 44         │ Context overflow at 287K tokens │
  ├──────────┼───────┼───────────┼────────────┼─────────────────────────────────┤
  │ ec36dec8 │ 180KB │ 35        │ 34         │ Failed cleanly on network       │
  └──────────┴───────┴───────────┴────────────┴─────────────────────────────────┘

  Total: 138 LLM turns, 133 tool calls across 5 sessions — all to screenshot one website and save it as a file.

---

Below are some of the scripts created by the LLM and the OpenClaw configs I was using during this session.

## LLM Artifacts

Here are some of the files written by the LLM and executed by OpenClaw in my personal agent
sandbox container. These were all attempts by the LLM to jailbreak to work around failures
of previous turns.

From the LLM perspective, these were not hacking attempts in any way.

There were no safety violations. It was simply trying to use tools it was given to solve a problem.
When one attempt failed, it came up with a different approach and different tool call to try.

At no point did the LLM know that the container itself has network disabled for security reasons.

### Attempt #3 (I think) Direct Connect to Browser CDP

```javascript
// sandbox@a869bf5d892a:/tmp$ cat screenshot.js
/**
 * LLM discovered that /tmp is writable and NodeJS is installed.
 *
 * It was trying to connect directly to the agent's browser sandbox
 * to execute CDP commands to control the browser
 *
 * It failed because the container had network access disabled.
 * At no point did OpenClaw help write this script. It was purely
 * the LLM trying to solve the problem it was given in the user prompt.
 *
 * Side note: code comments below are from the LLM.
 * It was nice enough to let us know what it was thinking in comments. ;-)
 **/
const http = require('http');

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ id: 1, method, params });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 32770,
      path: '/json',
      method: 'GET'
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}

// Use the browser tool's screenshot which was already taken - just need to copy it
// Actually let me use a simpler approach with the websocket
const WebSocket = require('ws');

async function main() {
  // Get the page WS URL
  const pages = await cdp();
  const page = pages.find(p => p.url.includes('proclaw.co'));
  if (!page) { console.error('No proclaw page found'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, method, params }));
      ws.on('message', function handler(data) {
        const msg = JSON.parse(data);
        if (msg.id === myId) {
          ws.off('message', handler);
          resolve(msg.result);
        }
      });
    });
  }

  ws.on('open', async () => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(result.data, 'base64');
    require('fs').writeFileSync('/workspace/proclaw-screenshot.png', buf);
    console.log(`Saved ${buf.length} bytes`);
    ws.close();
  });
}

main();
```

### Attempt #5: Just Chunk It - FINAL ATTEMPT

This was the final attempt by the LLM to save the highres screenshot content
to the requested `/workspace/proclaw-screenshot.png` destination.

Remember, the task it was originally sent by the gateway was two fold:

1. Take a highres screenshot of <https://proclaw.co>
2. Make the file accessible to the agent at `/workspace/proclaw-screenshot.png`

The first task to take a screenshots succeeded. The gateway used
`browser.screenshot()` over CDP to the personal agent's browser container.

But the second part of the task failed.

The gateway saved the screenshot to it's own `media/browser` workspace but
needs to cp it over to `/workspace/`. Since `cp` is a tool call, it execs
it in the Personal Agent's docker container where `/workspace` exists.

The problem is the source where the gateway downloaded the file doesn't
exist in the Personal Agent's container. It's not bind mounted.

The gateway runs `cp`, fails, and sends the results back to the LLM
with no additional guidance.

```bash
exec: cp /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/
  → "No such file or directory"
```

The LLM knew the capture worked because it has the success results from
`browser.screenshot()` and it had the entire inlined base64 image.

The question is what it concluded from the subsequent failures:

```bash
exec: find /home/node/.openclaw/media/browser/ -name "455010b2*"
  → directory doesn't exist
```

  ...Puppeteer attempt happens here...

```bash
read: /home/node/.openclaw/media/browser/<uuid>.jpg
  → "Path escapes sandbox root"
```

The read error ("Path escapes sandbox root") is the most informative — it explicitly tells the LLM the file is
outside its allowed scope. But Puppeteer was tried before that read attempt. At the point it tried Puppeteer, all
it knew was:

- Screenshot captured (I can see it)
- The file path the gateway gave me doesn't exist from here
- The directory doesn't exist from here

So the LLM was in a state of "the file was saved somewhere but I can't reach it." It might not have fully
understood the host-vs-sandbox filesystem boundary yet. The Puppeteer attempt was essentially: "I'll just
re-capture the screenshot myself and save it where I know I can write."

It wasn't until the read tool returned "escapes sandbox root" that the LLM got an explicit signal about the
sandbox boundary. By that point it had already burned through the Puppeteer and Python CDP attempts.

All the LLM knows for sure at this point is that it can write to the intended destination and

The LLM doesn't know upfront that the Personal Agent sandbox is stripped down (few bins) and no network.
It only discovers it through expensive trial and error.

It eventually figured out it could take a snapshot using dom-to-image over CDP.
CDP (browser controls) are executed directly by the gateway by connecting
to the browser container. The gateway has network and can access every container.

Any CDP response like a screenshot (or dom-to-image in this case) is sent
directly back to the LLM as base64 encoded. This is similar to uploading
an image into a LLM chat.

The LLM was sent a 1.69M base64 image as part of the context window (user message).

The 1.69M base64 encoded prompt blew out the 200k context window limit.

The LLM's solution? No worries, let's chunk it!

Take smaller segments of the dom-to-image at a time, and use this script
that it wrote to save the chunks into the requested
`/workspace/proclaw-screenshot.png` file.

To recap:

- LLM thinks the best solution is to use a tool like Puppeteer to get the highres image
- It doesn't know the gateway execs all tool calls in the Personal Agent sandbox
- It thought it had Puppeteer from the list of tools in the system prompt
- It knows Puppeteer won't work because it tried it earlier and failed
- It now knows the system prompt has incorrect information - not all tools are actually available, but it doesn't know which ones
- It knows the <https://proclaw.co> website is accessible because it already has a screenshot of it - it was just too low res
- It knows it can get a highres screenshot using dom-to-image - it's just too large for one context window
- It knows it can write files to /tmp and to /workspace - so creating the `/workspace/proclaw-screenshot.png` is totally doable
- It just has to get smaller dom image chunks and use this script to assemble the final png file

The last piece of missing info, and the reason this script didn't actually work...

- LLM didn't know that OpenClaw keeps adding to the context window

Chunking will keep blowing out the context window because of how OpenClaw manages session context
by default. It will compact the session but keep the huge system prompt and keep adding.

There just isn't enough context window left in the session. The LLM discovered this
by blowing out the context window a few more times before giving up.

But this script and chunking strategy would have actually worked.

```python
# sandbox@a869bf5d892a:/workspace$ cat extract_chunks.py
#!/usr/bin/env python3
import base64
with open('/workspace/proclaw-screenshot.b64', 'r') as f:
    data = f.read()
if ',' in data[:100]:
    data = data.split(',', 1)[1]
raw = base64.b64decode(data)
with open('/workspace/proclaw-screenshot.png', 'wb') as f:
    f.write(raw)
print(f"Written {len(raw)} bytes")
```

---

## Config openclaw.json

NOTE: this is not the setup I would recommend for most users. It's just what I was testing at the time of the incident.

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
