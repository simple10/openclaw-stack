# Analysis of OpenClaw Sandbox Images

We've been running into a couple issues with the apt-get step in openclaw's [scripts/setup-sandbox-common.sh](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-common-setup.sh) script.

1. Runs apt-get install as sandbox user which fails in our setup
2. Silently fails the build due to `set -e` ignoring errors

It's unclear how a normal openclaw setup gets around this (if at all?).

## Normal Install (Host, no container)

**Build:** none needed

OpenClaw is installed directly on the host via npm install or git clone. No Docker image build for the gateway itself.

**Start:** `node dist/index.js gateway`

The gateway runs as a regular Node.js process on the host (typically as a regular user, e.g., via systemd). It talks to the host's Docker daemon via `/var/run/docker.sock`.

### Sandbox image building (First agent message, not at startup)

Sandbox images are built **lazily** – not at startup, but when the first sandboxed agent runs. The gateway calls the upstream scripts that ship with OpenClaw inside `/app/scripts/`:

1. **sandbox-setup.sh** → `docker build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .`
   - Builds from debian:bookworm-slim + bash, curl, git, jq, python3, ripgrep
   - Sets USER sandbox (non-root user)
2. **sandbox-common-setup.sh** → `docker build -t openclaw-sandbox-toolkit:bookworm-slim` (heredoc Dockerfile)
   - `FROM openclaw-sandbox:bookworm-slim`– **inherits USER sandbox**
   - Runs apt-get update && apt-get install (Node.js, npm, pnpm, Bun, Go, Rust, Homebrew, build-essential)
   - ==**This is where the bug is.**== The heredoc Dockerfile doesn't add USER root before apt-get. Since the base image's default user is sandbox, apt-get fails with Permission denied on `/var/lib/apt/lists/partial`.
3. **sandbox-browser-setup.sh** → `docker build -t openclaw-sandbox-browser:bookworm-slim -f Dockerfile.sandbox-browser .`
   - Built from debian:bookworm-slim directly (NOT from the sandbox base), so not affected by the USER sandbox bug

### Key insight: the bug exists in normal installs too

On a normal host install, sandbox-common-setup.sh also fails with Permission denied. But:

- The build scripts are called from the gateway Node.js process, which handles the error gracefully (logs it, continues)
- The gateway starts fine – it just can't use the common sandbox image
- If sandbox images don't exist, the gateway either uses `sandbox.mode: "off"` or falls back to basic sandbox without the dev tools

---

## Our Install (Docker + Sysbox)

### Pre-deployment: Build the gateway image

**User:** adminclau on VPS, runs as openclaw user
**Command:** `sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh`

This does:

1. `cd /home/openclaw/openclaw` (the cloned upstream repo)
2. **Our patch:** sed inserts a RUN apt-get install docker.io gosu && useradd -aG docker node before USER node in the upstream Dockerfile
3. `docker build -t openclaw-<project>:<version> .` – builds using the **host Docker daemon** as openclaw user
4. `git checkout -- Dockerfile` – restores the upstream file

The resulting openclaw-<project>:<version> image is the upstream OpenClaw image **plus** docker.io (docker CLI + dockerd + containerd + runc) and gosu (for privilege dropping).

### Start: `docker compose up -d`

**User:** adminclau on VPS, runs as openclaw user
**Command:** `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'`

Docker compose reads both docker-compose.yml (upstream) and docker-compose.override.yml (ours), merged. This starts:

| Container | Image | Runtime | User | Purpose |
|---|---|---|---|---|
| openclaw-gateway | openclaw-\<project\>:\<version\> | sysbox-runc | 0:0 (root) | Gateway + nested Docker |
| vector | timberio/vector:0.43.1-alpine | default runc | default | Log shipping |

The openclaw-gateway container starts with:

- user: `"0:0"` – root inside the container (Sysbox maps this to an unprivileged uid on the host)
- entrypoint: `["/app/scripts/entrypoint-gateway.sh"]` – our custom entrypoint
- command: `["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]` – passed as `$@` to entrypoint

### First boot: entrypoint runs as root (uid 0 inside container)

The entrypoint (`scripts/entrypoint-gateway.sh`) runs as root (container user: "0:0") and does:

### Phase 1 – Housekeeping (as root)

1. Clean stale lock files in `/home/node/.openclaw/`
2. Fix `openclaw.json` to chmod 600 if permissions drifted
3. Fix `.claude-sandbox` ownership → chown 1000:1000 (Sysbox uid remapping fix)
4. Fix `.openclaw` dir ownership → chown 1000:1000
5. Create CLI symlink: `/usr/local/bin/openclaw` → `/app/openclaw.mjs`

### Phase 2 – Start nested Docker daemon (as root)

1. `dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --log-level=warn &`
2. Sysbox auto-provisions writables `/var/lib/docker` and `/var/lib/containerd`
   - Waits up to 30s for docker info to succeed

### Phase 3 – Build sandbox images (as root, inside `set -e` subshell)

This is where the two entrypoint versions diverge:

**Image 1: openclaw-sandbox** (base)

- Checks: `docker image inspect openclaw-sandbox`
- If missing: `docker build -t openclaw-sandbox /app/sandbox/` (uses `/app/sandbox/Dockerfile` from upstream)
- This builds successfully – it's FROM debian:bookworm-slim and sets USER sandbox at the end

**Image 2: openclaw-sandbox-toolkit:bookworm-slim** (dev tools)

- Checks: `docker image inspect openclaw-sandbox-toolkit:bookworm-slim`
- If missing: calls `/app/scripts/sandbox-common-setup.sh` (upstream script)
- ==**The upstream script fails**== because it builds FROM openclaw-sandbox:bookworm-slim which has USER sandbox, and the heredoc Dockerfile runs apt-get **without switching to root first**
- **04 entrypoint:** just logs "build successfully" (incorrectly – it doesn't verify the image exists)
- **extras entrypoint:** checks if image actually exists afterward. If not, does a fallback rebuild with USER root injected, using a minimal package list (omits golang, rust, cargo, bun, homebrew)

**Image 3: openclaw-sandbox-browser:bookworm-slim** (Chromium)

- If missing: calls `/app/scripts/sandbox-browser-setup.sh`
- This builds from debian:bookworm-slim directly, so NOT affected by the USER sandbox bug

**Image 4: openclaw-sandbox-claude:bookworm-slim** (our custom layer)

- If missing AND openclaw-sandbox-toolkit:bookworm-slim exists: builds via inline Dockerfile
- FROM openclaw-sandbox-toolkit:bookworm-slim + USER root + apt-get install ffmpeg imagemagick + npm install -g @anthropic-ai/claude-code + USER 1000
- ==**If common image failed to build,**== this is skipped entirely (no base to layer on)

### Phase 4 – Privilege drop

1. `exec gosu node "$@"` – drops from root to node (uid 1000), executes `node dist/index.js gateway --bind lan --port 18789`

From this point, the gateway process runs as node (uid 1000) and talks to the nested Docker daemon via `/var/run/docker.sock` (node is in the docker group from our Dockerfile patch).

---

## The actual problem chain

```
sandbox-setup.sh builds openclaw-sandbox:bookworm-slim
  └── Sets USER sandbox at the end of the Dockerfile
      └── sandbox-common-setup.sh builds FROM openclaw-sandbox:bookworm-slim
          └── Inherits USER sandbox as default build user
              └── RUN apt-get update → runs as sandbox_user
                  └── Permission denied on /var/lib/apt/lists/partial
                      └── Build fails silently (set +e)
                          └── No openclaw-sandbox-toolkit:bookworm-slim image
                              └── claude sandbox can't build (depends on common)
                                  └── Agents get no sandbox or only base sandbox
```

The fix is straightforward: the upstream sandbox-common-setup.sh heredoc Dockerfile needs USER root before apt-get. On a normal host install this same bug exists, but the gateway handles it gracefully and falls back. In our setup the extras entrypoint catches it and rebuilds.

So to answer your original question: **the upstream script doesn't work anywhere** – it's broken on both host and container installs. The difference is just how the failure manifests (silent degradation vs crash-loop, now fixed to silent degradation with optional fallback rebuild).

---

## Chosen fix: BASE_IMAGE override

**Approach:** The upstream script exposes `BASE_IMAGE` as an overridable env var. We build a rooted intermediate image (`FROM openclaw-sandbox:bookworm-slim` + `USER root`), pass it via `BASE_IMAGE`, then fix `USER 1000` on the output image.

**Why this approach:**

| Option | Gets all packages | Fragile | Maintenance |
|--------|:-:|:-:|:-:|
| **A: BASE_IMAGE override (chosen)** | Yes | No | Low |
| B: Sed-patch script | Yes | Yes (depends on heredoc format) | Medium |
| C: Skip upstream entirely | Partial (must replicate bun/brew setup) | No | High |
| D: Fallback only (old approach) | No (omits golang, rust, bun, brew) | No | Low |

**Build sequence** (in entrypoint `set +e` subshell):

1. Build rooted intermediate: `FROM openclaw-sandbox:bookworm-slim` + `USER root` → tag `openclaw-sandbox-base-root:bookworm-slim`
2. Run upstream: `BASE_IMAGE=openclaw-sandbox-base-root:bookworm-slim PACKAGES="...+ffmpeg+imagemagick" /app/scripts/sandbox-common-setup.sh`
3. Fix security: `FROM openclaw-sandbox-toolkit:bookworm-slim` + `USER 1000` → re-tag
4. Cleanup: `docker rmi openclaw-sandbox-base-root:bookworm-slim`
5. If any step fails → log ERROR, no fallback (surfaces during deployment verification)

**Package layering (corrected):**

| Image | Adds | Inherits from |
|-------|------|---------------|
| `openclaw-sandbox` | bash, curl, git, jq, python3, ripgrep | debian:bookworm-slim |
| `openclaw-sandbox-toolkit` | node, npm, pnpm, bun, go, rust, build-essential, **ffmpeg, imagemagick**, brew | openclaw-sandbox |
| `openclaw-sandbox-claude` | Claude Code CLI only | openclaw-sandbox-toolkit |
| `openclaw-sandbox-browser` | chromium, xvfb, novnc | debian:bookworm-slim |

**Self-healing:** If upstream ever fixes the bug, the intermediate image becomes harmless — the script succeeds with or without it, and `USER 1000` at the end is a no-op if already set.

**Implemented in:** `playbooks/04-vps1-openclaw.md` section 4.10 (entrypoint) + sandbox verification section.
