# Bind-mount OpenClaw docs into sandbox containers

## Context

The sandbox agent's system prompt includes `OpenClaw docs: /app/docs` and the instruction "consult local docs first." This path is resolved on the **gateway** (at `/app/docs`, where the OpenClaw package lives), but the sandbox container has no access to it — it only sees `/workspace`, `/opt/skill-bins`, and custom binds. When the agent tries to `read` docs files, it fails silently and falls back to asking the user or searching online.

### Root cause trace

1. **Gateway** runs `resolveOpenClawDocsPath()` (`src/agents/docs-path.ts:5-30`) — walks up from `import.meta.url` to find `package.json` with name `"openclaw"` at `/app/`, returns `/app/docs`
2. **System prompt** (`src/agents/system-prompt.ts:146-162`) embeds the path: `OpenClaw docs: /app/docs`
3. **Sandbox container** is created with only workspace + configured binds (`src/agents/sandbox/docker.ts:227-236`) — `/app/docs` is not mounted
4. **Agent tries to read** `/app/docs/...` inside sandbox → path doesn't exist → docs unavailable

### Why a bind mount works

Binds are **merged** across global defaults and per-agent config (`src/agents/sandbox/config.ts:55`):

```typescript
const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];
```

Adding to `agents.defaults.sandbox.docker.binds` propagates to ALL agents (main, code, skills) automatically.

## Change

**File:** `deploy/openclaw.json`

Add `/app/docs:/app/docs:ro` to `agents.defaults.sandbox.docker.binds`:

```json
"binds": [
  "/opt/skill-bins:/opt/skill-bins:ro",
  "/app/docs:/app/docs:ro"
]
```

This is the only change needed. No source code modifications, no entrypoint changes, no compose changes.

## Deployment

After updating `deploy/openclaw.json`:

1. SCP the updated file to VPS: `scp deploy/openclaw.json adminclaw@VPS:/tmp/openclaw.json`
2. Move into place: `sudo cp /tmp/openclaw.json /home/openclaw/.openclaw/openclaw.json && sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json && sudo chmod 600 /home/openclaw/.openclaw/openclaw.json`
3. Recreate sandbox containers (binds are set at creation time, not updated on restart):

   ```
   openclaw sandbox recreate --all
   ```

   Or restart the gateway: `cd /home/openclaw/openclaw && sudo -u openclaw docker compose restart openclaw-gateway`

## Verification

1. After sandbox recreation, exec into a sandbox and check the mount:

   ```
   sudo docker exec openclaw-gateway docker exec <sandbox-container> ls /app/docs
   ```

   Should list the docs directory contents (index.md, cli/, concepts/, etc.)

2. In an OpenClaw chat session, ask: "Read the file at /app/docs/index.md" — the agent should be able to read it successfully.

3. Ask the agent a question about OpenClaw configuration — it should reference local docs rather than saying it can't find them.
