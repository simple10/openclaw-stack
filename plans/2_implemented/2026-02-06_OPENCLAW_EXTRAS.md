# Plan: Add OpenClaw Extras (Browser, Rich Sandbox, Gateway Apt Packages)

## Context

The current OpenClaw gateway on VPS-1 runs with a minimal sandbox image (`openclaw-sandbox:bookworm-slim`) that lacks Node.js and common dev tools. Browser support is not configured. The gateway image itself has no extra apt packages (e.g., ffmpeg for media processing). This plan adds all three extras as a new playbook under `playbooks/extras/`.

## What We're Adding

1. **Browser sandbox** — Chromium + noVNC for web browsing tasks, viewable through the Control UI
2. **Common sandbox image** — Pre-built image with Node.js, git, and dev tools (replaces the minimal default)
3. **Gateway apt packages** — `ffmpeg`, `build-essential`, and `imagemagick` baked into the gateway Docker image at build time
4. **Claude Code CLI** — `@anthropic-ai/claude-code` installed globally in the gateway image so agents can use it as a coding tool
5. **Fix openclaw.json permissions** — Ensure `chmod 600` on every startup via entrypoint (security audit CRITICAL fix)

## Files to Modify

### 1. `scripts/build-openclaw.sh` — Add `--build-arg` and Claude Code patch

The build script now has 3 existing patches (Dockerfile deps, OTEL v2.x, diagnostic events dual-bundle). Two changes needed:

**a) Line 90** — Change `docker build` (section 4) to pass apt packages:

```bash
# Current:
docker build -t openclaw:local .

# New:
docker build \
  ${OPENCLAW_DOCKER_APT_PACKAGES:+--build-arg OPENCLAW_DOCKER_APT_PACKAGES="$OPENCLAW_DOCKER_APT_PACKAGES"} \
  -t openclaw:local .
```

The upstream Dockerfile already has an `ARG OPENCLAW_DOCKER_APT_PACKAGES` and conditional install. This just passes it through.

**b) Add new patch #4** (before the build step) — Install Claude Code CLI globally in the gateway image:

```bash
# ── 4. Patch Dockerfile to install Claude Code CLI ────────────────────
if ! grep -q "@anthropic-ai/claude-code" Dockerfile; then
  echo "[build] Patching Dockerfile to install Claude Code CLI..."
  sed -i '/^CMD /i RUN npm install -g @anthropic-ai/claude-code' Dockerfile
else
  echo "[build] Claude Code CLI already in Dockerfile (already patched)"
fi
```

Renumber existing sections: build becomes #5, restore becomes #6. The `claude` binary will be available on PATH for agents to invoke.

### 2. `playbooks/04-vps1-openclaw.md` — Update 4 sections

**Section 4.5 (.env)** — Add line:

```bash
OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential imagemagick
```

**Section 4.6 (docker-compose.override.yml)** — Change `start_period` (line 242):

```yaml
start_period: 300s  # Extended: first boot builds 3 sandbox images inside nested Docker
```

Note: OTEL env vars are now hardcoded in compose (lines 231-234), not referenced from .env.

**Section 4.8 (openclaw.json)** — Add `agents` and `tools` blocks to both Cloudflare Tunnel and Caddy variants (before closing `}`):

```json
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "scope": "agent",
        "docker": {
          "image": "openclaw-sandbox-common:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          "workdir": "/workspace",
          "readOnlyRoot": true,
          "tmpfs": ["/tmp", "/var/tmp", "/run"],
          "network": "none",
          "user": "1000:1000",
          "capDrop": ["ALL"],
          "env": { "LANG": "C.UTF-8" },
          "pidsLimit": 256,
          "memory": "1g",
          "memorySwap": "2g",
          "cpus": 1
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
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status"],
        "deny": ["canvas", "nodes", "cron", "discord", "gateway"]
      }
    }
  }
```

Key decisions:

- `image: "openclaw-sandbox-common:bookworm-slim"` — includes Node.js, git, dev tools pre-installed
- `network: "none"` — strict isolation (no outbound internet from sandboxes)
- `"browser"` removed from deny list so sandbox agents can use the browser tool
- `mode: "non-main"` — only sub-agents run in sandboxes, main agent unsandboxed

**Section 4.8c (entrypoint)** — Three additions:

**a) Add chmod fix at the top** (after lock file cleanup, before Docker daemon wait). The gateway rewrites `openclaw.json` on config changes without preserving 600 permissions, causing the security audit to flag it as CRITICAL:

```bash
# ── 1b. Fix openclaw.json permissions (security audit CRITICAL) ───────
# The gateway may rewrite this file with looser permissions on config changes
config_file="/home/node/.openclaw/openclaw.json"
if [ -f "$config_file" ]; then
  current_perms=$(stat -c '%a' "$config_file" 2>/dev/null || stat -f '%Lp' "$config_file" 2>/dev/null)
  if [ "$current_perms" != "600" ]; then
    chmod 600 "$config_file"
    echo "[entrypoint] Fixed openclaw.json permissions: ${current_perms} -> 600"
  fi
fi
```

**b) Add common + browser image bootstrap** after existing sandbox block (before "Exec the command"):

```bash
  # Build common sandbox image if missing (includes Node.js, git, common tools)
  if ! docker image inspect openclaw-sandbox-common:bookworm-slim > /dev/null 2>&1; then
    echo "[entrypoint] Common sandbox image not found, building..."
    if [ -f /app/scripts/sandbox-common-setup.sh ]; then
      /app/scripts/sandbox-common-setup.sh
      echo "[entrypoint] Common sandbox image built successfully"
    else
      echo "[entrypoint] WARNING: sandbox-common-setup.sh not found, skipping"
    fi
  else
    echo "[entrypoint] Common sandbox image already exists"
  fi

  # Build browser sandbox image if missing (includes Chromium, noVNC)
  if ! docker image inspect openclaw-sandbox-browser:bookworm-slim > /dev/null 2>&1; then
    echo "[entrypoint] Browser sandbox image not found, building..."
    if [ -f /app/scripts/sandbox-browser-setup.sh ]; then
      /app/scripts/sandbox-browser-setup.sh
      echo "[entrypoint] Browser sandbox image built successfully"
    else
      echo "[entrypoint] WARNING: sandbox-browser-setup.sh not found, skipping"
    fi
  else
    echo "[entrypoint] Browser sandbox image already exists"
  fi
```

### 3. New file: `playbooks/extras/sandbox-and-browser.md`

Standalone extras playbook with sections:

- E.1: Update `.env` with `OPENCLAW_DOCKER_APT_PACKAGES`
- E.2: Deploy updated build script (adds patch #4 for Claude Code + `--build-arg` for apt packages), rebuild gateway image
- E.3: Deploy updated entrypoint with common + browser bootstrap
- E.4: Update `openclaw.json` with agents/sandbox/browser/tools config
- E.5: Update `docker-compose.override.yml` start_period
- E.6: Restart gateway, monitor first boot (3-5 min for image builds)
- Verification and troubleshooting sections

### 4. `playbooks/extras/README.md` — Register the new playbook

### 5. `CLAUDE.md` — Add to playbook table + key deployment notes 21-24

## No New Ports or Volumes Needed

Browser sandboxes run inside the Sysbox nested Docker daemon. The gateway proxies noVNC through its own port (18789). No additional ports, volumes, or networks needed in docker-compose.

## Disk Space Impact

- `openclaw-sandbox-common` ~500MB (inside nested Docker)
- `openclaw-sandbox-browser` ~800MB (inside nested Docker)
- `ffmpeg` + `build-essential` + `imagemagick` ~350MB (in gateway image)
- Claude Code CLI ~100MB (npm global install in gateway image)
- **Total: ~1.75GB additional** — check `df -h` on VPS-1 before proceeding

## Implementation Order

1. Check VPS-1 disk space
2. Update `scripts/build-openclaw.sh` (add `--build-arg`)
3. Update playbook 04 sections (4.5, 4.6, 4.8, 4.8c)
4. Create `playbooks/extras/sandbox-and-browser.md`
5. Update `playbooks/extras/README.md` and `CLAUDE.md`
6. Deploy to VPS-1: update .env, rebuild image, deploy entrypoint, update openclaw.json, restart
7. Monitor first boot, verify all 3 nested images built
8. Test sandbox + browser functionality

## Verification

1. `sudo docker exec openclaw-gateway docker images` — should show all 3 sandbox images
2. `sudo docker logs openclaw-gateway 2>&1 | grep -i sandbox` — confirm bootstrap logs
3. Send a coding task through the gateway — verify sandbox execution
4. Send a web browsing task — verify browser launches, noVNC accessible via Control UI
5. `sudo docker exec openclaw-gateway which ffmpeg` — confirm gateway apt packages installed
6. `sudo docker exec openclaw-gateway which convert` — confirm imagemagick installed
7. `sudo docker exec openclaw-gateway claude --version` — confirm Claude Code CLI installed
8. `sudo docker exec openclaw-gateway stat -c '%a' /home/node/.openclaw/openclaw.json` — should return `600`
