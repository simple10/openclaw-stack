# Plan: Config-driven sandbox toolkit with auto-shimming

## Context

Skill binaries (gifgrep, ffmpeg, claude-code, etc.) are currently scattered across the entrypoint as hardcoded installs and manual shims. The PACKAGES string for apt-get is hardcoded on entrypoint line 211. The claude sandbox is a separate image build that just adds `npm install -g @anthropic-ai/claude-code` on top of common.

**Goal**: A single YAML config file (`deploy/sandbox-toolkit.yaml`) that declares all sandbox capabilities. Build scripts read it, install everything into sandbox-common (the one workhorse image), and auto-generate gateway shims. Adding a new binary = edit YAML + rebuild.

## Config format: `deploy/sandbox-toolkit.yaml`

```yaml
# Apt packages installed in sandbox-common image.
# These are system-level dependencies — compilers, libraries, CLI tools.
packages:
  - curl
  - wget
  - jq
  - coreutils
  - grep
  - git
  - ca-certificates
  - python3
  - nodejs
  - npm
  - golang-go
  - rustc
  - cargo
  - ffmpeg
  - imagemagick
  - unzip
  - pkg-config
  - libasound2-dev
  - build-essential
  - file

# Tools installed via custom scripts. Each tool:
#   install  — shell command run as root in sandbox-common (optional; omit if bins come from apt)
#   version  — substituted as ${VERSION} in install script (optional)
#   bins     — binary names this tool provides (default: [tool name])
#
# Every binary listed in bins gets auto-shimmed on the gateway.
# Tools without install are "capability declarations" — their bins come from apt
# but need explicit names for gateway shimming (e.g. imagemagick → convert).
tools:
  # gifgrep:
  #   version: "0.2.1"
  #   install: >-
  #     curl -sfL https://github.com/steipete/gifgrep/releases/download/v${VERSION}/gifgrep_${VERSION}_linux_amd64.tar.gz
  #     | tar xz -C ${BIN_DIR} gifgrep

  gifgrep:
    install: brew install steipete/tap/gifgrep

  claude-code:
    install: npm install -g @anthropic-ai/claude-code
    bins: [claude]

  codex:
    install: npm i -g @openai/codex

  opencode:
    install: npm install -g opencode-ai

  amp:
    install: curl -fsSL https://ampcode.com/install.sh | bash

  ffmpeg:
    bins: [ffmpeg, ffprobe]

  imagemagick:
    bins: [magick, convert, identify, mogrify]
```

### Design rules

1. **`packages`** → passed to `apt-get install -y` in sandbox-common build. Replaces the hardcoded PACKAGES string in entrypoint line 211.

2. **`tools`** — each entry is a named capability:
   - `install` (optional): shell script run as root in sandbox-common after apt. Supports `${VERSION}` and `${BIN_DIR}` interpolation.
   - `bins` (optional): list of binaries this tool provides. Defaults to `[toolName]` (e.g. `gifgrep:` with no `bins` → `["gifgrep"]`).
   - `version` (optional): substituted into `${VERSION}`.
   - Tools WITHOUT `install` (ffmpeg, imagemagick) are capability declarations — their binaries come from apt but need explicit bin lists since package name ≠ binary name.

3. **Auto-shimming**: collect all `bins` across all tools → generate gateway shims in `/opt/skill-bins/`. No manual shim management.

4. **Any package manager** works via `install` — npm, pip, brew, go, cargo, curl/tar:

   ```yaml
   some-python-tool:
     install: pip install some-tool==${VERSION}
     version: "1.0.0"
     bins: [some-tool]
   ```

## Image simplification

**Before**: base → common → claude (3 builds, 2 workhorse images)
**After**: base → common (2 builds, 1 workhorse image)

claude-code becomes a `tools` entry. The claude sandbox build step in entrypoint §2 is removed entirely.

Code agent in `openclaw.json` switches from `openclaw-sandbox-claude:bookworm-slim` to `openclaw-sandbox-common:bookworm-slim`.

Browser sandbox stays separate (Chromium is heavy, optional).

## Build flow changes

### Entrypoint §1g — gateway shim generation (reads config)

```
1. Parse sandbox-toolkit.yaml (via Node.js helper — gateway has Node available)
2. mkdir -p /opt/skill-bins
3. For each tool, for each bin in tool.bins (default [name]):
     Generate shim script in /opt/skill-bins/<bin>
4. export PATH="/opt/skill-bins:$PATH"
```

### Entrypoint §2 — sandbox-common build (reads config)

```
1. Parse sandbox-toolkit.yaml
2. Build rooted intermediate (existing step)
3. Join packages list → pass as PACKAGES env var to sandbox-common-setup.sh
4. NEW: Layer custom tool installs on top:
     Generate Dockerfile: FROM common, USER root, RUN <each tool's install>
     Build as final sandbox-common image
5. Fix USER back to 1000
6. Cleanup intermediates
```

### Entrypoint §2 — remove claude sandbox build

The entire claude sandbox build block (current lines 250-267) is removed. Its only purpose was `npm install -g @anthropic-ai/claude-code`, which is now a tools entry.

## YAML parsing in entrypoint

The gateway container has Node.js. Two options:

**Option A**: Small `deploy/parse-toolkit.mjs` helper script that reads the YAML and outputs JSON/shell-friendly values. Use `js-yaml` (check if already in OpenClaw's deps) or a minimal inline parser for our simple subset.

**Option B**: Convert YAML → JSON at deploy time (in build script or playbook), mount the JSON. Entrypoint reads JSON with `node -e "JSON.parse(...)"`.

Leaning toward Option A — keeps YAML as single source of truth, no derived files to keep in sync.

## Files to modify

| File | Change |
|------|--------|
| `deploy/sandbox-toolkit.yaml` | **New** — config file |
| `deploy/parse-toolkit.mjs` | **New** — Node.js helper to parse YAML for entrypoint |
| `deploy/entrypoint-gateway.sh` | §1g: read config, auto-generate shims. §2: read config for PACKAGES + tool installs, remove claude sandbox build |
| `deploy/openclaw.json` | Code agent: image → `openclaw-sandbox-common:bookworm-slim` |
| `deploy/docker-compose.override.yml` | Mount `sandbox-toolkit.yaml` into container |
| `playbooks/04-vps1-openclaw.md` | Update docs for config-driven approach |

## Verification

1. `cat deploy/sandbox-toolkit.yaml` — config is valid and complete
2. Entrypoint reads config and passes correct PACKAGES to sandbox-common build
3. Custom tool install scripts run in sandbox-common (gifgrep binary present, claude CLI present)
4. Gateway shims auto-generated: `ls /opt/skill-bins/` shows gifgrep, claude, ffmpeg, ffprobe, convert, identify, mogrify
5. Code agent works with sandbox-common image (has claude CLI)
6. Gifgrep delegation still works end-to-end (main → skills agent)
7. No more manual shim management in entrypoint
