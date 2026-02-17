# Sandbox Toolkit

The sandbox toolkit defines what tools are available inside agent sandbox containers. All configuration lives in `deploy/sandbox-toolkit.yaml` — adding, updating, or removing a tool is a config edit + rebuild.

See also [SKILL-ROUTING.md](SKILL-ROUTING.md)

## How It Works

```
sandbox-toolkit.yaml  (config: packages, tools, binaries)
        │
        ├─→  entrypoint-gateway.sh    (generates gateway shims at boot)
        │
        └─→  rebuild-sandboxes.sh     (builds sandbox images with tools baked in)
                │
                ├─→  openclaw-sandbox-common:bookworm-slim  (tools installed here)
                └─→  config hash label (auto-rebuild on config change)
```

**Gateway shims** are lightweight scripts in `/opt/skill-bins/` that satisfy the gateway's load-time binary checks. The real binaries only exist inside sandbox images. Shims are pass-through: inside a sandbox (where `/opt/skill-bins` is bind-mounted), the shim execs the real binary; on the gateway, it prints an error.

**Config change detection**: `rebuild-sandboxes.sh` stores a SHA-256 hash of the toolkit config as a Docker label on the image. On boot, it compares the current config against the stored hash and auto-rebuilds if they differ.

## Adding a Tool

1. Edit `deploy/sandbox-toolkit.yaml`
2. Run `scripts/update-sandbox-toolkit.sh`
3. Answer `y` to restart sandboxes

### Tool Entry Format

```yaml
tools:
  my-tool:
    install: <shell command run as root>    # how to install
    version: "1.2.3"                        # optional, substituted as ${VERSION}
    apt: <package-name>                     # optional, apt install instead of custom script
    bins: [binary1, binary2]                # optional, defaults to [tool-name]
```

Available variables in `install` commands:

- `${BIN_DIR}` — `/usr/local/bin` (where binaries should be placed)
- `${VERSION}` — value from the `version` field

### Install Method Examples

**apt package** — batched into a single `RUN apt-get install` layer:

```yaml
ffmpeg:
  apt: ffmpeg
  bins: [ffmpeg, ffprobe]
```

**npm package**:

```yaml
claude-code:
  install: npm install -g @anthropic-ai/claude-code
  bins: [claude]
```

**Go tool** — use `GOBIN` to install directly to `BIN_DIR`:

```yaml
blogwatcher:
  install: GOBIN=${BIN_DIR} go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest
```

**Binary download** — curl + tar to `BIN_DIR`:

```yaml
gifgrep:
  version: "0.2.1"
  install: >-
    curl -sfL https://github.com/steipete/gifgrep/releases/download/v${VERSION}/gifgrep_${VERSION}_linux_amd64.tar.gz
    | tar xz -C ${BIN_DIR} gifgrep
```

**Brew formula** — brew runs as `linuxbrew` user, symlink to `BIN_DIR`:

```yaml
gh:
  install: >-
    su -s /bin/bash linuxbrew -c 'HOMEBREW_NO_AUTO_UPDATE=1 /home/linuxbrew/.linuxbrew/bin/brew install gh'
    && ln -sf /home/linuxbrew/.linuxbrew/bin/gh ${BIN_DIR}/
```

**Python tool via uv** — requires `uv` to be installed first (order matters in YAML):

```yaml
nano-pdf:
  install: UV_TOOL_BIN_DIR=${BIN_DIR} UV_TOOL_DIR=/opt/uv-tools uv tool install nano-pdf
```

### System Packages

The `packages` list at the top of `sandbox-toolkit.yaml` defines apt packages installed as part of the base sandbox-common image (compilers, libraries, system tools). These are separate from tool-specific `apt` entries.

```yaml
packages:
  - curl
  - python3
  - build-essential
  # ...
```

## Scripts

### `scripts/update-sandbox-toolkit.sh`

Full update cycle: sync config to VPS, regenerate shims, rebuild images, optionally restart sandboxes.

```bash
scripts/update-sandbox-toolkit.sh              # sync + rebuild + prompt to restart
scripts/update-sandbox-toolkit.sh --all        # also rebuild browser sandbox image
scripts/update-sandbox-toolkit.sh --sync-only  # sync files + shims only, skip rebuild
scripts/update-sandbox-toolkit.sh --dry-run    # preview without executing
```

Steps:

1. Syncs `sandbox-toolkit.yaml`, `parse-toolkit.mjs`, and `rebuild-sandboxes.sh` to VPS
2. Regenerates `/opt/skill-bins/` shims inside the gateway (new binaries only, idempotent)
3. Runs `rebuild-sandboxes.sh --force` inside the gateway container
4. Prompts to restart sandbox containers

### `scripts/restart-sandboxes.sh`

Removes sandbox containers so OpenClaw recreates them from current images on the next agent request. Uses `docker stop` for graceful shutdown, then `openclaw sandbox recreate` to clean containers and the internal registry.

```bash
scripts/restart-sandboxes.sh              # restart agent sandboxes (with confirmation)
scripts/restart-sandboxes.sh --all        # also restart browser sandboxes
scripts/restart-sandboxes.sh --force      # skip confirmation prompt
scripts/restart-sandboxes.sh --dry-run    # preview without executing
```

### `scripts/update-sandboxes.sh`

Force-rebuilds sandbox images without syncing config files. Use when you want to rebuild for security patches or dependency updates without changing the toolkit config.

```bash
scripts/update-sandboxes.sh               # rebuild common image
scripts/update-sandboxes.sh --all         # also rebuild browser image
scripts/update-sandboxes.sh --dry-run     # preview
```

## Common Workflows

### Add a new tool

```bash
# 1. Edit the config
vim deploy/sandbox-toolkit.yaml

# 2. Sync, rebuild, and restart
scripts/update-sandbox-toolkit.sh
# Answer 'y' to restart sandboxes
```

### Update an existing tool version

```bash
# 1. Change the version field in sandbox-toolkit.yaml
# 2. Sync and rebuild
scripts/update-sandbox-toolkit.sh
```

### Rebuild for security patches (no config change)

```bash
# Force-rebuild images with latest base packages
scripts/update-sandboxes.sh

# Restart sandboxes to use the new images
scripts/restart-sandboxes.sh
```

### Sync config without rebuilding

Useful when editing `parse-toolkit.mjs` or `rebuild-sandboxes.sh` itself:

```bash
scripts/update-sandbox-toolkit.sh --sync-only
```

### Verify a tool is available

```bash
# Check shim exists on gateway
ssh -p 222 adminclaw@<VPS_IP> "openclaw exec which codex"

# Check real binary in sandbox
ssh -p 222 adminclaw@<VPS_IP> \
  "sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim codex --version"
```

## Architecture Notes

### Image Layers

```
openclaw-sandbox:bookworm-slim          (base: Debian + sandbox user)
  └─→ openclaw-sandbox-common:bookworm-slim  (+ packages + tools from toolkit)
        └─→ openclaw-sandbox-browser:bookworm-slim  (+ Chrome + noVNC)
```

### Sandbox Container Lifecycle

Sandbox containers are **persistent per-agent** (`scope: "agent"` in `openclaw.json`). They are reused across requests and pruned after 7 days idle (`prune.idleHours: 168`). After rebuilding images, running containers still use the old image until restarted via `restart-sandboxes.sh`.

### Files

| File | Location | Purpose |
|------|----------|---------|
| `deploy/sandbox-toolkit.yaml` | Config | Tool definitions, packages, binaries |
| `deploy/parse-toolkit.mjs` | Parser | YAML → JSON for entrypoint/builder |
| `deploy/rebuild-sandboxes.sh` | Builder | Image build logic with config detection |
| `deploy/entrypoint-gateway.sh` | Entrypoint | Shim generation (section 1g) |
| `deploy/docker-compose.override.yml` | Compose | Bind mounts (lines 48-52) |

### Gotchas

- **arm64-only brew formulas** fail on the amd64 VPS. Check architecture compatibility before adding brew tools.
- **Tool install order matters** — tools are installed sequentially as written. If tool B depends on tool A (e.g., `nano-pdf` needs `uv`), A must appear first.
- **Brew runs as `linuxbrew`** not root — use `su -s /bin/bash linuxbrew -c '...'` and symlink binaries to `${BIN_DIR}`.
- **`sandbox-toolkit.yaml` is bind-mounted read-only** — changes on the VPS host are immediately visible inside the container (no restart needed for the config file itself, but images need rebuilding).
- **Staleness warnings** appear in gateway logs when images are older than 30 days.
