---
PLAN SECURITY REVIEW:

Security implications

During the build (transient risks):

- The intermediate openclaw-sandbox-base-root:bookworm-slim image has USER root, but it's deleted after use. Even if cleanup
  fails, OpenClaw would never use it — it's not configured in openclaw.json. It only exists inside the nested Docker (inside
  Sysbox).
- Between step 2 and step 3, openclaw-sandbox-common:bookworm-slim exists with USER root for a brief moment. But if the
  entrypoint crashes here, the gateway never starts (entrypoint is PID 1), so the image can't be used. And even if it were,
  openclaw.json enforces "user": "1000:1000" + "capDrop": ["ALL"] at runtime.

  Final state: Identical security posture to what upstream intends — USER 1000, runtime enforcement unchanged, no new attack
  surface.

  Upstream change risks
  Upstream change: Fixes the bug (adds USER root before apt-get)
  Impact on us: Harmless — our rooted base is redundant, our USER 1000 fix is a no-op. Everything still works.
  ────────────────────────────────────────
  Upstream change: Removes or renames BASE_IMAGE env var
  Impact on us: Breaks our approach — script ignores override, reverts to the bug. Unlikely since env var overrides are
  standard
     shell patterns.
  ────────────────────────────────────────
  Upstream change: Adds USER sandbox at end of heredoc
  Impact on us: Harmless — our step 3 USER 1000 is redundant.
  ────────────────────────────────────────
  Upstream change: Adds packages needing the sandbox user (e.g., USER sandbox + pip install --user)
  Impact on us: Could break — our rooted base causes those RUN commands to execute as root instead, installing to wrong paths.
    Low probability since package installs typically need root.
  ────────────────────────────────────────
  Upstream change: Restructures script entirely
  Impact on us: Still works as long as BASE_IMAGE is respected. The env var is the contract.
  The main risk is upstream removing the BASE_IMAGE env var, which would be unusual. The approach is designed to become a no-op
   when upstream fixes the bug, rather than conflicting with a fix.

---

# Fix sandbox-common image build failure

## Context

The upstream `sandbox-common-setup.sh` has a bug: its generated Dockerfile inherits `USER sandbox` from the base image (`openclaw-sandbox:bookworm-slim`) and runs `apt-get update` without switching to `USER root` first. This causes Permission denied errors. The bug exists in both host and container installs.

The current entrypoint (playbook 04 section 4.8c) calls the script in a `set +e` subshell but doesn't verify the image was built — it prints "built successfully" regardless. Since the common image is never created, the claude sandbox (which depends on it) is also skipped. Agents end up with no dev tools.

## Approach: BASE_IMAGE override (hybrid: entrypoint + playbook verification)

The upstream script exposes `BASE_IMAGE` as an overridable env var (line 4). We use this to pass a "rooted" variant of the base image, then restore `USER 1000` afterward for security.

**Hybrid strategy**: The entrypoint builds sandbox images on every fresh start (self-healing for restarts, since Sysbox-provisioned `/var/lib/docker` is lost on container recreation). The playbook adds explicit verification steps during deployment to test that images were built correctly.

### Why BASE_IMAGE override

| Option | Gets all packages | Fragile | Maintenance |
|--------|:-:|:-:|:-:|
| **A: BASE_IMAGE override** | Yes | No | Low |
| B: Sed-patch script | Yes | Yes (depends on heredoc format) | Medium |
| C: Skip upstream entirely | Partial (must replicate bun/brew setup) | No | High |
| D: Fallback only | No (omits golang, rust, bun, brew) | No | Low |

Option A is the only approach that (1) uses the upstream script as-is through its documented interface, (2) gets all packages, and (3) isn't fragile.

### Build sequence (inside entrypoint's `set +e` subshell)

```
1. Build rooted intermediate:
   FROM openclaw-sandbox:bookworm-slim
   USER root
   → tag: openclaw-sandbox-base-root:bookworm-slim  (~instant, metadata-only layer)

2. Run upstream script with overridden env vars:
   BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim \
   PACKAGES="curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file ffmpeg imagemagick" \
   /app/scripts/sandbox-common-setup.sh
   → produces: openclaw-sandbox-common:bookworm-slim  (3-5 min, full packages + media tools)

3. Verify image exists. If yes, fix security:
   FROM openclaw-sandbox-common:bookworm-slim
   USER 1000
   → re-tag: openclaw-sandbox-common:bookworm-slim  (~instant, metadata-only layer)

4. Cleanup: docker rmi openclaw-sandbox-base-root:bookworm-slim

5. If any step failed → log ERROR with details, do NOT build a fallback image.
   No silent degradation — the missing image will surface during playbook verification
   or when agents try to run.
```

### Package layering (corrected)

Current setup incorrectly adds ffmpeg/imagemagick in the claude sandbox layer. The correct layering:

| Image | Adds | Inherits from |
|-------|------|---------------|
| `openclaw-sandbox` | bash, curl, git, jq, python3, ripgrep | debian:bookworm-slim |
| `openclaw-sandbox-common` | node, npm, pnpm, bun, go, rust, build-essential, **ffmpeg, imagemagick**, brew | openclaw-sandbox |
| `openclaw-sandbox-claude` | Claude Code CLI only | openclaw-sandbox-common |
| `openclaw-sandbox-browser` | chromium, xvfb, novnc | debian:bookworm-slim |

The `PACKAGES` env var adds ffmpeg and imagemagick to the upstream default list. The claude sandbox build simplifies to just `npm install -g @anthropic-ai/claude-code` (no more apt-get).

### No fallback

If the build fails, the entrypoint logs an error and continues (gateway still starts). The common and claude sandbox images won't exist. This is intentional — a minimal fallback with missing packages would create confusing behavior. During deployment, the playbook verification catches the failure. On restarts, the error surfaces when agents try to run.

### Security properties preserved

- Final image has `USER 1000` (not root) — verified by playbook and `docker image inspect`
- Runtime also enforces `"user": "1000:1000"` and `"capDrop": ["ALL"]` via openclaw.json
- Intermediate rooted image is deleted after use
- No changes to sandbox container runtime configuration

### Self-healing

If upstream ever fixes the bug (adds `USER root` before `apt-get`), our intermediate image becomes harmless — the script would succeed with or without it, and the `USER 1000` fix at the end is a no-op if already set.

## Files to modify

### 1. `playbooks/04-vps1-openclaw.md` — section 4.8c entrypoint (lines 610-624)

Replace the common sandbox build block with:

- Steps 1-4: BASE_IMAGE override sequence (described above)
- Verify image exists after each step; log ERROR if build failed (no fallback)
- Use `|| true` after upstream script call to prevent subshell exit

Also:

- Add image-exists verification to the base, browser, and claude sandbox blocks (currently they log "built successfully" without checking)
- Simplify the claude sandbox build (line 644): remove `apt-get install ffmpeg imagemagick` — these are now in common. Claude build becomes: `FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000`

### 2. `playbooks/04-vps1-openclaw.md` or `playbooks/extras/sandbox-and-browser.md` — new sandbox verification section

Add a deployment step AFTER gateway startup that explicitly tests each sandbox image:

```bash
#!/bin/bash
# Run after gateway has started and entrypoint has completed sandbox builds

echo "=== Checking sandbox images ==="
FAILED=0

# 1. Check all 4 images exist
for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-common:bookworm-slim \
           openclaw-sandbox-browser:bookworm-slim openclaw-sandbox-claude:bookworm-slim; do
  if sudo docker exec openclaw-gateway docker image inspect "$img" > /dev/null 2>&1; then
    echo "  $img: EXISTS"
  else
    echo "  $img: MISSING"
    FAILED=1
  fi
done

# 2. Security check: verify USER is 1000 (not root) on common and claude images
for img in openclaw-sandbox-common:bookworm-slim openclaw-sandbox-claude:bookworm-slim; do
  USER=$(sudo docker exec openclaw-gateway docker image inspect "$img" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null)
  if [ "$USER" = "1000" ]; then
    echo "  $img USER: 1000 (OK)"
  else
    echo "  $img USER: $USER (EXPECTED 1000)"
    FAILED=1
  fi
done

# 3. Test key binaries in common sandbox (full package verification)
# ffmpeg + imagemagick are now in common (not claude) via PACKAGES override
for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-common:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  common/$bin: OK"
  else
    echo "  common/$bin: MISSING"
    FAILED=1
  fi
done

# 4. Test claude sandbox (should inherit common tools + add Claude Code CLI)
for bin in claude ffmpeg node; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-claude:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  claude/$bin: OK"
  else
    echo "  claude/$bin: MISSING"
    FAILED=1
  fi
done

# 5. Check no intermediate images left
if sudo docker exec openclaw-gateway docker images | grep -q base-root; then
  echo "  WARNING: intermediate base-root image not cleaned up"
fi

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "SANDBOX VERIFICATION FAILED — check entrypoint logs:"
  echo "  sudo docker logs openclaw-gateway 2>&1 | grep '\\[entrypoint\\]'"
fi
```

### 3. `playbooks/extras/sandbox-and-browser.md` — troubleshooting (lines 253-268)

Update "Common Sandbox Build Fails" section to reflect that the entrypoint now handles this automatically via BASE_IMAGE override. Remove the manual fallback rebuild command. Keep the explanation of the upstream bug for context.

### 4. `playbooks/07-verification.md` — line 266

Update the sandbox troubleshooting note to reference the BASE_IMAGE override approach.

### 5. `notes/sandboxes.md`

Add a "Chosen fix" section documenting the BASE_IMAGE override approach and marking the options as resolved.

## Verification (during deployment)

The playbook verification script (section 2 above) runs after gateway startup. Expected output:

```
=== Checking sandbox images ===
  openclaw-sandbox:bookworm-slim: EXISTS
  openclaw-sandbox-common:bookworm-slim: EXISTS
  openclaw-sandbox-browser:bookworm-slim: EXISTS
  openclaw-sandbox-claude:bookworm-slim: EXISTS
  openclaw-sandbox-common:bookworm-slim USER: 1000 (OK)
  openclaw-sandbox-claude:bookworm-slim USER: 1000 (OK)
  common/go: OK
  common/rustc: OK
  common/bun: OK
  common/brew: OK
  common/node: OK
  common/npm: OK
  common/pnpm: OK
  common/git: OK
  common/curl: OK
  common/wget: OK
  common/jq: OK
  common/ffmpeg: OK
  common/convert: OK
  claude/claude: OK
  claude/ffmpeg: OK
  claude/node: OK
```

## Considerations

- **Disk space**: Full upstream build with golang/rust/bun/brew uses ~2-3GB inside nested Docker. The extras playbook prerequisite says 2GB free — may need to update to 3-4GB.
- **Build time**: Full build takes 5-10 min. `start_period: 300s` may be tight — consider increasing to 600s if builds time out.
- **`USER 1000` vs `USER sandbox`**: Using numeric UID (consistent with claude sandbox build at line 644) avoids depending on username existing in `/etc/passwd` within the build context.
- **Sysbox data persistence**: Nested Docker data (`/var/lib/docker`) is auto-provisioned by Sysbox and tied to container lifecycle. `docker compose down && up` destroys and recreates it. The entrypoint rebuilds missing images on each fresh start (self-healing).
