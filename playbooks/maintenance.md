# Maintenance

Ongoing maintenance procedures for the OpenClaw deployment.

## Token Rotation

All secrets should be rotated on a regular cadence. If a token is suspected compromised, rotate immediately.

### Token Inventory

| Token | Location | Rotation Cadence |
|-------|----------|-----------------|
| Gateway token (per-claw) | VPS `<INSTALL_DIR>/instances/<name>/.openclaw/openclaw.json` | 90 days |
| `AI_GATEWAY_AUTH_TOKEN` | Local `.env` + AI Gateway Worker secret | 90 days |
| `LOG_WORKER_TOKEN` | Local `.env` + Log Receiver Worker secret | 90 days |
| Provider API keys (Anthropic, OpenAI, etc.) | AI Gateway Worker secrets (Cloudflare Dashboard) | Per provider policy |
| `HOSTALERT_TELEGRAM_BOT_TOKEN` | Local `.env` (deployed via `npm run pre-deploy`) | As needed |
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
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d openclaw-<CLAW_NAME>'

# 5. Update all paired devices with new token (existing browser URLs will need the new token parameter)
# Repeat steps 2-5 for each claw being rotated
```

> **Note:** Each claw reads its token from its own `openclaw.json` (resolved at startup via `envsubst`). The `.gateway-token` file is the persistent source.

> **Verify:** Run § 7.1 — each rotated claw's health endpoint responds. Re-pair devices per `08b-pair-devices.md`.

#### AI Gateway Auth Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/ai-gateway
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update AI_GATEWAY_TOKEN in local .env, rebuild and push artifacts
npm run pre-deploy
# Push updated artifacts to VPS (via .deploy/ or SCP)

# 4. Recreate all claws to pick up new env values
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d'
```

> **Verify:** Run § 7.3 — AI Gateway Worker health check returns `{"status":"ok"}`.

#### Log Worker Token

> **Skip** if `stack.logging.vector` is `false`.

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/log-receiver
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update LOG_WORKER_TOKEN in local .env, rebuild and push artifacts
npm run pre-deploy
# Push updated artifacts to VPS (via .deploy/ or SCP)

# 4. Recreate Vector to pick up new env values (see CLAUDE.md: restart vs up -d)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d vector'
```

> **Verify:** Run § 7.2 (Vector running) and § 7.3 (Log Receiver Worker health check returns `{"status":"ok"}`).

#### Provider API Keys

Provider API keys are stored as Cloudflare Worker secrets in the AI Gateway Worker. They never touch the VPS.

**Direct API mode** (default):

```bash
# From local machine
cd workers/ai-gateway
echo "new-key-value" | npx wrangler secret put ANTHROPIC_API_KEY
echo "new-key-value" | npx wrangler secret put OPENAI_API_KEY
```

**CF AI Gateway mode** (optional): If using Cloudflare AI Gateway, also rotate the gateway token:

```bash
echo "new-token" | npx wrangler secret put CF_AI_GATEWAY_TOKEN
```

See [`docs/AI-GATEWAY-CONFIG.md`](../docs/AI-GATEWAY-CONFIG.md) for details on both modes.

> **Verify:** Run § 7.3 — AI Gateway Worker health check. Full LLM routing verified during § 7.7 (E2E test).

#### SSH Keys

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

**When to run:**

- Monthly, for security patches (apt package updates)
- When entrypoint logs a staleness warning (images > 30 days old)
- After editing `sandbox-toolkit.yaml` — auto-detected on next container restart, but `update-sandboxes.sh` applies immediately without restart

> **Verify:** Run § 7.1a — all sandbox toolkit binaries operational in sandbox container.

### Bind-Mounted Deploy Files

Several deploy files are bind-mounted read-only into claw containers. These can be updated without a full image rebuild — just SCP the file and restart the claws.

**Bind-mounted files:** `dashboard/`, `entrypoint.sh`, `rebuild-sandboxes.sh`, `parse-toolkit.mjs`, `sandbox-toolkit.yaml`, `plugins/`

```bash
# From local machine — copy to VPS (use -r for directories like dashboard/ or plugins/)
scp -i <SSH_KEY> -P <SSH_PORT> [-r] deploy/openclaw-stack/<path> adminclaw@<VPS_IP>:/tmp/deploy-update

# Move into place, fix ownership, and restart all claws (single SSH session)
ssh -i <SSH_KEY> -p <SSH_PORT> adminclaw@<VPS_IP> "
  sudo rm -rf <INSTALL_DIR>/openclaw-stack/<path>
  sudo cp -r /tmp/deploy-update <INSTALL_DIR>/openclaw-stack/<path>
  sudo chown -R 1000:1000 <INSTALL_DIR>/openclaw-stack/<path>
  rm -rf /tmp/deploy-update
  sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose restart'
"
```

> To restart only a specific claw: `docker compose restart openclaw-<CLAW_NAME>`

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
# From local machine
# 1. Rebuild deployment artifacts
npm run pre-deploy

# 2. Copy the updated claw config to VPS
scp -P ${SSH_PORT} -i ${SSH_KEY} .deploy/claws/personal-claw/openclaw.json \
  ${SSH_USER}@${VPS_IP}:${INSTALL_DIR}/instances/personal-claw/.openclaw/openclaw.json

# 3. Restart that claw to pick up new config (restart is fine for bind-mounted file changes)
ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
  "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose restart openclaw-personal-claw'"
```

---

## Adding a New Claw

1. Add a new entry under `claws` in `stack.yml` with per-claw overrides (domain, resources, Telegram bot token, etc.)
2. Add the claw's Telegram bot token to `.env` (e.g., `NEW_CLAW_TELEGRAM_BOT_TOKEN=...`)
3. Rebuild deployment artifacts:
   ```bash
   npm run pre-deploy
   ```
4. Push updated artifacts to VPS:
   ```bash
   scp -P ${SSH_PORT} -i ${SSH_KEY} -r .deploy/* ${SSH_USER}@${VPS_IP}:${INSTALL_DIR}/.deploy-staging/
   ```
5. Copy the new claw's config and updated compose file into place:
   ```bash
   ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} "
     sudo -u openclaw mkdir -p ${INSTALL_DIR}/instances/<name>/.openclaw
     sudo -u openclaw cp ${INSTALL_DIR}/.deploy-staging/claws/<name>/openclaw.json ${INSTALL_DIR}/instances/<name>/.openclaw/
     sudo -u openclaw cp ${INSTALL_DIR}/.deploy-staging/docker-compose.yml ${INSTALL_DIR}/docker-compose.yml
   "
   ```
6. Start the new claw:
   ```bash
   ssh -i ${SSH_KEY} -p ${SSH_PORT} ${SSH_USER}@${VPS_IP} \
     "sudo -u openclaw bash -c 'cd ${INSTALL_DIR} && docker compose up -d openclaw-<name>'"
   ```
