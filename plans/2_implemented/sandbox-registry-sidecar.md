# Plan: Local Sandbox Image Registry

## Context

Each OpenClaw claw runs an isolated nested Docker daemon (Sysbox). Sandbox images (base, packages, toolkit, browser) are built identically from `sandbox-toolkit.yaml` but must exist in each claw's separate Docker storage. With N claws, that's N independent 15-25 min builds of the same images. The old tar-based `sync-images` approach was lost during the multi-claw refactor. A local Docker registry is the robust, scalable replacement — first claw to build pushes, all others pull (~30s), no orchestration needed.

**Workflow after this change:**

```
# First claw starts → builds sandbox images → pushes to registry
# Second claw starts → pulls from registry (~30s) → skips build
# On toolkit config change → one claw rebuilds → pushes → others pull on next restart
```

---

## 1. Stack Configuration

### `stack.yml.example` — add `sandbox_registry` under `stack:`

```yaml
  # Local Docker registry for sharing sandbox images between claws.
  # First claw to build pushes images; others pull (~30s vs ~15min build).
  sandbox_registry:
    port: 5100                               # host port (own registry)
    token: ${SANDBOX_REGISTRY_TOKEN}         # htpasswd basic auth

  # OR: use another stack's registry (no container in this stack):
  # sandbox_registry:
  #   url: "10.0.0.1:5100"                  # external registry address
  #   token: ${SANDBOX_REGISTRY_TOKEN}       # must match the registry's token
```

### `.env.example` — add token

```bash
SANDBOX_REGISTRY_TOKEN=          # Auto-generated if empty; shared across stacks that share a registry
```

### Config resolution (`pre-deploy.mjs`)

- `sandbox_registry.port` set (no `url`) → **run own registry**, publish on host port, generate htpasswd
- `sandbox_registry.url` set (no `port`) → **use external**, no container, pass URL to claws
- Neither / absent → **disabled**, claws build independently (backwards compatible)

---

## 2. Compose Template (`docker-compose.yml.hbs`)

### 2a. Registry service (conditional, after egress-proxy block)

```handlebars
{{#if stack.sandbox_registry_container}}
  # ── Sandbox Image Registry ──────────────────────────────────
  sandbox-registry:
    image: registry:2
    container_name: {{stack.project_name}}-sandbox-registry
    restart: unless-stopped
    ports:
      - "0.0.0.0:{{stack.sandbox_registry.port}}:5000"
    volumes:
      - {{stack.install_dir}}/sandbox-registry/data:/var/lib/registry
      - {{stack.install_dir}}/sandbox-registry/htpasswd:/auth/htpasswd:ro
    environment:
      - REGISTRY_AUTH=htpasswd
      - REGISTRY_AUTH_HTPASSWD_REALM=openclaw-sandbox
      - REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd
      - REGISTRY_STORAGE_DELETE_ENABLED=true
    networks: [openclaw-net]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:5000/v2/"]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 64M
{{/if}}
```

Port binds `0.0.0.0` so claws (and cross-stack claws) can reach it via host gateway IP.

### 2b. Claw environment additions (inside `{{#each claws}}`)

```yaml
{{#if ../stack.sandbox_registry}}
      # ── Sandbox Registry ──
      - SANDBOX_REGISTRY_PORT={{../stack.sandbox_registry_port}}
      - SANDBOX_REGISTRY_URL={{../stack.sandbox_registry_url}}
      - SANDBOX_REGISTRY_USER=openclaw
      - SANDBOX_REGISTRY_TOKEN={{../stack.sandbox_registry.token}}
{{/if}}
```

- `SANDBOX_REGISTRY_PORT` — set when running own registry (entrypoint computes host gateway IP at runtime)
- `SANDBOX_REGISTRY_URL` — set when using external registry (used directly)

---

## 3. Pre-Deploy Changes (`build/pre-deploy.mjs`)

### 3a. Derived values in `computeDerivedValues()`

```javascript
if (stack.sandbox_registry) {
  const sr = stack.sandbox_registry;
  if (sr.port && !sr.url) {
    stack.sandbox_registry_container = true;
    stack.sandbox_registry_port = sr.port;
    stack.sandbox_registry_url = "";  // Computed at runtime in entrypoint
  } else if (sr.url) {
    stack.sandbox_registry_container = false;
    stack.sandbox_registry_port = "";
    stack.sandbox_registry_url = sr.url;
  }
}
```

### 3b. Generate htpasswd file (after compose artifacts)

When `sandbox_registry_container` is true, generate `sandbox-registry/htpasswd`:

```javascript
if (stack.sandbox_registry_container) {
  const token = stack.sandbox_registry.token;
  if (!token) fatal("sandbox_registry.token is required");
  const htpasswdDir = join(DEPLOY_DIR, "sandbox-registry");
  mkdirSync(htpasswdDir, { recursive: true });
  let htpasswdLine;
  try {
    htpasswdLine = execSync(`htpasswd -nbB openclaw "${token}"`, { encoding: "utf8" }).trim();
  } catch {
    try {
      htpasswdLine = execSync(
        `docker run --rm httpd:2 htpasswd -nbB openclaw "${token}"`, { encoding: "utf8" }
      ).trim();
    } catch {
      fatal("Cannot generate htpasswd. Install apache2-utils or ensure Docker is running.");
    }
  }
  writeFileSync(join(htpasswdDir, "htpasswd"), htpasswdLine + "\n");
  success("Generated sandbox-registry/htpasswd");
}
```

### 3c. Add to `generateStackEnv()`

```javascript
if (stack.sandbox_registry) {
  lines.push(`STACK__STACK__SANDBOX_REGISTRY__PORT=${stack.sandbox_registry_port || ""}`);
  lines.push(`STACK__STACK__SANDBOX_REGISTRY__URL=${stack.sandbox_registry_url || ""}`);
}
```

---

## 4. Sync Deploy (`scripts/sync-deploy.sh`)

Add sync for `sandbox-registry/` (htpasswd) alongside egress-proxy sync:

```bash
if [ -d "${DEPLOY_DIR}/sandbox-registry" ]; then
  info "Syncing sandbox-registry/..."
  ${SSH_CMD} "${VPS}" "sudo mkdir -p ${INSTALL_DIR}/sandbox-registry/data"
  do_rsync --delete \
    "${DEPLOY_DIR}/sandbox-registry/" \
    "${VPS}:${INSTALL_DIR}/sandbox-registry/"
  success "sandbox-registry/"
fi
```

Add to ownership fix section:

```bash
if [ -d "${DEPLOY_DIR}/sandbox-registry" ]; then
  ${SSH_CMD} "${VPS}" "sudo chown -R openclaw:openclaw ${INSTALL_DIR}/sandbox-registry"
fi
```

---

## 5. Entrypoint Changes (`deploy/openclaw-stack/entrypoint.sh`)

### 5a. Compute registry URL (before dockerd start, ~line 158)

```bash
REGISTRY_URL=""
if [ -n "$SANDBOX_REGISTRY_URL" ]; then
  REGISTRY_URL="$SANDBOX_REGISTRY_URL"
elif [ -n "$SANDBOX_REGISTRY_PORT" ]; then
  HOST_GW=$(ip route | awk '/default/ {print $3}')
  REGISTRY_URL="${HOST_GW}:${SANDBOX_REGISTRY_PORT}"
fi
```

### 5b. Add `--insecure-registry` to dockerd (modify line 161-165)

```bash
DOCKERD_ARGS="--host=unix:///var/run/docker.sock --storage-driver=overlay2 --log-level=warn"
DOCKERD_ARGS="$DOCKERD_ARGS --group=$(getent group docker | cut -d: -f3)"
if [ -n "$REGISTRY_URL" ]; then
  DOCKERD_ARGS="$DOCKERD_ARGS --insecure-registry=$REGISTRY_URL"
fi
dockerd $DOCKERD_ARGS > /var/log/dockerd.log 2>&1 &
```

### 5c. Docker login after daemon ready (after line 184)

```bash
if [ -n "$REGISTRY_URL" ] && [ -n "$SANDBOX_REGISTRY_TOKEN" ]; then
  echo "[entrypoint] Logging into sandbox registry at ${REGISTRY_URL}..."
  echo "$SANDBOX_REGISTRY_TOKEN" | docker login "$REGISTRY_URL" \
    -u "${SANDBOX_REGISTRY_USER:-openclaw}" --password-stdin 2>/dev/null || \
    echo "[entrypoint] WARNING: Registry login failed (registry may not be ready yet)"
fi
```

### 5d. Export REGISTRY_URL for rebuild-sandboxes.sh

```bash
export SANDBOX_REGISTRY_URL="$REGISTRY_URL"
```

---

## 6. Rebuild Sandboxes (`deploy/openclaw-stack/rebuild-sandboxes.sh`)

### 6a. Registry helper functions (near top, ~line 35)

```bash
REGISTRY_URL="${SANDBOX_REGISTRY_URL:-}"

registry_pull() {
  [ -n "$REGISTRY_URL" ] || return 1
  local img="$1"
  local remote="${REGISTRY_URL}/${img}"
  if docker pull "$remote" 2>/dev/null; then
    docker tag "$remote" "$img"
    log "Pulled $img from registry"
    return 0
  fi
  return 1
}

registry_push() {
  [ -n "$REGISTRY_URL" ] || return 0
  local img="$1"
  local remote="${REGISTRY_URL}/${img}"
  if docker tag "$img" "$remote" && docker push "$remote" 2>/dev/null; then
    log "Pushed $img to registry"
    docker rmi "$remote" 2>/dev/null || true
  else
    log "WARNING: Failed to push $img to registry (non-fatal)"
  fi
}
```

### 6b. Pull before builds (~line 612)

```bash
if [ -n "$REGISTRY_URL" ]; then
  log "Checking sandbox registry for cached images..."
  registry_pull "openclaw-sandbox:bookworm-slim"
  registry_pull "openclaw-sandbox-packages:bookworm-slim"
  registry_pull "openclaw-sandbox-toolkit:bookworm-slim"
  registry_pull "openclaw-sandbox-browser:bookworm-slim"
fi
```

Existing label-based change detection then skips builds if pulled images match current config.

### 6c. Push after builds (~after line 630)

```bash
if [ -n "$REGISTRY_URL" ] && [ "$FAILED" -eq 0 ]; then
  log "Pushing sandbox images to registry..."
  registry_push "openclaw-sandbox:bookworm-slim"
  registry_push "openclaw-sandbox-packages:bookworm-slim"
  registry_push "openclaw-sandbox-toolkit:bookworm-slim"
  registry_push "openclaw-sandbox-browser:bookworm-slim"
fi
```

---

## 7. Start Claws (`deploy/host/start-claws.sh`)

With registry, all claws can start simultaneously — no staggering needed:

```bash
if [ "$CLAW_COUNT" -gt 1 ] && [ -z "$STACK__STACK__SANDBOX_REGISTRY__PORT" ] && [ -z "$STACK__STACK__SANDBOX_REGISTRY__URL" ]; then
  echo "Multi-claw (no registry): starting openclaw-${FIRST_CLAW} first..." >&2
  sudo -u openclaw bash -c "cd ${COMPOSE_DIR} && docker compose up -d openclaw-${FIRST_CLAW}"
else
  echo "Starting all services..." >&2
  sudo -u openclaw bash -c "cd ${COMPOSE_DIR} && docker compose up -d"
fi
```

---

## 8. VPS Gitignore (`deploy/vps-gitignore`)

Add to the existing gitignore:

```gitignore
# Sandbox registry runtime data
sandbox-registry/data/
```

The `sandbox-registry/htpasswd` file IS tracked (deploy-managed config).

---

## 9. Playbook Updates

### `playbooks/04-vps1-openclaw.md`

- **§4.4 Step 3:** Note that with sandbox registry, all claws start simultaneously. Staggered start only without registry.

### `playbooks/maintenance.md`

- **Sandbox Images section:** `update-sandboxes.sh` on one claw pushes to registry; others pull on restart.
- **New note:** Registry GC command for reclaiming disk from old images.

### `stack.yml.example`

- Add `sandbox_registry` block with inline comments.

---

## Files

| File | Change |
|------|--------|
| `stack.yml.example` | Add `sandbox_registry` config |
| `.env.example` | Add `SANDBOX_REGISTRY_TOKEN` |
| `docker-compose.yml.hbs` | Add registry service, claw env vars |
| `build/pre-deploy.mjs` | Derived values, htpasswd gen, stack.env |
| `deploy/openclaw-stack/entrypoint.sh` | URL computation, `--insecure-registry`, `docker login` |
| `deploy/openclaw-stack/rebuild-sandboxes.sh` | Registry pull/push helpers |
| `deploy/host/start-claws.sh` | Start all when registry available |
| `deploy/vps-gitignore` | Add `sandbox-registry/data/` |
| `scripts/sync-deploy.sh` | Sync sandbox-registry/ dir |
| `playbooks/04-vps1-openclaw.md` | Update multi-claw startup |
| `playbooks/maintenance.md` | Registry notes |

---

## Verification

1. **Backwards compat**: No `sandbox_registry` → no registry in compose, builds as before
2. **Own registry**: `port: 5100` + token → registry in compose, htpasswd generated, claws get env vars
3. **First claw builds + pushes**: Entrypoint logs show "Pushed to registry"
4. **Second claw pulls**: Entrypoint logs show "Pulled from registry", build skipped
5. **Config change**: Update `sandbox-toolkit.yaml` → claw rebuilds (hash mismatch) → pushes → others pull on restart
6. **External registry**: `url` set → no container, claws pull from external
7. **Auth**: `curl http://localhost:5100/v2/` → 401 without auth, 200 with auth
