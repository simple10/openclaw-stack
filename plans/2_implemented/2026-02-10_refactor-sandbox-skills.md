# Plan: Bind-mount skill-bins + add "skills" agent

## Context

Skills have a **dual requirement**: the gateway checks `requires.bins`/`anyBins` at load time (host PATH), but if the agent is sandboxed, the binary must also exist inside the container. Many skills also need network access to call external APIs.

Our main agent sandbox has `network: "none"` — so even with the binary present, API-calling skills (gifgrep, weather, etc.) would fail. Rather than loosening main agent isolation, we add a dedicated "skills" agent with network access for running skill binaries.

**Architecture after this change**:

- **main** → base sandbox, no network — conversation, delegation
- **skills** → common sandbox, bridge network — runs skill binaries (gifgrep, etc.)
- **code** → claude sandbox, bridge network — Claude Code CLI, dev tools

## Files to modify

| File | Change |
|------|--------|
| `deploy/entrypoint-gateway.sh` | Replace §1g shim-only with `/opt/skill-bins` + real binary installs |
| `deploy/openclaw.json` | Add `binds` + `env.PATH` to defaults, add skills agent, update code agent binds |
| `playbooks/04-vps1-openclaw.md` | Update tiered architecture comment, add skills agent models.json block |

## Changes

### 1. `deploy/entrypoint-gateway.sh` — section 1g

Replace the current shim-only section 1g (lines 70-81) with:

```bash
# ── 1g. Install skill binaries for sandbox availability ──────────
# Skills check bins on the gateway (load-time) AND inside the sandbox (runtime).
# /opt/skill-bins is bind-mounted read-only into all sandboxes, making
# gateway-installed binaries available without network or image rebuilds.
mkdir -p /opt/skill-bins

# gifgrep — GIF search skill
if [ ! -f /opt/skill-bins/gifgrep ]; then
  echo "[entrypoint] Installing gifgrep..."
  curl -sfL https://github.com/steipete/gifgrep/releases/download/v0.2.1/gifgrep_0.2.1_linux_amd64.tar.gz \
    | tar xz -C /opt/skill-bins gifgrep 2>/dev/null \
    && echo "[entrypoint] gifgrep installed" \
    || echo "[entrypoint] WARNING: gifgrep install failed (non-fatal)"
fi

# Coding CLI shims — coding-agent skill requires anyBins: ["claude","codex","opencode","pi"].
# Real CLIs live in the claude sandbox image. Shims satisfy the gateway preflight check.
for cli in claude codex opencode pi; do
  if [ ! -f "/opt/skill-bins/$cli" ]; then
    printf '#!/bin/sh\necho "ERROR: $0 is a shim — run inside sandbox" >&2\nexit 1\n' \
      > "/opt/skill-bins/$cli"
    chmod +x "/opt/skill-bins/$cli"
  fi
done

# Add to gateway PATH for load-time skill checks
if ! echo "$PATH" | grep -q '/opt/skill-bins'; then
  export PATH="/opt/skill-bins:$PATH"
fi
echo "[entrypoint] Skill binaries ready ($(ls /opt/skill-bins | wc -l) items)"
```

### 2. `deploy/openclaw.json` — add binds, PATH, skills agent

**a) Default sandbox docker** — add `binds` array and extend `env.PATH`:

Current `env` (line 34): `{ "LANG": "C.UTF-8" }`
New `env`: `{ "LANG": "C.UTF-8", "PATH": "/opt/skill-bins:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }`

Add after `cpus` (line 38), before closing `}`:

```json
"binds": [
  "/opt/skill-bins:/opt/skill-bins:ro"
]
```

**b) Main agent** — add "skills" to allowAgents:

Current (line 63): `"allowAgents": ["code"]`
New: `"allowAgents": ["code", "skills"]`

**c) Code agent** — add skill-bins bind mount:

Current binds (lines 77-79):

```json
"binds": [
  "/home/node/.claude-sandbox:/home/linuxbrew/.claude"
]
```

New:

```json
"binds": [
  "/home/node/.claude-sandbox:/home/linuxbrew/.claude",
  "/opt/skill-bins:/opt/skill-bins:ro"
]
```

**d) Add skills agent** after the code agent entry (after line 82):

```json
{
  "id": "skills",
  "name": "Skills Agent",
  "sandbox": {
    "docker": {
      "image": "openclaw-sandbox-common:bookworm-slim",
      "network": "bridge",
      "memory": "1g",
      "memorySwap": "2g",
      "cpus": 1
    }
  }
}
```

The skills agent inherits `binds` (including `/opt/skill-bins:ro`) and `env.PATH` from defaults, plus gets `network: "bridge"` for API access. Uses the common image (has curl, jq, node — lighter than claude image).

### 3. `playbooks/04-vps1-openclaw.md` — update comment + add skills agent models.json

**a) Update tiered architecture comment** (~line 232-236) to mention the skills agent.

**b) Add skills agent models.json block** after the code agent models.json block (~line 291):

```bash
#!/bin/bash
sudo mkdir -p /home/openclaw/.openclaw/agents/skills/agent

# SOURCE: deploy/models.json (template) → /home/openclaw/.openclaw/agents/skills/agent/models.json
# VARS: AI_GATEWAY_WORKER_URL (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/agents/skills/agent/models.json << 'JSONEOF'
# <<< deploy/models.json (template) >>>
JSONEOF

sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/skills
sudo chmod 600 /home/openclaw/.openclaw/agents/skills/agent/models.json
```

### 4. Deploy to VPS

- SCP `deploy/entrypoint-gateway.sh` to VPS
- Update `openclaw.json` on VPS (template substitution)
- Create skills agent directory + models.json
- Restart gateway

## Verification

1. Gateway starts, entrypoint logs: `Skill binaries ready (N items)`
2. `docker exec openclaw-gateway ls /opt/skill-bins/` → gifgrep, claude, codex, opencode, pi
3. Skills page: gifgrep shows **eligible**
4. `openclaw doctor` → shows 3 agents: main, code, skills
5. Chat (new session): `/gifgrep cats` → main agent delegates to skills agent → returns GIF URLs
6. Skills agent sandbox: `which gifgrep` → `/opt/skill-bins/gifgrep`
7. Skills agent sandbox: `gifgrep search --json cats` → returns results (has network)
8. Main agent sandbox: `which gifgrep` → `/opt/skill-bins/gifgrep` (binary present but no network)
