# Maintenance

Ongoing maintenance procedures for the OpenClaw deployment.

## Token Rotation

All secrets should be rotated on a regular cadence. If a token is suspected compromised, rotate immediately.

### Token Inventory

| Token | Location | Rotation Cadence |
|-------|----------|-----------------|
| Gateway token (per-claw) | VPS `<INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json` | 90 days |
| `AI_GATEWAY_TOKEN` (user token) | Local `.env` + AI Gateway KV (`token:*`) | 90 days |
| `AI_WORKER_ADMIN_AUTH_TOKEN` | `.env` + AI Gateway Worker secret | 90 days |
| `LOG_WORKER_TOKEN` | Local `.env` + Log Receiver Worker secret | 90 days |
| Provider API keys (Anthropic, OpenAI, etc.) | AI Gateway KV (`creds:*`) — managed via `/config` UI | Per provider policy |
| `EGRESS_PROXY_AUTH_TOKEN` | Local `.env` + AI Gateway Worker secret + VPS egress proxy container | 90 days |
| `EGRESS_PROXY_URL` | AI Gateway Worker secret | Only if hostname changes |
| `HOSTALERT_TELEGRAM_BOT_TOKEN` | Local `.env` (deployed via `npm run pre-deploy`) | As needed |
| `SANDBOX_REGISTRY_TOKEN` | Local `.env` + VPS `sandbox-registry/htpasswd` | 90 days |
| SSH keys (`~/.ssh/vps1_openclaw_ed25519`) | Local machine + VPS `authorized_keys` | Annual |

### Rotation Procedures

#### Gateway Token

Each claw has its own `GATEWAY_TOKEN` resolved from its environment. Rotate each claw's token independently.

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Write new token to per-claw .gateway-token file
echo "$NEW_TOKEN" | sudo tee <INSTALL_DIR>/instances/<CLAW_NAME>/.openclaw/.gateway-token > /dev/null

# 3. Update the .env with the new token
# Edit <INSTALL_DIR>/.env to update the claw's GATEWAY_TOKEN variable

# 4. Recreate the claw container (up -d, NOT restart — restart doesn't reload .env)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d <PROJECT_NAME>-openclaw-<CLAW_NAME>'

# 5. Update all paired devices with new token (existing browser URLs will need the new token parameter)
# Repeat steps 2-5 for each claw being rotated
```

> **Note:** Each claw reads its token from its own `openclaw.json` (resolved at startup via `envsubst`). The `.gateway-token` file is the persistent source.

> **Verify:** Run § 7.1 — each rotated claw's health endpoint responds. Re-pair devices per `08b-pair-devices.md`.

#### AI Gateway User Token

The user token (`AI_GATEWAY_TOKEN`) is stored in KV and can be rotated via the self-service endpoint. The old token remains valid for 1 hour after rotation.

```bash
# 1. Rotate token (from local machine)
curl -s -X POST https://<AI_GATEWAY_WORKER_URL>/auth/rotate \
  -H "Authorization: Bearer <AI_GATEWAY_TOKEN>" | jq .
# Returns: { "token": "<new-token>", "oldTokensExpireAt": "..." }

# 2. Update AI_GATEWAY_TOKEN in local .env with the new token, rebuild and push artifacts
npm run pre-deploy
scripts/sync-deploy.sh

# 3. Recreate all claws to pick up new env values
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
```

> **Note:** Old tokens expire after 1 hour (KV native TTL). Complete the VPS update within that window.

> **Verify:** Run § 7.3 — AI Gateway Worker health check returns `{"status":"ok"}`.

#### AI Gateway Admin Token

The `AI_WORKER_ADMIN_AUTH_TOKEN` protects `/admin/*` endpoints. Rotate via `update-env.mjs`:

```bash
node build/update-env.mjs AI_WORKER_ADMIN_AUTH_TOKEN --generate
source scripts/lib/source-config.sh --force
cd workers/ai-gateway
echo "$AI_WORKER_ADMIN_AUTH_TOKEN" | npx wrangler secret put ADMIN_AUTH_TOKEN
```

No VPS update needed (admin token is not used by claws).

#### Log Worker Token

> **Skip** if `stack.logging.vector` is `false`.

```bash
# 1. Generate new token and update .env
node build/update-env.mjs LOG_WORKER_TOKEN --generate
source scripts/lib/source-config.sh --force

# 2. Update Worker secret (from local machine)
cd workers/log-receiver
echo "$ENV__LOG_WORKER_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Rebuild and push artifacts
npm run pre-deploy
scripts/sync-deploy.sh

# 4. Recreate Vector to pick up new env values (see CLAUDE.md: restart vs up -d)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d vector'
```

> **Verify:** Run § 7.2 (Vector running) and § 7.3 (Log Receiver Worker health check returns `{"status":"ok"}`).

#### Provider API Keys

Provider credentials are stored in Cloudflare KV (per-user). Rotate them via the self-service config UI:

1. Visit `https://<AI_GATEWAY_WORKER_URL>/config`
2. Authenticate with the user's gateway token
3. Update the relevant credential fields
4. Save

No VPS restart needed — credential changes take effect immediately.

**CF AI Gateway mode** (optional): If using Cloudflare AI Gateway, also rotate the gateway token:

```bash
cd workers/ai-gateway
echo "new-token" | npx wrangler secret put CF_AI_GATEWAY_TOKEN
```

See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for details.

> **Verify:** Run § 7.3 — AI Gateway Worker health check. Full LLM routing verified during § 7.7 (E2E test).

#### Egress Proxy Token

> **Skip** if `stack.egress_proxy` is not configured in `stack.yml`.

The egress proxy auth token is shared between the AI Gateway Worker and the VPS egress proxy container. Rotate both simultaneously:

```bash
# 1. Generate new token and update .env
node build/update-env.mjs EGRESS_PROXY_AUTH_TOKEN --generate
source scripts/lib/source-config.sh --force

# 2. Update AI Gateway Worker secrets
cd workers/ai-gateway
echo "$STACK__STACK__EGRESS_PROXY__AUTH_TOKEN" | npx wrangler secret put EGRESS_PROXY_AUTH_TOKEN

# 3. Rebuild and push artifacts
npm run pre-deploy
scripts/sync-deploy.sh

# 4. Recreate the egress proxy container to pick up new env values
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d egress-proxy'
```

> **Verify:** Run § 7.2a — egress proxy health check. Test a codex request end-to-end if possible.

#### Sandbox Registry Token

> **Skip** if `stack.sandbox_registry` is not configured in `stack.yml`.

```bash
# 1. Generate new token and update .env
node build/update-env.mjs SANDBOX_REGISTRY_TOKEN --generate

# 2. Rebuild and push artifacts (regenerates htpasswd with bcrypt)
npm run pre-deploy
scripts/sync-deploy.sh

# 3. Restart the registry container to reload the new htpasswd
# (bind-mounted read-only — restart picks up new file from disk)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose restart sandbox-registry'

# 4. Recreate all claws to pass the new token into containers
# (env vars are baked at container creation — restart won't reload them)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
```

> **Note:** Steps 3 and 4 must happen in order — the registry needs the new htpasswd before claws attempt to login with the new token.

> **Verify:** Check entrypoint logs for "Logging into sandbox registry" without a WARNING line.

#### SSH Keys

If your deployment uses agent-based auth, rotate the underlying key in your agent and update `SSH_IDENTITY_AGENT` only if the socket path changes. The file-based example below applies when `.env` uses `SSH_KEY`.

```bash
# 1. Generate new key pair (local machine)
ssh-keygen -t ed25519 -f ~/.ssh/vps1_openclaw_ed25519_new

# 2. Add new public key to VPS (while old key still works)
ssh -i ~/.ssh/vps1_openclaw_ed25519 -p <SSH_PORT> adminclaw@<VPS_IP> \
  "echo 'NEW_PUBLIC_KEY' >> ~/.ssh/authorized_keys"

# 3. Test new key
ssh -i ~/.ssh/vps1_openclaw_ed25519_new -p <SSH_PORT> adminclaw@<VPS_IP> echo "OK"

# 4. Remove old key from VPS authorized_keys
# 5. Update .env with new SSH_KEY path
# 6. Delete old private key
```

> **Verify:** Run § 7.6 — SSH on port `<SSH_PORT>` with new key, key-only auth confirmed.

#### Cloudflare Tunnel Token

See [docs/CLOUDFLARE-TUNNEL.md](../docs/CLOUDFLARE-TUNNEL.md#rotating-tunnel-token) for rotation procedure.

> **Verify:** Run § 7.4 — cloudflared container running, domain routing returns 302/403.

## Deploying Changes

Use `scripts/deploy.sh` to push local changes to the VPS. It runs `npm run pre-deploy`, syncs configs and workspaces, and auto-restarts services when config changes require it.

```bash
# Standard deploy (all claws)
scripts/deploy.sh

# Deploy a single claw
scripts/deploy.sh --instance personal-claw

# Overwrite VPS configs + workspaces (skip drift detection)
scripts/deploy.sh --force

# Preview without making changes
scripts/deploy.sh --dry-run

# Skip auto-restart (prints manual restart command instead)
scripts/deploy.sh --no-restart
```

After deploying, verify with § 7.1 then tag the successful deploy:

```bash
scripts/tag-deploy.sh "description of changes"
```

> **Note:** `deploy.sh` is for iterative updates. Fresh deploys use `sync-deploy.sh --fresh` directly (see `00-fresh-deploy-setup.md`).

---

## Image Updates

### Sandbox Images

Sandbox images (base, toolkit, browser) persist across container restarts in per-instance Docker storage. The entrypoint auto-rebuilds when:

- An image is **missing** (first boot or after manual removal)
- **`sandbox-toolkit.yaml` changes** — config is embedded as a Docker label; entrypoint compares current config against the label and rebuilds on mismatch

For manual updates (security patches, new apt packages):

```bash
# From local machine — rebuilds toolkit + base if needed
scripts/update-sandboxes.sh

# Also rebuild browser sandbox
scripts/update-sandboxes.sh --all

# Preview what would be rebuilt
scripts/update-sandboxes.sh --dry-run
```

No container restart needed — builds happen inside the running container's nested Docker. New sandbox containers launched by agents automatically use the rebuilt images.

**With sandbox registry:** When `sandbox_registry` is configured, `update-sandboxes.sh` on one claw builds and pushes updated images to the registry. Other claws pull the updated images on their next restart, avoiding redundant builds.

**When to run:**

- Monthly, for security patches (apt package updates)
- When entrypoint logs a staleness warning (images > 30 days old)
- After editing `sandbox-toolkit.yaml` — auto-detected on next container restart, but `update-sandboxes.sh` applies immediately without restart

**Registry garbage collection:** Old image layers accumulate in the registry. Reclaim disk space periodically:

```bash
# Run GC on the sandbox registry container
sudo docker exec <PROJECT_NAME>-sandbox-registry bin/registry garbage-collect /etc/docker/registry/config.yml
```

> **Verify:** Run § 7.1a — all sandbox toolkit binaries operational in sandbox container.

### Bind-Mounted Deploy Files

Several deploy files are bind-mounted read-only into claw containers. These can be updated without a full image rebuild — rebuild artifacts, sync, and restart.

**Bind-mounted files:** `dashboard/`, `entrypoint.sh`, `rebuild-sandboxes.sh`, `parse-toolkit.mjs`, `sandbox-toolkit.yaml`, `plugins/`

```bash
# From local machine — rebuild, sync, and auto-restart if needed
scripts/deploy.sh

# Tag successful deploy after verifying services are healthy
scripts/tag-deploy.sh "updated bind-mounted files"
```

> Bind-mounted file changes only need `docker compose restart` (not `up -d`). If `deploy.sh` detects no restart-required config changes, you may still need a manual restart for bind-mounted files:
> `ssh ... "sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose restart'"`

> **Note:** `sandbox-toolkit.yaml` changes are also auto-detected on container restart via Docker label comparison, triggering a sandbox image rebuild if needed.

> **Verify:** Run § 7.1 — claw health endpoints respond after restart.

### OpenClaw Image

Update OpenClaw to the latest upstream version:

```bash
# From local machine — pulls upstream, rebuilds image, recreates all claws
scripts/update-openclaw.sh
```

Brief downtime (~5-10s) per claw during container swap. The script waits for health checks to pass before reporting success.

> **Verify:** Run § 7.1 (container health) and § 7.5b (CLI pairing still works).

---

## Updating a Single Claw's Configuration

To update just one claw's `openclaw.json` without affecting other claws:

```bash
# From local machine — builds, syncs config + workspaces, auto-restarts if needed
scripts/deploy.sh --instance personal-claw
```

Hot-reloadable config changes (agents, skills, models) take effect without restart. Changes that require restart (env vars, ports, gateway settings) trigger auto-restart via `deploy.sh`.

---

## Adding a New Claw

1. Add a new entry under `claws` in `stack.yml` with per-claw overrides (domain, resources, Telegram bot token, etc.)
2. Add the claw's Telegram bot token to `.env` (e.g., `NEW_CLAW_TELEGRAM_BOT_TOKEN=...`)
3. Deploy (builds, syncs configs + workspaces, auto-starts the new service):
   ```bash
   scripts/deploy.sh
   ```
4. Tag successful deploy after verifying the new claw is healthy:
   ```bash
   scripts/tag-deploy.sh "added <name> claw"
   ```

---

## Deploy History

The VPS INSTALL_DIR is a git repo that tracks deploy-managed config. Each `sync-deploy.sh` run auto-commits changes, and `tag-deploy.sh` marks successful deploys.

```bash
# View deploy history
ssh ... "cd <INSTALL_DIR> && git log --oneline --decorate"

# Show what changed in a specific deploy
ssh ... "cd <INSTALL_DIR> && git show <commit> --stat"

# Diff between two deploys (or a deploy and a tag)
ssh ... "cd <INSTALL_DIR> && git diff <tag1>..<tag2>"

# List all deploy tags
ssh ... "cd <INSTALL_DIR> && git tag -l 'deploy-*'"

# Roll back to a previous deploy state (review diff first)
ssh ... "cd <INSTALL_DIR> && git diff HEAD..<tag> --stat"
ssh ... "cd <INSTALL_DIR> && git checkout <tag> -- ."
# Then: docker compose up -d to apply
```
