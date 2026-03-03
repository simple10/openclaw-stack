# Local Browser Node

Run an OpenClaw **node host** on your local machine that connects to your VPS gateway. The gateway's main agent auto-routes browser tool calls to this node.

## Profiles

| Profile | Command | What it does |
|---------|---------|-------------|
| **kasm** | `./run.sh --profile kasm up --build` | Full KasmVNC desktop with Chromium at `https://localhost:6901`. Requires special base image + full build (~5 min first time). |
| **novnc** | `./run.sh --profile novnc up --build` | Chromium via noVNC at `http://localhost:6080`. ARM-native, lighter than Kasm. Supports browser fingerprint env vars (timezone, locale, user-agent). |
| **headless** | `./run.sh --profile headless up --build` | Chromium with no GUI. Lightest option that still has a real browser. |
| **extension** | `./run.sh --profile extension up --build` | **No browser in the container.** Controls your Mac's Chrome via the OpenClaw Browser Relay extension. Lightest overall — no Chromium, no display server. |

### Extension Profile (Local Browser)

The **extension** profile is different from the others — instead of running a browser inside the container, it relays commands to your Mac's Chrome via a browser extension. This means:

- Your existing Chrome sessions and logins are available to OpenClaw
- No extra memory for a containerized browser
- You see everything happening in your own browser

**Setup:**

1. Start the container: `./run.sh --profile extension up --build`
2. Load the unpacked extension from `./data/openclaw/browser/chrome-extension/` in Chrome (`chrome://extensions` → Developer mode → Load unpacked)
3. Click the extension icon → enter the **gateway token** and **relay port** shown in the container logs

> **Non-standard port:** The relay uses port **28793** instead of the default 18792. This is required because OpenClaw hardcodes the relay to `127.0.0.1` and Docker port mapping needs a socat bridge on a separate port. The container logs display the port and token on startup.

## Prerequisites

- Docker + Docker Compose
- Your VPS gateway running behind Cloudflare Access
- A **Cloudflare Access service token** (see setup below)

## Setup

### 1. Create a Cloudflare Access Service Token

1. Go to [CF Dashboard](https://one.dash.cloudflare.com/) → **Zero Trust** → **Access** → **Service Tokens**
2. Click **Create Service Token**, name it (e.g., `browser-node`)
3. Copy the **Client ID** and **Client Secret** (the secret is only shown once)

### 2. Add a Service Auth Policy

1. Go to **Zero Trust** → **Access** → **Applications** → your OpenClaw app
2. Add a policy: **Action** = `Service Auth`, **Include** = Service Token → your token
3. Save

### 3. Configure

Add to your root `.env`:

```env
LOCAL_BROWSER_NODE_CLAW=personal-claw
CF_ACCESS_CLIENT_ID=your-client-id
CF_ACCESS_CLIENT_SECRET=your-client-secret
```

That's it — the gateway domain and token are resolved automatically from `stack.yml` via the claw name.

### 4. Build & Start

```bash
cd docker/local-browser-node
./run.sh --profile extension up --build    # Extension relay (lightest)
./run.sh --profile headless up --build     # Headless Chromium
./run.sh --profile novnc up --build        # noVNC desktop
./run.sh --profile kasm up --build         # KasmVNC desktop
```

## How It Works

### Kasm / noVNC / Headless

```
┌──────────────────────────────────────────────┐
│            browser-node container             │
│                                               │
│  Chromium ◄──── desktop (Kasm/noVNC/headless)│
│     ▲                                         │
│     │ CDP                                     │
│  openclaw node run ──► ws-proxy.mjs ──────────┼──► wss://gateway.domain
│  (ws://localhost:18789)  (CF Access headers)   │
└──────────────────────────────────────────────┘
```

### Extension Relay

```
┌─────────────────────────────────────────────────────────┐
│              extension-node container                    │
│                                                          │
│  openclaw gateway run (loopback :28790)                  │
│     ├── browser control server (:28792)                  │
│     └── extension relay (:28793) ◄── socat ◄────────────┼─── Docker :28793
│                                                          │
│  openclaw node run ──► ws-proxy.mjs ────────────────────┼──► wss://gateway.domain
└─────────────────────────────────────────────────────────┘
         ▲
         │ WebSocket (ws://localhost:28793/extension)
         │
    Chrome + OpenClaw Browser Relay extension (on your Mac)
```

## Operations

```bash
# All commands via run.sh (resolves config automatically)
./run.sh --profile <profile> up --build      # Build & start (foreground)
./run.sh --profile <profile> up --build -d   # Build & start (background)
./run.sh --profile <profile> logs -f         # Follow logs
./run.sh --profile <profile> down            # Stop
./run.sh --profile <profile> build --no-cache  # Full rebuild
```

## Verification

On the VPS:

```bash
openclaw nodes status
# Should list the node with "browser" capability
```

Test: ask the main agent to browse a URL.

## Caveats

- **Latency**: browser actions route Mac → CF → VPS → CF → Mac → browser → back
- **Mac must be running**: browser only available while the container is up
- **First build**: kasm ~5 min, others ~2 min (subsequent starts are instant)
- **Extension port**: relay uses **28793** not the default 18792 (see extension profile notes above)

## Resources

- <https://demo.fingerprint.com/playground> - test if your browser fingerprint settings look natural
