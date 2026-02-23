# Plan: Rename sandbox-common to sandbox-toolkit + layer builds for fast tool additions

## Context

Two problems with the current sandbox build system:

1. **Naming**: `openclaw-sandbox-common:bookworm-slim` is vague — it's actually the image containing all toolkit binaries (claude, gh, ffmpeg, go, etc.). Rename to `openclaw-sandbox-toolkit:bookworm-slim`.

2. **Build speed**: Adding one tool requires a full rebuild of everything. The current flow generates all tool installs as separate `RUN` instructions (good!), but then `docker rmi`s the existing image before rebuilding (bad — destroys Docker's layer cache). Also, the packages layer (apt + brew + bun) rebuilds every time even when only tools change.

## Image layer architecture

```
openclaw-sandbox:bookworm-slim                     ← upstream base (rarely changes)
  └─ openclaw-sandbox-base-root:bookworm-slim      ← rooted + NodeSource (intermediate, cleaned up)
      └─ openclaw-sandbox-packages:bookworm-slim   ← apt pkgs + brew + bun + pnpm (NEW TAG)
          └─ openclaw-sandbox-toolkit:bookworm-slim ← tool installs from sandbox-toolkit.yaml

openclaw-sandbox-browser:bookworm-slim             ← separate chain (FROM debian:bookworm-slim)
```

## Changes

### 1. Introduce packages layer — `deploy/rebuild-sandboxes.sh`

Split the single `build_common()` into a two-stage build:

- **Step A**: Run upstream `sandbox-common-setup.sh` with `TARGET_IMAGE=openclaw-sandbox-packages:bookworm-slim` (it already supports this env var). Only rebuilds when the packages list changes.
- **Step B**: Layer tool installs on top of packages image, tag as `openclaw-sandbox-toolkit:bookworm-slim`. Each tool is already a separate `RUN` instruction — Docker caches unchanged ones.

**Split config change detection** into two hashes:

- **Packages hash** (from `packages` array) → label `openclaw.packages-config` on packages image
- **Tools hash** (from `tools` object) → label `openclaw.toolkit-config` on toolkit image

Decision logic:

- Packages changed → rebuild packages + toolkit
- Only tools changed → skip packages, rebuild toolkit only (Docker caches unchanged `RUN` layers)
- Nothing changed → staleness check only
- `--force` → rebuild everything

**Remove `docker rmi` before toolkit rebuild** (current line 218). Keeping the old image lets Docker cache unchanged tool `RUN` layers.

**Update `save_digests()` / `verify_digests()`**: Add `openclaw-sandbox-packages:bookworm-slim` to the image list.

### 2. Add `--quick <toolname>` flag — `deploy/rebuild-sandboxes.sh`

For near-instant single-tool additions. Generates:

```dockerfile
FROM openclaw-sandbox-toolkit:bookworm-slim
USER root
RUN <install command for that tool>
USER 1000
```

Layers on top in seconds. Reads the tool's config from `sandbox-toolkit.yaml`, applies the same brew auto-wrapping and `${VERSION}`/`${BIN_DIR}` substitution as the full build. Exits early — skips base, packages, browser, agent homes.

Logs a note: "Run `--full` rebuild to properly order layers."

### 3. Make `--quick` the default in `scripts/update-sandbox-toolkit.sh`

The user-facing script defaults to fast iteration:

```bash
scripts/update-sandbox-toolkit.sh                    # default: detect new/changed tools, quick-layer them
scripts/update-sandbox-toolkit.sh --full             # full rebuild of entire toolkit layer
scripts/update-sandbox-toolkit.sh --full --all       # full rebuild including browser
scripts/update-sandbox-toolkit.sh --sync-only        # sync files + shims only, skip rebuild
scripts/update-sandbox-toolkit.sh --dry-run          # preview
```

The `--quick` default works by:

1. Syncing files to VPS (unchanged)
2. Regenerating shims (unchanged)
3. Comparing toolkit config hash — if tools changed, use `--quick` to layer new tool on top
4. Skipping restart prompt (new sandboxes auto-pick up the image)

`rebuild-sandboxes.sh` itself (entrypoint boot path) keeps the full rebuild as default — that's the "source of truth" builder.

### 4. Rename `openclaw-sandbox-common` → `openclaw-sandbox-toolkit` — all files

Mechanical rename across the codebase:

| File | Changes |
|------|---------|
| `deploy/rebuild-sandboxes.sh` | Rename `build_common()` → `build_toolkit()`, all image refs, log messages |
| `deploy/openclaw.json` | Code agent image (line 217), skills agent image (line 265), comment (line 182) |
| `deploy/sandbox-toolkit.yaml` | 2 comments |
| `README.md` | Update "Managing sandbox tools" section and file tree description |
| `docs/SANDBOX-TOOLKIT.md` | Architecture diagram, verification commands, layer diagram, brew example, gotchas |
| `docs/SKILL-ROUTING.md` | Agent topology table, prose references (7 occurrences) |
| `playbooks/04-vps1-openclaw.md` | Verification loops, architecture docs (6 occurrences) |
| `playbooks/07-verification.md` | `docker ps --filter ancestor=` commands (3 occurrences) |
| `notes/openclaw-browser-sandbox.md` | Architecture notes (6 occurrences) |
| `notes/DIAGRAMS.md` | ASCII diagram (1 occurrence) |
| `notes/TODO.md` | Mark rename and layering TODOs as done |

The upstream `Dockerfile.sandbox-common` and `sandbox-common-setup.sh` are NOT renamed — they're upstream files. We just pass `TARGET_IMAGE` env var.

### 5. Update `docs/SANDBOX-TOOLKIT.md`

Beyond the rename, several sections need updating:

- **Architecture diagram** (line 9-18): Show new 3-layer chain + separate browser
- **Brew example** (line 81-88): Update to simplified `brew install` (auto-wrapped by rebuild script), not the verbose `su -s /bin/bash linuxbrew` pattern
- **Image layers** (lines 204-208): Fix incorrect parent chain — browser is NOT a child of toolkit, it's `FROM debian:bookworm-slim`
- **Scripts section** (lines 109-148): Add `--quick` flag docs, update `update-sandbox-toolkit.sh` to show it as default
- **Common workflows** (lines 150-187): Update "Add a new tool" workflow to mention quick default
- **Gotchas** (line 228): Update brew gotcha — no longer need manual `su` wrapping, build script handles it
- **Config change detection** (line 22): Mention split hashing (packages vs tools)
- **"Packages" section** (line 99): Reference `sandbox-packages` image, not `sandbox-common`

### 6. Update `README.md`

- **Lines 377-382**: Update `update-sandbox-toolkit.sh` comment to mention quick default
- **Line 495**: Update file tree — `rebuild-sandboxes.sh` description to mention layered builds
- **Lines 407-411**: Expand "Managing sandbox tools" section to mention quick iteration workflow

### 7. Update `scripts/update-sandboxes.sh` (if it references the old image name)

Check and update any references. This script does force-rebuilds without config sync.

## Files modified

- `deploy/rebuild-sandboxes.sh` — layering refactor, rename, `--quick` flag (major)
- `deploy/openclaw.json` — image name rename (3 refs)
- `deploy/sandbox-toolkit.yaml` — comment rename (2 refs)
- `scripts/update-sandbox-toolkit.sh` — make `--quick` default, add `--full` flag
- `README.md` — update toolkit section and file tree
- `docs/SANDBOX-TOOLKIT.md` — layer diagram, image names, brew example, `--quick` docs, workflow updates
- `docs/SKILL-ROUTING.md` — image name rename (7 refs)
- `playbooks/04-vps1-openclaw.md` — image name rename (6 refs)
- `playbooks/07-verification.md` — image name rename (3 refs)
- `notes/openclaw-browser-sandbox.md` — image name rename (6 refs)
- `notes/DIAGRAMS.md` — image name rename (1 ref)
- `notes/TODO.md` — mark items done

## VPS migration

No special migration needed. After deploying updated files:

1. `rebuild-sandboxes.sh` sees `openclaw-sandbox-packages` missing → builds it
2. Sees `openclaw-sandbox-toolkit` missing → builds it
3. `openclaw.json` references new name → agents pick it up on next sandbox creation
4. Old `openclaw-sandbox-common` image remains until `docker image prune`

## Verification

1. **Local**: Read the generated Dockerfile (`--dry-run`) to confirm layering structure
2. **VPS full build**: `scripts/update-sandbox-toolkit.sh --full` — produces packages + toolkit images
3. **Layering test**: Run `update-sandbox-toolkit.sh --full` twice — second run should skip packages rebuild and hit Docker cache for all tools (near-instant)
4. **Quick add test**: Add a test tool to `sandbox-toolkit.yaml`, run `update-sandbox-toolkit.sh`, verify it layers in seconds
5. **Agent test**: `openclaw agent --agent skills --message ping` — verify sandbox comes up with new image name
6. **Bin verification**: Run playbook 7.1a — all bins should pass
