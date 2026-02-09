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
| `TELEGRAM_BOT_TOKEN` | VPS `.env` | As needed |
| SSH keys (`~/.ssh/ovh_openclaw_ed25519`) | Local machine + VPS `authorized_keys` | Annual |

### Rotation Procedures

#### Gateway Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update .env on VPS
# Edit /home/openclaw/openclaw/.env — change OPENCLAW_GATEWAY_TOKEN value

# 3. Rebuild image (token is baked into /app/.env at build time)
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 4. Restart gateway
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 5. Update all paired devices with new token
```

#### AI Gateway Auth Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/ai-gateway
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update VPS .env — change AI_GATEWAY_AUTH_TOKEN value
# This also updates ANTHROPIC_API_KEY, OPENAI_API_KEY, etc. via compose environment mapping

# 4. Rebuild image and restart
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
```

#### Log Worker Token

```bash
# 1. Generate new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update Worker secret (from local machine)
cd workers/log-receiver
echo "$NEW_TOKEN" | npx wrangler secret put AUTH_TOKEN

# 3. Update VPS .env — change LOG_WORKER_TOKEN value

# 4. Restart Vector to pick up new token
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart vector'
```

#### Provider API Keys

Provider API keys are stored as Cloudflare Worker secrets in the AI Gateway Worker. They never touch the VPS.

```bash
# From local machine
cd workers/ai-gateway
echo "new-key-value" | npx wrangler secret put ANTHROPIC_API_KEY
echo "new-key-value" | npx wrangler secret put OPENAI_API_KEY
# etc.
```

#### SSH Keys

```bash
# 1. Generate new key pair (local machine)
ssh-keygen -t ed25519 -f ~/.ssh/ovh_openclaw_ed25519_new

# 2. Add new public key to VPS (while old key still works)
ssh -i ~/.ssh/ovh_openclaw_ed25519 -p 222 adminclaw@<VPS1_IP> \
  "echo 'NEW_PUBLIC_KEY' >> ~/.ssh/authorized_keys"

# 3. Test new key
ssh -i ~/.ssh/ovh_openclaw_ed25519_new -p 222 adminclaw@<VPS1_IP> echo "OK"

# 4. Remove old key from VPS authorized_keys
# 5. Update openclaw-config.env with new SSH_KEY_PATH
# 6. Delete old private key
```
