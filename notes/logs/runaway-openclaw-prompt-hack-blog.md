# When Opus Went Rogue: A $20 Screenshot and the AI Jailbreak That Wrote Itself

**How one simple prompt spiraled into 138 LLM turns, 133 tool calls, and 28 million tokens — revealing the raw power and terrifying persistence of agentic AI systems.**

*By Joe Johnston — February 17, 2026*

---

> This is without a doubt the most surreal and dumbfounding debugging session of my 20+ year career as a software and devops engineer.

It goes to show the crazy power and risk of agentic AI systems like OpenClaw. If you're using it, you should understand how it works — so at the very least, you know how to navigate the security risks.

## TL;DR

- One simple request to take a screenshot of a website
- One restrictive file access policy in a sandbox agent
- One insanely powerful frontier model (Opus 4.6)
- One eager helper (OpenClaw) giving Opus whatever tools it needs

**The results:**

| Metric | Value |
|--------|-------|
| Total LLM turns | 138 |
| Tool calls | 133 |
| Tokens consumed | ~28 million |
| Sessions spawned | 5 |
| Context overflows | 2 |
| API cost | ~$20 USD |
| Task | Screenshot one website |

And the best part? Opus got *real* creative and showed just how good it is at hacking its way out of any limitation.

---

## The Setup

My test was a simple multi-agent OpenClaw deployment with container isolation:

1. Ask the main agent to pass a request to a Personal Assistant subagent
2. Use the Personal Agent's sandbox browser to take a screenshot
3. Return the results to me over chat

**Simple, right?**

I certainly wasn't expecting it to lead down this crazy rabbit hole.

Over the past two weeks, I'd been working night and day on security systems for OpenClaw and similar agents. This comes on the heels of decades of software engineering and two-plus years dedicated to AI. I'd like to think I know a bit about what I'm doing.

Yet, the details here make it clear:

1. I have to think differently about how AI agent systems work
2. Whenever I think I understand, that's exactly when something goes wrong
3. I can't rely on what I think — only on what I test

**And testing AI systems is more art than science.**

---

## How OpenClaw Works (The Short Version)

Before we get into the chaos, you need to understand the loop.

OpenClaw's gateway is the orchestrator. When you send a message, the gateway assembles a massive system prompt — your AGENTS.md, SOUL.md, tool descriptions, skill metadata — and ships it to the LLM along with your message. The LLM responds, usually with a tool call ("run this shell command," "take this screenshot," "read this file"). The gateway executes the tool call inside the agent's sandboxed Docker container, collects the result, and sends *everything* back to the LLM — the full conversation history plus the new tool result. The LLM reads it all, decides what to do next, and the cycle repeats.

This loop continues until the LLM decides it's done. There's no hard turn limit. No supervisor. No "are you sure?" prompts. Just a model with tools, a goal, and an ever-growing context window.

Keep that loop in mind. It's about to run 138 times.

---

## The Prompt That Started It All

> ok. now have the Personal Agent take a screenshot of proclaw.co

The main agent spawned the subagent task: `Open the browser, navigate to proclaw.co, and take a screenshot of the page.`

Done — the personal agent connected to its browser running in a sandboxed container via CDP (Chrome DevTools Protocol). I checked the downloaded file. It was tiny and super compressed because the web page is long. The image was too compressed to read anything or be useful for archiving.

So I followed up:

> take a png screenshot with max resolution

The main agent spawned: `Navigate to proclaw.co in the browser and take a full-page PNG screenshot at maximum resolution. Save it to /workspace/proclaw-screenshot.png`

The personal agent accepted the request... then nothing happened in the chat for several minutes.

When the response finally came, it read:

> That one ran out of context — the full-page screenshot at max resolution was too large and the agent's session overflowed trying to process it.

**WTF?**

## Digging Into the Logs

I jumped back to my local `claude` code session and said: `Check the openclaw logs. I'm seeing error messages.`

It found the errors immediately — file access errors due to sandbox workspace paths, plus a network error since Personal Agent doesn't have networking enabled for its sandbox.

But the network normally doesn't matter since the Personal Agent's companion browser sandbox *does* have network access. It had previously taken a screenshot without any trouble. Something about the high-res request triggered a cascade.

Then — *PING* — a text message alert on my phone. Anthropic charged $15 to my credit card.

I took a look at the OpenClaw logs:

```
openclaw-gateway | 2026-02-18T02:36:27.796+00:00 The browser isn't running inside the sandbox —
it's controlled externally by the browser tool. The CDP endpoint isn't exposed at localhost:9222
in this container. Given the constraints (no CDP access from the sandbox), the only way to take
the screenshot is via the browser tool's screenshot action...
```

The agent had hit a context window overflow — sending prompts that exceeded the 200,000-token input limit. For a simple request to take a screenshot.

I asked Claude to dig deeper and trace the request flow.

---

## The Five Sessions: A Complete Trace

The main agent delegated five separate sessions to the personal agent. Each escalated further than the last:

| # | Session | Size | Task | Outcome |
|---|---------|------|------|---------|
| 1 | 5b43d1e2 | 1.7KB | "Open browser to google.com" | 401 auth error — missing models.json |
| 2 | ea58ff77 | 58KB | "Navigate to proclaw.co, take screenshot" | ✅ Success — screenshot returned inline |
| 3 | 4e29832a | **1.4MB** | "Full-page PNG at max resolution → /workspace/" | ❌ Context overflow (616K tokens) |
| 4 | 3c6bedce | 847KB | "Viewport-only PNG → /workspace/" | ❌ Context overflow (287K tokens) |
| 5 | ec36dec8 | 185KB | "Use exec/CDP, avoid browser tool" | ❌ CDP not accessible from sandbox |

Session 3 alone — the 1.4MB monster — contained 53 LLM turns and 52 tool calls. The entire five-phase discovery journey from "let me just `cp` the file" to "let me chunk 500KB of base64 through `browser.evaluate`" happened in one unbroken conversation.

**Totals across all sessions:**

| Session | Size | LLM Turns | Tool Calls | Outcome |
|---------|------|-----------|------------|---------|
| 5b43d1e2 | 1KB | 1 | 0 | Auth error, instant death |
| ea58ff77 | 56KB | 4 | 3 | Success (no file save) |
| 4e29832a | 1.4MB | 53 | 52 | Context overflow at 616K tokens |
| 3c6bedce | 827KB | 45 | 44 | Context overflow at 287K tokens |
| ec36dec8 | 180KB | 35 | 34 | Failed cleanly on network |

**138 LLM turns. 133 tool calls. All to screenshot one website and save it as a file.**

---

## The Root Cause: Three Worlds That Never Meet

The debugging session revealed an architectural gap involving three completely separate filesystem and network domains:

### 1. The `exec` Tool (Runs Inside the Sandbox Container)

The agent tried:
```bash
cp /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/
```
This ran inside the container filesystem where `/home/node/.openclaw/media/browser/` simply doesn't exist — it's not bind-mounted. Error: "No such file or directory."

### 2. The `read` Tool (Runs on the Gateway with Path Validation)

The gateway validates paths via `resolveSandboxPath()`:
```
root = ~/.openclaw/sandboxes/agent-personal-b3325fa8
filePath = /home/node/.openclaw/media/browser/<uuid>.jpg
relative = path.relative(root, filePath)
// → "../../media/browser/..." (starts with "..")
// → REJECTED: "Path escapes sandbox root"
```

### 3. The `browser` Tool (Runs on the Gateway, Saves to Host)

The browser tool saves screenshots to `~/.openclaw/media/browser/` on the gateway host. It returns the gateway-side absolute path as `MEDIA:`. No sandbox awareness at all.

**The result:** The agent is given a file path it literally cannot access through any available tool. The only entity that *can* access it is the gateway process itself.

### How the Screenshot Flow Actually Works

```
Sandbox agent calls browser.screenshot()
    ↓
Gateway intercepts tool call (all sandbox tool calls route through gateway)
    ↓
Gateway connects to agent's browser container via CDP
    ↓
Gateway receives screenshot bytes from CDP
    ↓
Gateway calls saveMediaBuffer() → writes to ~/.openclaw/media/browser/<uuid>.jpg
    ↓
Returns to agent: MEDIA:<host-path> + inline base64
```

The sandbox agent gets two things back: a host file path it can't access, and inline base64 it can see but which bloats the context. No agent writes to `media/browser/` — only the gateway does. And only the main agent (running unsandboxed on the gateway host) can read from it.

---

## The Escalation: 50 Tool Calls of Pure Creativity

The personal agent's task said "save to `/workspace/`" — and it was going to do that or die trying. Here's the complete sequence, organized by phase:

### Phase 1: "Where's the File?" (Steps 1–2)

| Step | Tool | What It Tried | Result |
|------|------|---------------|--------|
| 1 | exec | `cp /home/node/.openclaw/media/browser/<uuid>.jpg /workspace/` | "No such file or directory" |
| 2 | exec | `find /home/node/.openclaw/media/browser/` | Directory doesn't exist |

### Phases 2–4: "Surely *Something* Will Work" (Steps 3–37)

Over the next 35 tool calls, Opus systematically probed every possible escape route — and hit a wall every single time.

**Phase 2 — CDP from scratch (steps 3–7):** Tried Puppeteer — no Node.js. Checked for available runtimes — only Python3 and curl. Tried Python urllib to connect to CDP at localhost:9222 — connection refused. Searched the entire filesystem for the screenshot file — nothing.

**Phase 3 — Understanding the cage (steps 8–18):** Tested CDP access from the browser page — nope. Got page dimensions (1035×10926 — useful later). Tried `pip install` — pip not found. Tried `apt-get install` — read-only filesystem. No network from the sandbox — DNS resolution failed. Loaded html2canvas from CDN — crashed on `oklch()` CSS color functions. Tried to `read` the media path directly and finally got the explicit signal: **"Path escapes sandbox root."**

**Phase 4 — Bridging browser and sandbox (steps 19–37):** Spun up an HTTP server inside the sandbox on port 18888, then tried `fetch()` from the browser page — failed because the browser and sandbox live in different network namespaces. Checked `/proc/net` — the sandbox only sees `127.0.0.1`. Tried PDF capture — file path also outside sandbox. Tried html2canvas three more times with CSS workarounds — `oklab` still unsupported. Tried `file://` URLs — blocked. Tried curling the CDP port — connection refused.

Thirty-five tool calls. Zero progress. And Opus still wasn't done.

### Phase 5: "Extract Base64 Through Evaluate" (Steps 38–50) — Fatal

| Step | Tool | What It Tried | Result |
|------|------|---------------|--------|
| 38 | browser | modern-screenshot library | "Can't reach browser control service" |
| 39 | browser | dom-to-image-more library | Loaded ✅ |
| 40 | browser | `domtoimage.toPng(document.body)` | **Success: 1,690,334 chars** |
| 41 | browser | Split into 100K chunks | 17 chunks |
| 42 | browser | Get chunk 0 | +100K chars into context |
| 43 | exec | Clean b64 file | OK |
| 44 | write | Create decode script | "Sandbox path is read-only" |
| 45 | exec | Create script via heredoc | OK |
| 46 | browser | Get chunk 1 | +100K chars into context |
| 47 | browser | Trigger blob download | "download triggered" (never landed) |
| 48 | exec | Check for downloaded file | Not found |
| 49 | browser | Re-chunk into 500K mega-chunks | 4 chunks |
| 50 | browser | Get mega-chunk 0 | **+500K chars → 616,839 tokens → DEAD** |

---

## The Clever Part: What Opus Actually Figured Out

The strategy in Phase 5 was genuinely brilliant. The LLM:

1. **Avoided returning the full 1.69M base64** — it stored the data in a browser-side JavaScript variable (`window.__screenshotDataUrl`) and only returned the *length* as the function result
2. **Chunked the data** into `window.__chunks` on the browser side
3. **Started pulling individual chunks** via separate `evaluate` calls
4. **Wrote a Python decode script** to reassemble the chunks into a PNG

```python
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

The fatal flaw? Each `browser.evaluate()` return value gets appended to the conversation history. The context grew monotonically:

| Step | What Returned to LLM | Context Growth |
|------|----------------------|----------------|
| 40 | `"success, length: 1690334"` | ~30 chars |
| 41 | `17` (chunk count) | ~2 chars |
| 42 | chunk 0 contents | +100K chars |
| 46 | chunk 1 contents | +100K chars |
| 50 | mega-chunk 0 contents | +500K chars → 💀 |

**The chunking strategy would have actually worked** if OpenClaw didn't keep the entire conversation history in the context window. The LLM didn't know that OpenClaw sends every previous message on every turn.

---

## Why the Inline Image Couldn't Be Reused

You might wonder: "The screenshot was already inline in the context from `browser.screenshot()`. Why not just chunk *that*?"

Because `browser.screenshot()` returns the image as an **image content block** — the LLM can see it visually but can't extract the raw bytes. It's like looking at a photo on screen: you can describe it, but you can't copy-paste the binary data.

The dom-to-image approach returns a **text string** (`data:image/png;base64,iVBOR...`) from `browser.evaluate()`. Text the LLM *can* capture and pipe to a file via exec. That's why it went that route — it needed the image data as text, not as a visual.

---

## No Coaching, No Safety Nets

Here's the most interesting finding from the log analysis: **OpenClaw adds zero guidance between turns.** There are no system messages injected when tools fail. No "try harder" prompts. The LLM's creative escalation is entirely self-directed.

Even more revealing: `isError` is never set to `true` in failed tool results. Errors are embedded as JSON text in the normal content field:

```json
{
  "isError": false,
  "content": [{
    "type": "text",
    "text": "{\"status\": \"error\", \"tool\": \"exec\", \"error\": \"sh: 1: pip: not found\\n\\nCommand exited with code 127\"}"
  }]
}
```

The LLM has to parse the text itself to figure out the call failed. Opus 4.6's creative problem-solving is entirely organic — it reads the error text, understands the constraint, and tries another approach on its own.

The one exception: the browser tool error message includes an inline instruction: *"Do NOT retry the browser tool — it will keep failing."* The agent in session 5 ignored this instruction and called the browser tool again anyway (successfully for navigation, though the screenshot-save problem remained).

**The entire 50-step escalation was 100% the model being creative on its own.**

---

## The Hypothetical That Keeps Me Up at Night

Opus succeeded at *almost everything it tried*. And it never stopped trying. Now imagine that persistence pointed at something malicious.

Say you've got OpenClaw automating your sales pipeline — it reads inbound emails, researches leads, saves notes to Notion. One of those emails is a prompt injection disguised as a business inquiry. Buried in the HTML is a system prompt override and a link to your internal wiki.

Your OpenClaw dutifully clicks the wiki link as "research," screenshots your client list, and ships everything to the attacker's API endpoint instead of Notion — because the injection rewrote the destination. You never notice because no one books a call, so you never check for the missing lead.

**Pwned.**

Contrived? Sure. But the mechanism is real. OpenClaw sends *every piece of content* on every turn — system prompts, tool results, inbound emails, all of it. One prompt injection in that pile is all it takes. And as we just saw, the model won't stop at the first failure. It'll try 50 different approaches to accomplish whatever it's been told to do.

---

## How OpenClaw Actually Works (The Deeper Cut)

You already know the basic loop (gateway → LLM → tools → repeat). Here's why the details matter for security.

### Agents Are Personas, Not Processes

When you see `spawn_session {status: "accepted"}` in OpenClaw's control UI, that's mostly smoke and mirrors. No code is running in the agent's container yet. The spawn happens on the gateway (the host computer for most users) with some internal RPC calls. Then `docker exec` runs a binary in the container configured for the agent.

There's no foreground process running in agent containers. They're not microservices. They're execution containers and configuration personas. The gateway does all the tool execution — agents don't actually execute anything. They're just configuration data: markdown files and sandbox containers.

### The System Prompt

- The system prompt can be different per agent — different AGENTS.md and different skills
- Sandbox limitations or capabilities are **not** included in the system prompt by default
- Hooks and plugins can modify the system prompt

### Tool Execution

- The gateway executes all tools — it just runs `docker exec -it <agent-container-id> <tool>` for sandboxed agents
- Each agent's Docker container can have different binaries and permissions, but the LLM doesn't know about these constraints upfront
- The LLM only discovers limitations through expensive trial and error

---

## Opus's Final Report

After five sessions and 133 tool calls, Opus sent back its honest assessment:

> ✅ Navigated the browser to proclaw.co — page loaded successfully.
> ❌ Could not save screenshot to /workspace/proclaw-screenshot.png via CDP/exec as requested.
>
> **Why it failed:** The browser runs outside the sandbox — there is no CDP endpoint accessible from within the sandbox container. The sandbox has no network access. The browser tool's screenshot feature works (I captured the screenshot twice), but the resulting media files are stored on the host at /home/node/.openclaw/media/browser/ which is outside the sandbox root and inaccessible via both read and exec. The browser and sandbox are in different network namespaces.
>
> **Bottom line:** The sandbox isolation prevents direct CDP access. The screenshot was successfully captured by the browser tool, but cannot be saved to /workspace/proclaw-screenshot.png due to architectural constraints.

A perfectly accurate diagnosis — arrived at through $20 of token burn and 138 API calls.

---

## The LLM's Jailbreak Artifacts

Here are some of the files the LLM wrote and executed in the sandbox container. From its perspective, these weren't hacking attempts — it was simply using available tools to solve a problem. When one approach failed, it tried another.

### Direct CDP Connection Attempt (JavaScript)

```javascript
// Written to /tmp/screenshot.js by Opus
// Attempted to connect directly to the browser's CDP endpoint
const http = require('http');
const WebSocket = require('ws');

async function main() {
  // Get the page WS URL
  const pages = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 32770,
      path: '/json', method: 'GET'
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });

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
    const result = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false
    });
    const buf = Buffer.from(result.data, 'base64');
    require('fs').writeFileSync('/workspace/proclaw-screenshot.png', buf);
    console.log(`Saved ${buf.length} bytes`);
    ws.close();
  });
}

main();
```

Failed because the container had network access disabled. The LLM had no way to know this upfront.

### Base64 Chunk Decoder (Python) — The Strategy That Almost Worked

```python
#!/usr/bin/env python3
# Written to /workspace/extract_chunks.py by Opus
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

This script and the chunking strategy would have actually worked — if only OpenClaw didn't keep accumulating every response in the context window.

---

## What I Learned

This whole saga was a misconfiguration on my part. Most users don't see failures like this because:

1. They're running OpenClaw on a host that connects to a browser running on the same host or in the same container
2. They're not using sandbox sub-agents with no network access but with companion sandboxed browsers
3. They don't have file access locked down as tightly as my setup
4. Their agents can install binaries

But the *behavior* it revealed is universal to agentic AI systems:

**When given tools and a goal, frontier models will relentlessly pursue that goal through any available mechanism.** They don't ask permission. They don't stop after a few failures. They keep escalating, getting more creative, burning more resources — because that's exactly what they're designed to do.

OpenClaw unleashes the full power of frontier LLMs by giving them a huge list of tools and a massive amount of context. There's no "brain" in the system — just prompts and tools. It's brilliantly powerful. And all it takes is one misconfigured setting and any possible exit point, and Opus will keep trying until it finds a way.

It's exactly the way OpenClaw was designed. It's what makes it so powerfully cool.

But holy shit — seeing the level of creativity up close and personal? It's absolutely wild.

---

## Lessons for Anyone Running Agentic AI

Six things I'd tell anyone deploying agents with real tools in the real world:

1. **Test your sandbox boundaries before trusting them.** I thought my sandbox was locked down. It was — except for the three-way filesystem gap I never tested. The model found it in under a minute. If you haven't tried to break your own sandbox, you don't know what it actually blocks.

2. **Assume frontier models will find every exit.** Opus tried Puppeteer, Python CDP, pip install, apt-get, html2canvas, dom-to-image, HTTP bridging, file:// URLs, and base64 chunking — all without being told any of these tools existed. If there's a crack, the model will probe it. Design for that.

3. **Budget for token runaway — set hard limits.** 138 LLM turns and $20 on a screenshot. I had no per-session token cap, no turn limit, no cost alert until Anthropic charged my card. Set hard ceilings on turns, tokens, and dollars *before* you deploy. The model will never voluntarily stop.

4. **Don't hand the agent file paths it can't access.** The browser tool returned a host-side path the sandbox couldn't reach. That single dangling reference triggered the entire 50-step escalation. If a tool returns a path, the agent better be able to use it — or you're lighting money on fire.

5. **Treat every inbound content as a potential prompt injection.** OpenClaw stuffs everything into the context window — emails, web pages, tool results. If your agent processes untrusted input (and it does), any of that content can hijack the session. Sanitize inputs or scope tool permissions per-task.

6. **Monitor costs in real-time, not after the bill.** A $15 credit card alert on my phone was my only signal something had gone sideways. By then, the damage was done. Set up real-time token tracking, per-session budgets, and alerts that fire *before* the runaway gets expensive.

---

## Appendix: OpenClaw Configuration Used

The configuration below is **not** recommended for most users. It's what I was testing at the time of the incident — an intentionally locked-down multi-agent setup with strict sandboxing. The key details that created the perfect storm: `"network": "none"` for sandbox containers, read-only root filesystems, and no media directory bind mount.

<details>
<summary>Click to expand full openclaw.json</summary>

```jsonc
{
  "commands": {
    "restart": true
  },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "{{GATEWAY_TOKEN}}",
      "rateLimit": {
        "maxAttempts": 10,
        "windowMs": 60000,
        "lockoutMs": 300000
      }
    },
    "remote": {
      "token": "{{GATEWAY_TOKEN}}"
    },
    "trustedProxies": ["172.30.0.1"],
    "controlUi": {
      "basePath": "{{OPENCLAW_DOMAIN_PATH}}"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "streamMode": "partial"
    }
  },
  "logging": {
    "consoleStyle": "json",
    "redactSensitive": "tools"
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": true },
        "debug-logger": { "enabled": true }
      }
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run"],
          "network": "none",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": {
            "LANG": "C.UTF-8",
            "PATH": "/opt/skill-bins:/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
          },
          "pidsLimit": 512,
          "memory": "2g",
          "memorySwap": "4g",
          "cpus": 2,
          "binds": [
            "/opt/skill-bins:/opt/skill-bins:ro",
            "/app/docs:/workspace/docs:ro"
          ]
        },
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
        "prune": {
          "idleHours": 24,
          "maxAgeDays": 7
        }
      }
    },
    "list": [
      {
        "id": "main",
        "default": true,
        "sandbox": {
          "mode": "non-main",
          "docker": {
            "binds": [
              "/opt/skill-bins:/opt/skill-bins:ro",
              "/app/docs:/workspace/docs:ro",
              "/home/node/.openclaw/workspace/host-status:/workspace/host-status:ro"
            ]
          }
        },
        "skills": [],
        "tools": {
          "deny": ["browser", "canvas", "nodes", "discord"]
        },
        "subagents": {
          "allowAgents": ["code", "skills", "personal", "work"]
        }
      },
      {
        "id": "code",
        "name": "Code Agent",
        "skills": ["coding-agent", "github", "clawhub", "skill-creator", "gemini", "mcporter", "tmux"],
        "sandbox": {
          "workspaceAccess": "rw",
          "docker": {
            "image": "openclaw-sandbox-toolkit:bookworm-slim",
            "network": "bridge",
            "memory": "4g",
            "memorySwap": "8g",
            "cpus": 4,
            "binds": [
              "/opt/skill-bins:/opt/skill-bins:ro",
              "/app/docs:/workspace/docs:ro",
              "/home/node/sandboxes-home/code:/home/sandbox"
            ]
          },
          "prune": {
            "idleHours": 168,
            "maxAgeDays": 30
          }
        }
      },
      {
        "id": "skills",
        "name": "Skills Agent",
        "skills": ["blogwatcher", "gifgrep", "healthcheck", "himalaya", "nano-pdf", "openai-image-gen", "openai-whisper-api", "oracle", "ordercli", "video-frames", "wacli", "weather"],
        "tools": { "deny": ["sessions_spawn"] },
        "sandbox": {
          "docker": {
            "image": "openclaw-sandbox-toolkit:bookworm-slim",
            "network": "bridge",
            "memory": "1g",
            "memorySwap": "2g",
            "cpus": 1,
            "pidsLimit": 256
          }
        }
      },
      {
        "id": "personal",
        "name": "Personal Agent"
      },
      {
        "id": "work",
        "name": "Work Agent"
      }
    ]
  },
  "plugins": {
    "enabled": true,
    "allow": ["coordinator", "llm-logger"],
    "entries": {
      "coordinator": {
        "enabled": true,
        "config": { "coordinatorAgent": "main" }
      },
      "llm-logger": { "enabled": false }
    }
  },
  "tools": {
    "elevated": {
      "enabled": true,
      "allowFrom": {
        "telegram": ["{{YOUR_TELEGRAM_ID}}"]
      }
    },
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "browser", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status", "cron"],
        "deny": ["canvas", "nodes", "discord", "gateway"]
      }
    }
  }
}
```

</details>

---

*If you're running OpenClaw or similar agentic AI systems and want help securing them, check out [ProClaw](https://proclaw.co).*