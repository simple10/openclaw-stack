# Plan: Extract drifted files from playbook heredocs + establish deploy convention

## Context

Playbook `04-vps1-openclaw.md` inlines file contents as heredocs. Two files also exist as standalone copies in the repo and have drifted:

- **`vector.yaml`** (root) has a `tag_level` transform the playbook version lacks
- **`build/host-alert.sh`** has state-change dedup but the playbook version has backup/load checks and different implementation

We need a single source of truth for these files and a convention so future files follow the same pattern.

## Changes

### 1. Rename `build/` → `deploy/`

- `git mv build deploy`
- Update `deploy/README.md` to describe the new convention (see step 5)

### 2. Move `vector.yaml` to `deploy/`

- `git mv vector.yaml deploy/vector.yaml`
- The root-level version (with `tag_level` transform) is authoritative — no content changes needed

### 3. Merge `host-alert.sh`

Create `deploy/host-alert.sh` combining best of both versions:

- **From build/ version**: state-change fingerprint dedup (md5sum to `/tmp/host-alert-state`), Docker daemon health check, container crash detection
- **From playbook version**: load average check, gateway container check, backup freshness check
- **Fix**: source from `/home/openclaw/openclaw/.env` (not `openclaw-config.env` which doesn't exist on VPS)

### 4. Update playbook `04-vps1-openclaw.md`

Replace heredocs in **sections 4.7 and 4.8d** with file-reference directives.

**New pattern** — replace inlined content with a source marker:

```bash
#!/bin/bash
# SOURCE: deploy/vector.yaml → /home/openclaw/openclaw/vector.yaml
sudo -u openclaw tee /home/openclaw/openclaw/vector.yaml << 'EOF'
# <<< deploy/vector.yaml >>>
EOF
```

The `# <<< deploy/vector.yaml >>>` sentinel tells Claude (or a human): read the actual file from the repo and use its contents here. The `# SOURCE:` comment at the top of the bash block documents the mapping.

**Section 4.7** (vector.yaml): Replace 30-line heredoc body with sentinel referencing `deploy/vector.yaml`.

**Section 4.8d** (host-alert.sh): Replace 60-line heredoc body with sentinel referencing `deploy/host-alert.sh`.

### 5. Update `deploy/README.md`

Replace current content with a manifest + convention docs:

```markdown
# Deploy Files

Authoritative source files for VPS deployment. Playbooks reference these
via `# SOURCE:` comments — never duplicate file contents in playbook heredocs.

## Convention

When a playbook bash block contains:
  # SOURCE: deploy/<file> → /vps/target/path
The executor reads `deploy/<file>` from this repo and deploys its contents
to the target path on the VPS. The heredoc body contains a sentinel
`# <<< deploy/<file> >>>` as a placeholder.

## Files

| Source | VPS Target | Owner | Mode |
|--------|-----------|-------|------|
| `vector.yaml` | `/home/openclaw/openclaw/vector.yaml` | openclaw | 644 |
| `build-openclaw.sh` | `/home/openclaw/scripts/build-openclaw.sh` | openclaw | 755 |
| `host-alert.sh` | `/home/openclaw/scripts/host-alert.sh` | root | 755 |
```

### 6. Add convention rule to `CLAUDE.md`

Under "General Rules", add:

```markdown
- **Single source of truth for deployed files.** Files deployed to the VPS live in `deploy/`. Playbooks reference them via `# SOURCE: deploy/<file>` comments with a `# <<< deploy/<file> >>>` sentinel in the heredoc body. When executing a playbook step with this pattern, read the referenced file from the local repo and use its contents in place of the sentinel. Never duplicate file contents inline in playbooks.
```

## Files modified

| File | Action |
|------|--------|
| `build/` → `deploy/` | Rename directory |
| `vector.yaml` → `deploy/vector.yaml` | Move (no content change) |
| `deploy/host-alert.sh` | Rewrite (merge both versions) |
| `deploy/README.md` | Rewrite with manifest + convention |
| `playbooks/04-vps1-openclaw.md` | Edit sections 4.7 and 4.8d |
| `CLAUDE.md` | Add convention rule |

## Verification

1. `deploy/vector.yaml` matches the current root `vector.yaml` exactly (has `tag_level` transform)
2. `deploy/host-alert.sh` has: state-change dedup, sources `.env`, checks disk/memory/load/docker/gateway/backup
3. Playbook sections 4.7 and 4.8d have `# SOURCE:` + sentinel pattern, no inlined file content
4. `build/` directory no longer exists
5. `CLAUDE.md` has the new convention rule
6. `deploy/README.md` has manifest table matching actual files
