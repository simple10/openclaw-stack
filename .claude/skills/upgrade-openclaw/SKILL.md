---
name: upgrade-openclaw
description: Use when the user wants to upgrade OpenClaw to a newer version on the VPS - pulling upstream, rebuilding the Docker image, and recreating containers. Triggered by /upgrade-openclaw or requests to update/upgrade OpenClaw.
---

# /upgrade-openclaw -- Upgrade OpenClaw on VPS

Pull upstream OpenClaw changes, rebuild the gateway Docker image with VPS patches, and recreate containers. Brief downtime (~5-10s per claw) during container swap.

## Env Var Discovery

Before doing anything, find connection details. Follow this logic exactly:

1. Read `.env` in the project root. If it contains ANY of `SSH_USER`, `SSH_PORT`, `VPS_IP`, or `SSH_KEY`, use `.env` as `ENV_FILE`.
2. Else read `.env.vps`. If it exists and contains any of those vars, use `.env.vps` as `ENV_FILE`.
3. If neither file has the vars, ask the user interactively for each value, then save them to `.env.vps`. Also ensure `.env.vps` is listed in `.gitignore` (append if not present).
4. Display all discovered values and ask the user to confirm before proceeding.

### Variables and defaults

```
VPS_IP=                           # required, no default
SSH_USER=admin                    # sudo user (post-hardening default)
SSH_PORT=222                      # SSH port (post-hardening default)
SSH_KEY=~/.ssh/id_ed25519         # SSH key path
```

## SSH Connection Pattern

For every remote command, use this pattern:

```bash
ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new $SSH_USER@$VPS_IP "<command>"
```

For multi-line scripts, use heredoc:

```bash
ssh -i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new $SSH_USER@$VPS_IP bash <<'REMOTE'
set -euo pipefail
# commands here
REMOTE
```

## Git Ownership

The openclaw source repo at `$INSTALL_DIR/openclaw` is owned by the `openclaw` user. Running git commands as `adminclaw` (the SSH user) will fail with "detected dubious ownership". **Always run git commands as openclaw:**

```bash
sudo -u openclaw bash -c "cd $INSTALL_DIR/openclaw && git <command>"
```

---

## Prerequisite Check

Verify the server is reachable and the deployment exists.

```bash
# Test SSH connectivity
echo "SSH OK"

# Verify openclaw user exists
id openclaw

# Verify INSTALL_DIR exists (read from stack config)
source <INSTALL_DIR>/host/source-config.sh
ls "$STACK__STACK__INSTALL_DIR/openclaw/.git"
```

If SSH fails, check the connection details in `ENV_FILE`. If the openclaw user or install dir doesn't exist, tell the user to deploy first.

Also read `INSTALL_DIR` from the stack config on the VPS. All subsequent commands use this path.

---

## Section 1: Pre-Upgrade Checks

Before upgrading, capture the current state for comparison and rollback. Run as openclaw user.

```bash
sudo -u openclaw bash -c "cd $INSTALL_DIR/openclaw && \
  echo \"Current version: \$(python3 -c \"import json; print(json.load(open('package.json'))['version'])\" 2>/dev/null || echo unknown)\" && \
  echo \"Current ref: \$(git rev-parse --short HEAD)\" && \
  echo \"Current tag: \$(git describe --tags --always 2>/dev/null || echo none)\" && \
  echo '' && \
  echo 'Git status:' && \
  git status --short"
```

**If git status shows modifications:** Warn the user. The build script expects a clean repo on the `main` branch. Ask before proceeding.

**STOP. Show the current version and ask the user to confirm they want to upgrade.**

---

## Section 2: Pull Upstream Changes

Fetch upstream changes and show what's new. Run as openclaw user.

```bash
sudo -u openclaw bash -c "cd $INSTALL_DIR/openclaw && \
  git fetch --all --tags --force && \
  echo '' && \
  echo 'Latest stable tags:' && \
  git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -5 && \
  echo '' && \
  echo 'New commits on main since current HEAD:' && \
  git log --oneline HEAD..origin/main | head -20 && \
  echo '' && \
  echo \"Total new commits: \$(git rev-list --count HEAD..origin/main)\""
```

If the user wants a specific version, note it for the build step. The build script (`build-openclaw.sh`) reads `OPENCLAW_VERSION` from `stack.env` which supports:
- `stable` — latest non-beta tag (default)
- `latest` — tip of main branch
- `v2026.X.Y` — specific tag

If the user wants to change the version strategy, update `stack.yml` locally and run `npm run pre-deploy` + `scripts/sync-deploy.sh` to push the new `stack.env` before building.

**Pull the latest main:**

```bash
sudo -u openclaw bash -c "cd $INSTALL_DIR/openclaw && git pull"
```

---

## Section 3: Rebuild Gateway Image

The build script handles version checkout, VPS patches, .git inclusion, and Docker build. It restores the host repo to main on completion or failure.

```bash
sudo -u openclaw $INSTALL_DIR/host/build-openclaw.sh
```

This script:
1. Resolves `OPENCLAW_VERSION` from `stack.env` (stable/latest/specific tag)
2. Creates a `vps-patch/<version>` branch with VPS-specific patches (Docker+gosu, jiti cache clear, .dockerignore)
3. Builds the Docker image tagged as `$STACK__STACK__IMAGE`
4. Restores host repo to main branch

**If the build fails:** Read the error output. Common issues:
- **Tag not found:** The requested version doesn't exist. Check available tags.
- **Docker build errors:** Upstream Dockerfile changes may conflict with patches. Check build output.
- **Disk space:** `docker system df` to check. `docker system prune` if needed (with user confirmation).
- **Patch false positive:** If the build says "already patched" but containers fail with "gosu not found" or "Docker not installed", the patch detection grep may be matching unrelated text (e.g., `docker.io` in a LABEL vs as an installed package). Check `deploy/host/build-openclaw.sh` patch 4a grep pattern.

---

## Section 4: Recreate Containers

Ask the user: **Upgrade all claws, or a specific instance?**

### All claws

```bash
sudo -u openclaw bash -c 'cd $INSTALL_DIR && docker compose up -d'
```

### Specific instance

```bash
# Container name pattern: <PROJECT_NAME>-openclaw-<CLAW_NAME>
sudo -u openclaw bash -c 'cd $INSTALL_DIR && docker compose up -d <PROJECT_NAME>-openclaw-<CLAW_NAME>'
```

The `up -d` command detects the new image and recreates only the affected containers. Brief downtime (~5-10s) during the swap.

---

## Section 5: Health Check

Wait for containers to become healthy before declaring success.

```bash
# Check health status (repeat until healthy or timeout)
sudo docker inspect -f '{{.State.Health.Status}}' <CONTAINER_NAME>
```

Poll every 10 seconds, timeout after 300 seconds. If a container doesn't become healthy:

```bash
# Check container logs
sudo docker logs --tail 50 <CONTAINER_NAME>

# Check if the container is running at all
sudo docker ps -a --filter name=<CONTAINER_NAME>
```

**If containers are in a restart loop:** Check logs immediately — don't wait for timeout. Common crash-loop causes:
- **"gosu: not found"** — the docker.io/gosu Dockerfile patch was skipped. Check build output for "already patched" false positives.
- **"Docker not installed"** — same root cause as gosu (both are installed by the same patch).
- **"tag vX.Y.Z not found"** — .git was not included in the image (check .dockerignore handling) or git commands fail due to ownership (gosu needed to run git as node user).

---

## Section 6: Post-Upgrade Verification

After containers are healthy, verify the upgrade succeeded.

```bash
# Read version from inside container (avoids openclaw CLI path issues)
sudo docker exec <CONTAINER> bash -c "cd /app && cat package.json" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])"
```

Print a summary table:

- Previous version
- New version per claw
- Containers recreated
- Health status (healthy/unhealthy)
- Any warnings from the upgrade

---

## Rollback

If the upgrade causes issues, the previous image is still available until pruned.

```bash
# List available images
sudo docker images | grep openclaw

# The old container config is in docker compose — just rebuild with the old version
# Edit stack.yml to pin OPENCLAW_VERSION to the previous tag, then:
# npm run pre-deploy && scripts/sync-deploy.sh
# sudo -u openclaw $INSTALL_DIR/host/build-openclaw.sh
# sudo -u openclaw bash -c 'cd $INSTALL_DIR && docker compose up -d'
```

For an immediate rollback without rebuilding (if the old image still exists):

```bash
# Tag the old image back and recreate
sudo docker tag <old-image-id> $STACK__STACK__IMAGE
sudo -u openclaw bash -c 'cd $INSTALL_DIR && docker compose up -d'
```
