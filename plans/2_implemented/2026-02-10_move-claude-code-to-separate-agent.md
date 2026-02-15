# Plan: Create a "code" agent with dedicated sandbox

## Context

The `coding-agent` skill is blocked because it requires `anyBins: ["claude", "codex", "opencode", "pi"]` — none of which exist on the gateway. They're installed in the sandbox image (`openclaw-sandbox-claude:bookworm-slim`). The skill check runs on the gateway, not inside sandboxes.

Currently, the "main" agent uses the heaviest sandbox image (`openclaw-sandbox-claude`) for ALL tool execution, even simple reads/writes. The TODO envisions a tiered approach:

- **main** agent → base sandbox (lightweight, no network)
- **code** agent → claude sandbox (Claude Code CLI, network access)
- (future) **build** agent → common sandbox (dev tools, compilers)

## Architecture

### Agent definitions in `openclaw.json`

```
agents.defaults.sandbox → base sandbox (openclaw-sandbox:bookworm-slim), network: "none"
agents.list[0] "main"   → uses defaults, default: true
agents.list[1] "code"   → overrides sandbox to claude image, network: "bridge"
```

### How messages reach the "code" agent

Two options:

**A) Sub-agent spawning (recommended)** — main agent receives all messages and delegates coding tasks to the code agent via `sessions_spawn`. The main agent keeps the coding-agent skill (via a shim), sees the instructions, and knows to spawn the code agent.

**B) Binding-based routing** — route a specific channel/peer directly to the code agent. Less flexible — the code agent only handles messages from that binding.

### Unblocking the coding-agent skill

The `anyBins` check runs on the gateway filesystem. Options:

1. **Gateway shim** (simplest) — create `/usr/local/bin/claude` on the gateway as a tiny stub that satisfies the check. Real execution happens in the sandbox.
2. **Workspace skill override** — place a modified `coding-agent/SKILL.md` (with `requires` removed) in the code agent's workspace. Workspace skills override bundled skills per-agent.

Option 1 is simpler and makes the skill available to all agents. Option 2 is cleaner (no fake binary) but only the code agent sees the skill.

## Changes to `playbooks/04-vps1-openclaw.md`

### 1. openclaw.json — restructure agents section (~line 400)

```jsonc
"agents": {
  "defaults": {
    "sandbox": {
      "mode": "all",
      "scope": "agent",
      "docker": {
        "image": "openclaw-sandbox:bookworm-slim",   // <- was claude image
        "containerPrefix": "openclaw-sbx-",
        "workdir": "/workspace",
        "readOnlyRoot": true,
        "tmpfs": ["/tmp", "/var/tmp", "/run"],        // <- removed linuxbrew tmpfs
        "network": "none",                            // <- was "bridge"
        "user": "1000:1000",
        "capDrop": ["ALL"],
        "env": { "LANG": "C.UTF-8" },
        "pidsLimit": 256,
        "memory": "1g",
        "memorySwap": "2g",
        "cpus": 1
        // no binds — base sandbox doesn't need claude creds
      },
      "browser": {
        // ... unchanged
      },
      "prune": {
        "idleHours": 168,
        "maxAgeDays": 60
      }
    }
  },
  "list": [
    {
      "id": "main",
      "default": true,
      "subagents": {
        "allowAgents": ["code"]
      }
    },
    {
      "id": "code",
      "name": "Code Agent",
      "sandbox": {
        "docker": {
          "image": "openclaw-sandbox-claude:bookworm-slim",
          "tmpfs": ["/tmp", "/var/tmp", "/run", "/home/linuxbrew:uid=1000,gid=1000"],
          "network": "bridge",
          "memory": "2g",
          "memorySwap": "4g",
          "cpus": 4,
          "binds": [
            "/home/node/.claude-sandbox:/home/linuxbrew/.claude"
          ]
        }
      }
    }
  ]
}
```

Key differences between main and code:

- **image**: base vs claude (has Claude Code CLI)
- **network**: `"none"` vs `"bridge"` (code agent needs git, npm, pip)
- **resources**: code agent gets more memory/CPU for running coding CLIs
- **binds**: only code agent mounts Claude credentials
- **tmpfs**: only code agent needs writable `/home/linuxbrew`

### 2. Agent directory + models.json for code agent (~line 471)

```bash
sudo mkdir -p /home/openclaw/.openclaw/agents/code/agent
sudo tee /home/openclaw/.openclaw/agents/code/agent/models.json << 'JSONEOF'
{
  "providers": {
    "anthropic": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>"
    },
    "openai": {
      "baseUrl": "<AI_GATEWAY_WORKER_URL>/v1"
    }
  }
}
JSONEOF
sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/code
sudo chmod 600 /home/openclaw/.openclaw/agents/code/agent/models.json
```

### 3. Gateway shim for skill check — entrypoint section 1g

Add after section 1f (npm prefix):

```bash
# ── 1g. Create coding CLI shims for skill eligibility ────────────
# The coding-agent skill requires anyBins: ["claude", "codex", "opencode", "pi"].
# These CLIs live in sandbox containers, not the gateway. Shims satisfy the
# preflight check — actual execution happens inside the sandbox.
for cli in claude codex opencode pi; do
  if [ ! -f "/usr/local/bin/$cli" ]; then
    printf '#!/bin/sh\necho "ERROR: $0 is a shim — run inside sandbox" >&2\nexit 1\n' \
      > "/usr/local/bin/$cli"
    chmod +x "/usr/local/bin/$cli"
  fi
done
echo "[entrypoint] Coding CLI shims created"
```

### 4. Apply live on VPS

After updating the playbook, apply the same changes to the running deployment:

- Update openclaw.json via SSH
- Update entrypoint-gateway.sh via SSH
- Create code agent directory + models.json
- Restart gateway

## Verification

1. Gateway starts without errors
2. `openclaw doctor --deep` passes
3. Skills page shows `coding-agent` as **eligible** (not blocked)
4. Main agent can spawn code agent via sessions_spawn
5. Code agent's bash tool runs in claude sandbox (verify with `which claude` in sandbox)
6. Main agent's bash tool runs in base sandbox (verify with `which claude` fails / network unreachable)
