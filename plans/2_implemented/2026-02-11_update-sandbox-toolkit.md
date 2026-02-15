# Plan: `scripts/update-sandbox-toolkit.sh`

## Context

Sandbox tools (codex, opencode, amp, claude-code, etc.) are baked into images at build time. Updating them currently requires either a gateway restart (entrypoint rebuilds images on boot) or running `scripts/update-sandboxes.sh` which only force-rebuilds — it doesn't push local file changes to the VPS first.

When editing `deploy/sandbox-toolkit.yaml` locally (e.g., adding a new tool), there's no single command that syncs the changes and rebuilds. This script closes that gap.

## What the script does

Three steps, no gateway restart:

1. **Sync deploy files** — push local toolkit files to VPS host (bind mounts make them immediately visible inside the container)
2. **Regenerate gateway shims** — create `/opt/skill-bins/<bin>` shims for any new tool binaries so OpenClaw recognizes them without restart
3. **Rebuild sandbox images** — `rebuild-sandboxes.sh --force` inside the running container

## Files synced

These three files are bind-mounted into the gateway container (`docker-compose.override.yml` lines 48-50):

| Local | VPS host path | Container path |
|-------|---------------|----------------|
| `deploy/sandbox-toolkit.yaml` | `/home/openclaw/openclaw/deploy/sandbox-toolkit.yaml` | `/app/deploy/sandbox-toolkit.yaml:ro` |
| `deploy/parse-toolkit.mjs` | `/home/openclaw/openclaw/deploy/parse-toolkit.mjs` | `/app/deploy/parse-toolkit.mjs:ro` |
| `deploy/rebuild-sandboxes.sh` | `/home/openclaw/openclaw/deploy/rebuild-sandboxes.sh` | `/app/deploy/rebuild-sandboxes.sh:ro` |

File transfer uses `cat <file> | ssh ... "sudo -u openclaw tee <target> > /dev/null"` — avoids temp files, writes as the `openclaw` user directly.

## Gateway shim regeneration

The entrypoint generates pass-through shims at lines 70-108 of `deploy/entrypoint-gateway.sh`. The shim logic only creates shims for binaries that don't already exist (`if [ ! -f "/opt/skill-bins/$bin" ]`), so re-running it is safe and idempotent — only new tools get shims.

The script runs this via `docker exec --user root` (shims need to be written to `/opt/skill-bins/` which is root-owned). It reuses the same toolkit parser and shim template from the entrypoint.

## Flags

| Flag | Effect |
|------|--------|
| `--all` | Also rebuild browser sandbox image |
| `--dry-run` | Show what would be synced/rebuilt without executing |
| `--sync-only` | Sync files + regenerate shims, skip image rebuild |

## File to create

- **`scripts/update-sandbox-toolkit.sh`** — new file, follows patterns from `scripts/update-sandboxes.sh` and `scripts/update-openclaw.sh`

## Verification

1. Run `scripts/update-sandbox-toolkit.sh --dry-run` — should show the 3 files that would sync and the rebuild that would run
2. Run `scripts/update-sandbox-toolkit.sh` — should sync files, regenerate shims, rebuild common image
3. Verify new tools work: `ssh ... "sudo docker exec openclaw-gateway /opt/skill-bins/codex --version"` (shim should exist, will error since real binary is only in sandbox — that's expected)
4. Verify sandbox has tools: `ssh ... "sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim codex --version"`
