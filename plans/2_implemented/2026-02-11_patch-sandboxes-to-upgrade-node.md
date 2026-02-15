# Plan: Upgrade sandbox Node.js from 18 to LTS v24

## Context

Sandbox containers run Node 18.x (Debian bookworm's `apt install nodejs`), causing `npm WARN EBADENGINE` warnings — many packages now require Node >= 20. Gateway stays on Node 22 (still LTS, no change needed).

## Changes

### 1. `deploy/rebuild-sandboxes.sh` — add NodeSource repo to sandbox builds

In `build_common()`, modify the rooted intermediate image (step 1, line 244) to include the NodeSource 24.x repo. Currently:

```bash
printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\n' \
  | docker build -t openclaw-sandbox-base-root:bookworm-slim -
```

Change to:

```bash
printf 'FROM openclaw-sandbox:bookworm-slim\nUSER root\nRUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash -\n' \
  | docker build -t openclaw-sandbox-base-root:bookworm-slim -
```

This adds the NodeSource apt repo to the intermediate image. When the upstream `sandbox-common-setup.sh` later runs `apt-get install nodejs`, it picks up Node 24 from NodeSource instead of Node 18 from bookworm. The upstream `npm install -g pnpm` step (14/16) also benefits.

Prerequisites already satisfied: base sandbox image has `curl` and `ca-certificates` (from `Dockerfile.sandbox` step 3).

### 2. `deploy/sandbox-toolkit.yaml` — remove `npm` from packages

Remove `- npm` from the `packages:` list. NodeSource's `nodejs` package bundles npm — keeping the separate Debian `npm` package would cause version conflicts.

Keep `- nodejs` in the packages list — it's still needed, but now resolves to Node 24 from NodeSource.

## Files to modify

1. `deploy/rebuild-sandboxes.sh` — add NodeSource setup to rooted intermediate (~1 line change)
2. `deploy/sandbox-toolkit.yaml` — remove `npm` from packages list (~1 line)

## Verification

After deploying to VPS and force-rebuilding sandbox images:

```bash
# 1. Sandbox Node version (should be 24.x, was 18.x)
sudo docker exec openclaw-gateway \
  docker run --rm openclaw-sandbox-common:bookworm-slim node --version

# 2. npm version check (should be bundled with NodeSource, not Debian's)
sudo docker exec openclaw-gateway \
  docker run --rm openclaw-sandbox-common:bookworm-slim npm --version

# 3. No EBADENGINE warnings during tool installs
sudo docker exec openclaw-gateway /app/deploy/rebuild-sandboxes.sh --force 2>&1 | grep -i "EBADENGINE"
```
