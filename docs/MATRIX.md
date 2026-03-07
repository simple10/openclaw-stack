# Matrix Setup

OpenClaw supports Matrix as a messaging channel via the `@openclaw/matrix` plugin. Matrix is an open, federated, E2E-encrypted messaging protocol. You can use any Matrix account on any homeserver — no phone number required.

Full upstream config reference: https://docs.openclaw.ai/channels/matrix

---

## 1. Create a Matrix Bot Account

Create a dedicated Matrix account for your claw to use as its bot identity.

**Option A: matrix.org (easiest)**

1. Go to [app.element.io](https://app.element.io) and register a new account
2. Use a username that identifies it as a bot (e.g., `openclaw-yourname`)
3. Note the homeserver: `https://matrix.org`

**Option B: Any other public homeserver**

Any Matrix homeserver works. The account only needs to be able to join rooms and receive DMs.

---

## 2. Get an Access Token

The stack uses access-token auth. Do not use password auth.

1. Log in to your bot account in Element (or any Matrix client)
2. Go to **Settings** → **Help & About** → scroll to **Access Token**
3. Copy the token — it looks like `syt_...`

Alternatively, use the Matrix REST API:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"@yourbot:matrix.org","password":"yourpassword"}'
# → {"access_token": "syt_...", ...}
```

---

## 3. Configure

Add to `stack.yml` under the claw that should use Matrix:

```yaml
claws:
  personal-claw:
    matrix:
      enabled: true
      access_token: ${PERSONAL_CLAW_MATRIX_ACCESS_TOKEN}
      # homeserver: "https://matrix.org"   # optional — overrides the default
```

Add the token to `.env`:

```env
PERSONAL_CLAW_MATRIX_ACCESS_TOKEN=syt_your_token_here
```

The claw name prefix (e.g. `PERSONAL_CLAW`) must match the claw key in `stack.yml` with hyphens replaced by underscores and uppercased.

Then rebuild:

```bash
npm run pre-deploy
```

---

## 4. Room Configuration (optional)

By default:

- DMs require pairing approval (`dm.policy: pairing`)
- Group rooms require explicit allowlisting (`groupPolicy: allowlist`)
- The bot auto-joins any room it's invited to (`auto_join: always`)

To allow specific rooms, add them to `stack.yml`:

```yaml
matrix:
  enabled: true
  access_token: ${PERSONAL_CLAW_MATRIX_ACCESS_TOKEN}
  groups:
    "!roomid:matrix.org":
      enabled: true
      mention_only: false   # true = only respond when @mentioned
```

Room IDs look like `!abc123:matrix.org`. Find yours in Element under **Room Settings** → **Advanced** → **Internal Room ID**.

---

## 5. Deploy

After running `npm run pre-deploy`, sync and restart the claw:

```bash
scripts/sync-deploy.sh
# Restart the specific claw (service name: <project_name>-openclaw-<claw-name>)
sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose up -d <project_name>-openclaw-personal-claw'
```

On first boot, the entrypoint automatically installs `@openclaw/matrix` when `MATRIX_ENABLED=true`. No manual installation step is required — the stack handles it.

---

## 6. Pair Your Account

Matrix DMs default to pairing approval. After the claw starts:

1. Send any message to your bot account from your personal Matrix client
2. On the VPS, check pending pairings:

```bash
openclaw pairing list matrix
```

3. Approve your device:

```bash
openclaw pairing approve matrix <CODE>
```

After approval, the bot responds to your DMs normally.

---

## Rooms and Mention Gating

Rooms use `groupPolicy: allowlist` by default — the bot only responds in rooms explicitly listed in `matrix.groups`. Room allowlisting and mention gating are configured directly in the per-claw `openclaw.jsonc` (they are not rendered from `stack.yml`). To respond in a room:

1. Invite the bot account to the room from your Matrix client
1. Edit `openclaw/<claw-name>/openclaw.jsonc` and add the room under `channels.matrix.groups`:

```jsonc
"matrix": {
  // ...
  "groups": {
    "!roomid:matrix.org": { "enabled": true, "mention_only": false }
  }
}
```

1. Run `npm run pre-deploy && scripts/sync-deploy.sh`, then restart the claw

Alternatively, configure rooms live via the Control UI without redeploying.

To require the bot to be @mentioned before it responds: set `"mention_only": true` for that room.

---

## E2EE (Optional)

Matrix E2EE is supported but requires additional setup:

1. Edit `openclaw/<claw-name>/openclaw.jsonc` and set `"encryption": true` in the `channels.matrix` block, then run `npm run pre-deploy && scripts/sync-deploy.sh`
2. Verify the bot's Matrix device from another Matrix client (e.g., Element → Security → Verify)
3. Ensure `~/.openclaw/matrix/` is included in your backup (crypto state must survive restarts — the backup script covers this automatically)

> **Note:** `encryption` is not rendered from `stack.yml` — it must be set directly in the per-claw `openclaw.jsonc`. Use the Control UI or a direct file edit.

> **Recommendation:** Start without E2EE (`encryption: false`). Add E2EE only after confirming the Matrix channel works. Rotating the access token creates a new device identity and requires re-verification in encrypted rooms.

> **Beeper:** Beeper requires E2EE to be enabled. Configure `encryption: true` and complete device verification before using Beeper as a Matrix client.

---

## Token Rotation

If you need to rotate the Matrix access token:

1. Generate a new token for the bot account (via Element Settings or the login API)
2. Update `.env` with the new token
3. Run `npm run pre-deploy` → `scripts/sync-deploy.sh`
4. Restart the claw: `docker compose up -d <claw-name>`

Token rotation does not affect OpenClaw device pairings, but may require Matrix-side device re-verification in encrypted rooms.

---

## Troubleshooting

### Bot not responding to DMs

Check pending pairings:

```bash
openclaw pairing list matrix
openclaw pairing approve matrix <CODE>
```

### Bot not responding in rooms

- Confirm the room ID is in `matrix.groups` in `stack.yml`
- Confirm `auto_join` is not set to `never`
- Check claw logs: `sudo docker logs <project>-openclaw-<name> 2>&1 | grep -i matrix`

### Plugin not loading

`@openclaw/matrix` is installed by the entrypoint on first boot when `MATRIX_ENABLED=true`. If the channel is enabled but not responding, check the container logs for install errors and verify the plugin entry is active:

```bash
sudo docker logs <project>-openclaw-<name> 2>&1 | grep -i '\[entrypoint\].*matrix'
sudo docker exec --user node <project>-openclaw-<name> openclaw plugins list
```

### E2EE verification

If the bot is in encrypted rooms and messages are not decrypted:

1. Open Element with your personal account
2. Go to the room → click the bot's name → **Verify**
3. Complete the emoji verification flow

The bot's device must be verified from within each encrypted room.
