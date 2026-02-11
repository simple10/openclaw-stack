---
name: debug-logger
description: "Log all gateway events (command, agent, gateway) to a debug audit file"
metadata:
  {
    "openclaw":
      {
        "emoji": "\uD83D\uDC1B",
        "events": ["command", "agent", "gateway"],
        "install": [{ "id": "managed", "kind": "managed", "label": "Managed hook" }],
      },
  }
---

# Debug Logger Hook

Logs **all** gateway events (command, agent, gateway) to a single audit file for debugging and monitoring.

## What It Does

Every time an event fires in the gateway:

1. **Captures full event details** - Type, action, timestamp, session key, and context
2. **Appends to log file** - Writes a JSON line to `~/.openclaw/logs/debug.log`
3. **Silent operation** - Runs in the background without user notifications

## Output Format

Log entries are written in JSONL (JSON Lines) format:

```json
{"timestamp":"2026-01-16T14:30:00.000Z","type":"command","action":"new","sessionKey":"agent:main:main","context":{"senderId":"+1234567890","commandSource":"telegram"}}
{"timestamp":"2026-01-16T15:00:00.000Z","type":"gateway","action":"startup","sessionKey":"","context":{"workspaceDir":"/home/node/.openclaw/workspace"}}
{"timestamp":"2026-01-16T15:00:01.000Z","type":"agent","action":"bootstrap","sessionKey":"agent:main:main","context":{"agentId":"main"}}
```

## Log File Location

`~/.openclaw/logs/debug.log`

## Requirements

No requirements - this hook works out of the box on all platforms.

## Disabling

```bash
openclaw hooks disable debug-logger
```
