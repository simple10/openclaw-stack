# Maintenance

Ongoing maintenance procedures for the OpenClaw deployment.

## Token Rotation

All secrets should be rotated on a regular cadence. If a token is suspected compromised, rotate immediately.

### Token Inventory

| Token | Location | Rotation Cadence |
|-------|----------|-----------------|
| `OPENCLAW_GATEWAY_TOKEN` | VPS `/home/openclaw/openclaw/.env` | 90 days |
| `AI_GATEWAY_AUTH_TOKEN` | VPS `.env` + AI Gateway Worker secret | 90 days |
| `LOG_WORKER_TOKEN` | VPS `.env` + Log Receiver Worker secret | 90 days |
| Provider API keys (Anthropic, OpenAI, etc.) | AI Gateway Worker secrets (Cloudflare Dashboard) | Per provider policy |
| `HOSTALERT_TELEGRAM_BOT_TOKEN` | VPS `.env` | As needed |
| SSH keys (`~/.ssh/vps1_openclaw_ed25519`) | Local machine + VPS `authorized_keys` | Annual |

### Rotation Procedures

#### Gateway Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update .env on VPS
# Edit /home/openclaw/openclaw/.env — change OPENCLAW_GATEWAY_TOKEN value

# 3. Update openclaw.json on VPS
# Edit /home/openclaw/.openclaw/openclaw.json — update gateway.auth.token and gateway.remote.token

# 4. Recreate gateway to pick up new .env values (see CLAUDE.md: restart vs up -d)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway'

# 5. Update all paired devices with new token (existing browser URLs will need the new token parameter)
```

#### AI Gateway Auth Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/ai-gateway
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update VPS .env — change AI_GATEWAY_AUTH_TOKEN value

# 4. Recreate gateway to pick up new .env values (no rebuild needed — token is an env var)
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d openclaw-gateway'
```

#### Log Worker Token

> **Skip** if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/log-receiver
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update VPS vector/.env — change LOG_WORKER_TOKEN value

# 4. Recreate Vector to pick up new .env values (see CLAUDE.md: restart vs up -d)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
```

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

#### SSH Keys

```bash
# 1. Generate new key pair (local machine)
ssh-keygen -t ed25519 -f ~/.ssh/vps1_openclaw_ed25519_new

# 2. Add new public key to VPS (while old key still works)
ssh -i ~/.ssh/vps1_openclaw_ed25519 -p <SSH_PORT> adminclaw@<VPS1_IP> \
  "echo 'NEW_PUBLIC_KEY' >> ~/.ssh/authorized_keys"

# 3. Test new key
ssh -i ~/.ssh/vps1_openclaw_ed25519_new -p <SSH_PORT> adminclaw@<VPS1_IP> echo "OK"

# 4. Remove old key from VPS authorized_keys
# 5. Update openclaw-config.env with new SSH_KEY_PATH
# 6. Delete old private key
```

#### Cloudflare Tunnel Token

See [docs/CLOUDFLARE-TUNNEL.md](../docs/CLOUDFLARE-TUNNEL.md#rotating-tunnel-token) for rotation procedure.

## Image Updates

### Sandbox Images

Sandbox images (base, toolkit, browser) persist across gateway restarts in `./data/docker`. The entrypoint auto-rebuilds when:

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

No gateway restart needed — builds happen inside the running container's nested Docker. New sandbox containers launched by agents automatically use the rebuilt images.

**When to run:**

- Monthly, for security patches (apt package updates)
- When entrypoint logs a staleness warning (images > 30 days old)
- After editing `sandbox-toolkit.yaml` — auto-detected on next gateway restart, but `update-sandboxes.sh` applies immediately without restart

### Bind-Mounted Deploy Files

Several deploy files are bind-mounted read-only into the gateway container. These can be updated without a full image rebuild — just SCP the file and restart the gateway.

**Bind-mounted files:** `dashboard/`, `entrypoint-gateway.sh`, `rebuild-sandboxes.sh`, `parse-toolkit.mjs`, `sandbox-toolkit.yaml`, `plugins/`

```bash
# From local machine — copy to VPS (use -r for directories like dashboard/ or plugins/)
scp -i <SSH_KEY_PATH> -P <SSH_PORT> [-r] deploy/<path> adminclaw@<VPS1_IP>:/tmp/deploy-update

# Move into place, fix ownership, and restart gateway (single SSH session)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> adminclaw@<VPS1_IP> "
  sudo rm -rf /home/openclaw/openclaw/deploy/<path>
  sudo cp -r /tmp/deploy-update /home/openclaw/openclaw/deploy/<path>
  sudo chown -R 1000:1000 /home/openclaw/openclaw/deploy/<path>
  rm -rf /tmp/deploy-update
  sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'
"
```

> **Note:** `sandbox-toolkit.yaml` changes are also auto-detected on gateway restart via Docker label comparison, triggering a sandbox image rebuild if needed.

### OpenClaw Gateway

Update the gateway to the latest upstream version:

```bash
# From local machine — pulls upstream, rebuilds image, recreates container
scripts/update-openclaw.sh
```

Brief downtime (~5-10s) during container swap. The script waits for the health check to pass before reporting success.
