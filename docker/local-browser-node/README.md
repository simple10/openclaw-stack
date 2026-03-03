# Local Browser Node

Run an OpenClaw **node host** with headless Chromium on your local machine. The VPS gateway's main agent auto-routes browser tool calls to this node.

## Why

The VPS main agent (running as `non-main`) can't use a sandbox browser. This container provides a browser via the existing node proxy system — the main agent's browser tool auto-discovers it.

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
./run.sh up --build -d
```

First build takes ~5 min (git clone + pnpm install + build + Chromium).

## How It Works

```
Mac                                     Cloudflare                     VPS
┌──────────────┐                    ┌───────────────┐           ┌──────────────┐
│ browser-node │ ws://localhost ──► │ cloudflared   │ ─wss──►  │ CF Edge      │
│ (Chromium)   │                   │ access proxy  │           │ ↓ Access     │
│              │ ◄──────────────── │ (sidecar)     │ ◄──────── │ ↓ Tunnel     │
└──────────────┘                   └───────────────┘           │ ↓ Gateway    │
      shared network namespace                                 └──────────────┘
```

1. `run.sh` sources `source-config.sh` → resolves gateway domain and token from the claw name
2. **cloudflared sidecar** listens on `localhost:18789`, authenticates through CF Access
3. **browser-node** connects via `ws://localhost:18789` (shared network namespace)
4. Gateway token auth → node registered with `caps: ["system", "browser"]`
5. Main agent's browser tool auto-discovers the node and routes through it

## Operations

```bash
# All commands via run.sh (resolves config automatically)
./run.sh up --build -d         # Build & start
./run.sh logs -f               # Follow logs
./run.sh logs -f browser-node  # Just the node
./run.sh down                  # Stop
./run.sh build --no-cache      # Rebuild (new OpenClaw version)
```

## Verification

On the VPS:
```bash
openclaw nodes status
# Should list the node with "browser" capability
```

Test: ask the main agent to browse a URL.

## Caveats

- **Latency**: browser actions route Mac → CF → VPS → CF → Mac → Chromium → back
- **Mac must be running**: browser only available while the container is up
- **First build**: ~5 min (subsequent starts are instant)
- **Chromium memory**: ~200-400MB per tab on top of container overhead
