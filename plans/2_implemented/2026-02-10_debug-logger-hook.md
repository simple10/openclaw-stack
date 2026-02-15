# Plan: Create `debug-logger` Hook

## Context

The command-logger hook only captures command events (`/new`, `/stop`, `/reset`). We need a broader hook called `debug-logger` that logs **all** gateway events (command, agent, gateway) to a single audit file for debugging and monitoring.

## Hook Files

Create two files in `deploy/hooks/debug-logger/`:

### 1. `deploy/hooks/debug-logger/HOOK.md`

YAML frontmatter with:

- `name: debug-logger`
- `events: ["command", "agent", "gateway"]` — captures all event types
- Emoji: `🐛`

### 2. `deploy/hooks/debug-logger/handler.js`

ESM module (plain JS, not TS — avoids needing a TypeScript loader for custom hooks). Default export function that:

- Accepts all event types (no type filtering)
- Logs to `~/.openclaw/logs/debug.log` (JSONL format)
- Includes: `timestamp`, `type`, `action`, `sessionKey`, and serialized `context` (keys + safe values)
- Creates log directory if missing
- Catches errors silently (matches command-logger pattern)
- Uses `resolveStateDir` imported from the gateway's compiled paths module

### Log entry format

```json
{"timestamp":"...","type":"command","action":"new","sessionKey":"agent:main:main","context":{"senderId":"...","commandSource":"webchat"}}
{"timestamp":"...","type":"gateway","action":"startup","sessionKey":"","context":{"workspaceDir":"/home/node/.openclaw/workspace"}}
{"timestamp":"...","type":"agent","action":"bootstrap","sessionKey":"agent:main:main","context":{"agentId":"main","workspaceDir":"..."}}
```

## Deployment

1. SCP the two files to VPS at `/home/openclaw/.openclaw/hooks/debug-logger/` (the "managed hooks" directory — persists across container restarts via bind mount)
2. Enable: `openclaw hooks enable debug-logger`
3. Restart gateway to pick up the new hook

## Verification

1. `openclaw hooks list` — should show `debug-logger` as `✓ ready` from source `managed`
2. Send a `/new` command via webchat
3. Check `cat ~/.openclaw/logs/debug.log` inside the container — should have entries
4. Check gateway logs for `Registered hook: debug-logger -> command, agent, gateway`
