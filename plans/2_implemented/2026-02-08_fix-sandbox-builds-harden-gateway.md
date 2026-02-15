# Plan: Minimal Gateway + Tool-Rich Sandboxes

## Context

With `sandbox.mode: "all"`, all agents run exclusively in sandbox containers, never in the gateway. But `OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"` installs these tools into the **gateway** image where agents can't access them. This is why ffmpeg failed during deployment, and having `build-essential` (compilers) in the gateway is unnecessary attack surface.

**Goal:** Strip the gateway to the minimum needed (Node.js + docker.io + gosu), move all agent tools (ffmpeg, imagemagick, Claude Code CLI) into the claude sandbox image where agents actually run.

## Changes

### 1. Update build script — remove Claude Code CLI patch and `OPENCLAW_DOCKER_APT_PACKAGES`

**Files:** `build/build-openclaw.sh`, `playbooks/04-vps1-openclaw.md` (section 4.8a)

Both contain identical build script content. Changes to both:

- **Remove** patch #1 (Claude Code CLI `sed` insert) — CLI moves to sandbox only
- **Remove** `${OPENCLAW_DOCKER_APT_PACKAGES:+--build-arg ...}` from `docker build` command
- **Renumber** Docker+gosu patch from #2 to #1
- **Simplify** build command to just `docker build -t openclaw:local .`
- **Update** header comment: "1 patch" instead of "2 patches"

After changes, `build/build-openclaw.sh`:

```bash
#!/bin/bash
# Build OpenClaw with auto-patching.
#
# Patches applied (each auto-skips when upstream fixes the issue):
#   1. Dockerfile: install Docker + gosu for nested Docker (sandbox isolation via Sysbox)
#
# Usage: sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
set -euo pipefail

cd /home/openclaw/openclaw

# ── 1. Patch Dockerfile to install Docker + gosu (nested Docker for sandboxes) ──
# ... (existing patch #2 content, renumbered)

# ── 2. Build image ───────────────────────────────────────────────────
echo "[build] Building openclaw:local..."
docker build -t openclaw:local .

# ── 3. Restore patched files (keep git working tree clean) ───────────
git checkout -- Dockerfile 2>/dev/null || true

echo "[build] Done. Run: docker compose up -d openclaw-gateway"
```

### 2. Update entrypoint — add ffmpeg + imagemagick to claude sandbox build

**Files:** `playbooks/04-vps1-openclaw.md` (section 4.8c), `playbooks/extras/sandbox-and-browser.md` (section E.3)

Change the claude sandbox `printf | docker build` line in both files from:

```bash
printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' | docker build -t openclaw-sandbox-claude:bookworm-slim -
```

To:

```bash
printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg imagemagick && rm -rf /var/lib/apt/lists/*\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' | docker build -t openclaw-sandbox-claude:bookworm-slim -
```

Update the comment above this block:

```bash
# Build claude sandbox image if missing (layered on common with media tools + Claude Code CLI)
# Adds ffmpeg, imagemagick, and claude CLI — common sandbox stays clean
```

Note: `build-essential` is already in `openclaw-sandbox-common` (installed by upstream `sandbox-common-setup.sh`), so it doesn't need to be added here.

### 3. Remove `OPENCLAW_DOCKER_APT_PACKAGES` from .env creation

**File:** `playbooks/04-vps1-openclaw.md` (section 4.5)

Remove this line from the `.env` heredoc:

```bash
OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential imagemagick"
```

### 4. Update build-time patches reference

**File:** `playbooks/04-vps1-openclaw.md` (section 4.8b)

Rewrite to reflect only one remaining patch (Docker + gosu). Remove Claude Code CLI and `OPENCLAW_DOCKER_APT_PACKAGES` descriptions.

### 5. Update extras playbook

**File:** `playbooks/extras/sandbox-and-browser.md`

- **Section E.1** — Remove the `OPENCLAW_DOCKER_APT_PACKAGES` append to .env (no longer needed)
- **Section E.2** — Remove "Patch #4: Claude Code CLI" and `--build-arg` references. Keep Docker+gosu patch.
- **Section E.3** — Apply same entrypoint change as #2 above
- **Verification section** — Replace "Gateway Packages" checks (ffmpeg/gcc/convert in gateway) with "Claude Sandbox Tools" checks (ffmpeg/convert/claude in sandbox). Add check that claude is NOT in gateway.
- **Overview/description** — Change "gateway apt packages (ffmpeg, imagemagick)" to note these are now in the claude sandbox
- **Disk Space Check** — Remove "Gateway apt packages: ~350MB" and "Claude Code CLI: ~100MB". Update claude sandbox estimate.

### 6. Update extras README

**File:** `playbooks/extras/README.md` (line 27)

Change:

```
Rich sandbox (Node.js, git, dev tools), browser (Chromium + noVNC), gateway apt packages (ffmpeg, imagemagick), Claude Code CLI
```

To:

```
Rich sandbox (Node.js, git, dev tools, ffmpeg, imagemagick, Claude Code CLI), browser (Chromium + noVNC)
```

### 7. Update REQUIREMENTS.md

**File:** `REQUIREMENTS.md`

- **Section 3.5** (entrypoint) — Update claude sandbox description to mention ffmpeg + imagemagick
- **Section 3.6** (build process) — Remove patch #1 (Claude Code CLI), remove `OPENCLAW_DOCKER_APT_PACKAGES` build-arg docs. Only 1 patch remains.
- **Section 3.14** (.env) — Remove `OPENCLAW_DOCKER_APT_PACKAGES` from variables table
- **Section 3.8** (sandbox images table) — Update claude sandbox description: "Common + ffmpeg + imagemagick + Claude Code CLI"
- **Gotchas section** — Change "Only 2 patches remain" to "Only 1 patch remains"

### 8. Update MEMORY.md

**File:** `memory/MEMORY.md`

- "Only 1 patch remains" (Docker + gosu only)
- Remove Claude Code CLI from gateway patches list
- Add note: "ffmpeg, imagemagick, Claude Code CLI are in claude sandbox image, not gateway"
- Remove `OPENCLAW_DOCKER_APT_PACKAGES` reference

### 9. Fix `scripts/claude-sandbox.sh` to run claude in sandbox, not gateway

**File:** `scripts/claude-sandbox.sh`

Currently runs `docker exec -it $GATEWAY claude` which executes claude directly in the gateway container. With Claude Code CLI removed from the gateway, this must instead start a claude sandbox container inside the gateway's nested Docker.

Change the ssh command from:

```bash
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -t "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it $GATEWAY claude"
```

To:

```bash
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" -t "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it $GATEWAY docker run --rm -it \
    -v /home/node/.claude-sandbox:/home/linuxbrew/.claude \
    --tmpfs /home/linuxbrew:uid=1000,gid=1000 \
    --tmpfs /tmp \
    -u 1000:1000 \
    openclaw-sandbox-claude:bookworm-slim claude"
```

This:

- Runs a fresh claude sandbox container inside the gateway's nested Docker
- Mounts `.claude-sandbox` credentials so auth persists
- Uses tmpfs for home dir (writable, matches openclaw.json sandbox config)
- Runs as uid 1000 (sandbox user)
- `--rm` cleans up the container when claude exits

Also update the script comment/description and remove the TODO.

## Files Modified

| File | What Changes |
|------|-------------|
| `build/build-openclaw.sh` | Remove CLI patch, remove `--build-arg`, renumber |
| `playbooks/04-vps1-openclaw.md` | Sections 4.5, 4.8a, 4.8b, 4.8c |
| `playbooks/extras/sandbox-and-browser.md` | Sections E.1, E.2, E.3, verification, overview |
| `playbooks/extras/README.md` | Description update |
| `scripts/claude-sandbox.sh` | Run claude in sandbox container, not gateway |
| `REQUIREMENTS.md` | Sections 3.5, 3.6, 3.8, 3.14, gotchas |
| `memory/MEMORY.md` | Build architecture notes |

## Verification

After implementation, verify:

1. **build/build-openclaw.sh** — Only 1 patch (Docker+gosu), no `--build-arg`, no Claude Code CLI patch
2. **Section 4.5** — No `OPENCLAW_DOCKER_APT_PACKAGES` in .env
3. **Section 4.8a** — Build script matches `build/build-openclaw.sh`
4. **Section 4.8c** — Claude sandbox build includes `apt-get install ffmpeg imagemagick` before `npm install -g claude-code`
5. **Extras E.3** — Same claude sandbox build change applied
6. **Extras verification** — Checks ffmpeg/imagemagick/claude in sandbox, NOT in gateway
7. **scripts/claude-sandbox.sh** — Runs `docker run` inside gateway, not `claude` directly
8. **REQUIREMENTS.md** — Consistent with all playbook changes
