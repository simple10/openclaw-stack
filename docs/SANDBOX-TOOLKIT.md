# Sandbox Toolkit

The sandbox toolkit defines what tools are available inside agent sandbox containers. All configuration lives in `openclaw/default/sandbox-toolkit.yaml` — adding, updating, or removing a tool is a config edit + rebuild.

See also [deploy/openclaw-stack/plugins/coordinator/README.md](../deploy/openclaw-stack/plugins/coordinator/README.md) for agent routing details.

## How It Works

```
sandbox-toolkit.yaml  (config: packages, tools, binaries)
        │
        ├─→  entrypoint.sh            (generates gateway shims at boot)
        │
        └─→  rebuild-sandboxes.sh     (builds sandbox images with tools baked in)
                │
                ├─→  openclaw-sandbox-packages:bookworm-slim  (apt + brew + bun + pnpm)
                ├─→  openclaw-sandbox-toolkit:bookworm-slim   (tool installs layered on top)
                └─→  split config hashes (packages vs tools — auto-rebuild on change)
```

**Gateway shims** are lightweight scripts in `/opt/skill-bins/` that satisfy the gateway's load-time binary checks. The real binaries only exist inside sandbox images. Shims are pass-through: inside a sandbox (where `/opt/skill-bins` is bind-mounted), the shim execs the real binary; on the gateway, it prints an error.

**Config change detection**: `rebuild-sandboxes.sh` stores separate SHA-256 hashes for packages and tools as Docker labels on their respective images. On boot, it compares current config against stored hashes:
- Packages changed → rebuild packages + toolkit
- Only tools changed → skip packages, rebuild toolkit (Docker caches unchanged `RUN` layers)
- Nothing changed → staleness check only

## Adding a Tool

1. Edit `openclaw/default/sandbox-toolkit.yaml`
2. Run `scripts/update-sandbox-toolkit.sh`
3. New sandboxes automatically use the updated image

The default mode detects changed tools and quick-layers them on top of the existing toolkit image — typically completes in seconds. For a full rebuild with proper layer ordering, use `--full`.

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

**Brew formula** — just use `brew install`. The build script auto-wraps it to run as the `linuxbrew` user with `HOMEBREW_NO_AUTO_UPDATE=1`:

```yaml
gh:
  install: brew install gh
```

**Python tool via uv** — requires `uv` to be installed first (order matters in YAML):

```yaml
nano-pdf:
  install: UV_TOOL_BIN_DIR=${BIN_DIR} UV_TOOL_DIR=/opt/uv-tools uv tool install nano-pdf
```

### System Packages

The `packages` list at the top of `sandbox-toolkit.yaml` defines apt packages installed in the `sandbox-packages` image (compilers, libraries, system tools). These are separate from tool-specific `apt` entries and live in a distinct cached layer.

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
scripts/update-sandbox-toolkit.sh              # sync + detect changes + quick-layer new tools
scripts/update-sandbox-toolkit.sh --full       # sync + full rebuild of packages + toolkit layers
scripts/update-sandbox-toolkit.sh --full --all # full rebuild including browser
scripts/update-sandbox-toolkit.sh --sync-only  # sync files + shims only, skip rebuild
scripts/update-sandbox-toolkit.sh --dry-run    # preview without executing
```

Steps:

1. Syncs `sandbox-toolkit.yaml`, `parse-toolkit.mjs`, and `rebuild-sandboxes.sh` to VPS
2. Regenerates `/opt/skill-bins/` shims inside the gateway (new binaries only, idempotent)
3. Rebuilds sandbox images:
   - **Default (quick)**: detects config changes, quick-layers new/changed tools on top of existing image
   - **`--full`**: full rebuild with `--force` — rebuilds packages + toolkit with proper layer ordering
4. Prompts to restart sandbox containers (only in `--full` mode)

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
scripts/update-sandboxes.sh               # rebuild toolkit image
scripts/update-sandboxes.sh --all         # also rebuild browser image
scripts/update-sandboxes.sh --dry-run     # preview
```

## Common Workflows

### Add a new tool

```bash
# 1. Edit the config
vim openclaw/default/sandbox-toolkit.yaml

# 2. Sync and quick-layer the new tool (default — completes in seconds)
scripts/update-sandbox-toolkit.sh

# 3. New sandboxes auto-pick up the image.
#    Run scripts/restart-sandboxes.sh to update running sandboxes.
```

### Update an existing tool version

```bash
# 1. Change the version field in sandbox-toolkit.yaml
# 2. Sync and rebuild (use --full for version changes to ensure clean layers)
scripts/update-sandbox-toolkit.sh --full
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
  "sudo docker exec openclaw-stack-openclaw-main-claw docker run --rm openclaw-sandbox-toolkit:bookworm-slim codex --version"
```

## Architecture Notes

### Image Layers

```
openclaw-sandbox:bookworm-slim                     (base: Debian + sandbox user)
  └─→ openclaw-sandbox-packages:bookworm-slim      (+ apt packages + brew + bun + pnpm)
        └─→ openclaw-sandbox-toolkit:bookworm-slim  (+ tool installs from sandbox-toolkit.yaml)

openclaw-sandbox-browser:bookworm-slim             (separate chain, FROM debian:bookworm-slim)
```

The packages and toolkit layers are split for build performance:
- **Packages layer** rarely changes — only rebuilt when the `packages` array is modified
- **Toolkit layer** changes when tools are added/updated — Docker caches unchanged `RUN` instructions
- **Browser image** is a completely separate build chain from `debian:bookworm-slim`, not a child of toolkit

### Sandbox Container Lifecycle

Sandbox containers are **persistent per-agent** (`scope: "agent"` in `openclaw.json`). They are reused across requests and pruned after 7 days idle (`prune.idleHours: 168`). After rebuilding images, running containers still use the old image until restarted via `restart-sandboxes.sh`.

### Files

| File | Location | Purpose |
|------|----------|---------|
| `openclaw/default/sandbox-toolkit.yaml` | Config | Tool definitions, packages, binaries |
| `deploy/openclaw-stack/parse-toolkit.mjs` | Parser | YAML → JSON for entrypoint/builder |
| `deploy/openclaw-stack/rebuild-sandboxes.sh` | Builder | Layered image build with split config detection |
| `deploy/openclaw-stack/entrypoint.sh` | Entrypoint | Shim generation (section 1h) |
| `docker-compose.yml.hbs` | Compose | Bind mounts for `openclaw-stack/` |

### Gotchas

- **arm64-only brew formulas** fail on the amd64 VPS. Check architecture compatibility before adding brew tools.
- **Tool install order matters** — tools are installed sequentially as written. If tool B depends on tool A (e.g., `nano-pdf` needs `uv`), A must appear first.
- **Brew auto-wrapping** — the build script automatically wraps `brew install` commands to run as the `linuxbrew` user. Just write `install: brew install <pkg>` in the YAML.
- **`sandbox-toolkit.yaml` is bind-mounted read-only** — changes on the VPS host are immediately visible inside the container (no restart needed for the config file itself, but images need rebuilding).
- **Staleness warnings** appear in gateway logs when images are older than 30 days.
- **Quick-layered tools** are appended on top of the image. Run `--full` periodically to maintain proper layer ordering.
