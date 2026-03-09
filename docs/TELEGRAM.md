# Telegram Setup

OpenClaw uses Telegram in two ways:

1. **OpenClaw channel** — chat with your AI agent via a Telegram bot (optional per-claw)
2. **Host alerter** — VPS health alerts sent to Telegram (optional)

Both are optional. If you don't use Telegram, set `telegram.enabled: false` in `stack.yml` (under `defaults` or per-claw) and skip this guide. Both can use the same bot, or you can create separate bots.

## 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a display name (e.g., "OpenClaw")
4. Choose a username ending in `bot` (e.g., `openclaw_bot`)
5. BotFather replies with your **bot token** — a string like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

## 2. Get Your Telegram User ID

Send any message to [@userinfobot](https://t.me/userinfobot) — it replies with your numeric user ID.

## 3. Configure

Telegram is controlled by the `telegram.enabled` toggle in `stack.yml`. It defaults to `true` in `stack.yml.example`, so existing deployments continue working. To disable Telegram for a claw (or globally via `defaults`), set `enabled: false`:

```yaml
# stack.yml — defaults (applies to all claws unless overridden)
defaults:
  telegram:
    enabled: true                          # false to disable Telegram for all claws
    allow_from: ${ADMIN_TELEGRAM_ID}

# stack.yml — per-claw
claws:
  personal-claw:
    telegram:
      bot_token: ${PERSONAL_CLAW_TELEGRAM_BOT_TOKEN}
    # telegram:
    #   enabled: false                     # override default to disable for this claw only
```

Add the bot token to `.env`:

```env
PERSONAL_CLAW_TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
ADMIN_TELEGRAM_ID=123456789
```

- `ADMIN_TELEGRAM_ID` gates elevated mode — only this Telegram user can activate `/elevated` commands
- The per-claw bot token connects the gateway to Telegram as a messaging channel

When `telegram.enabled: false`, the Telegram channel block is stripped from the deployed `openclaw.json` entirely — it won't appear in the Control UI.

After deployment, the gateway connects to Telegram automatically. Message your bot to start chatting — the gateway may prompt you to approve the device via `openclaw devices approve` (same flow as browser pairing).

## 4. Host Alerter (Optional)

The host alerter sends disk/memory/CPU alerts via Telegram. You can reuse the same bot or create a separate one.

### Get Your Chat ID

#### Option A: Personal DMs (simplest)

1. Send any message to your bot
2. Open this URL in a browser (replace `<TOKEN>` with your bot token):

   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

3. Find `"chat":{"id":123456789}` in the JSON — that number is your chat ID

#### Option B: Group Chat

1. Add your bot to a group
2. Send a **slash command** in the group (e.g., `/start`)

   — bots have privacy mode enabled by default and only see slash commands in groups

3. Check `getUpdates` as above — the group chat ID will be a negative number (e.g., `-1001234567890`)

> **Tip:** If slash commands don't appear in `getUpdates`, disable privacy mode: message `@BotFather`, send `/setprivacy`, select your bot, choose `Disable`, then **remove and re-add** the bot to the group.

### Save the Config

```bash
# .env
HOSTALERT_TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
HOSTALERT_TELEGRAM_CHAT_ID=123456789
```

> Can be the same token as `OPENCLAW_TELEGRAM_BOT_TOKEN`. The chat ID is often your personal ID or a group ID (negative number).

### Test It

```bash
./scripts/telegram-test.sh
```

Or with a custom message:

```bash
./scripts/telegram-test.sh "Hello from OpenClaw"
```

## How Alerts Work

The host alerter (`/home/openclaw/scripts/host-alert.sh`) runs via cron every 15 minutes and checks:

- Disk usage (threshold: 85%)
- Memory usage (threshold: 90%)
- Docker daemon health
- Container crash/restart detection

Alerts are only sent on **state changes** — you won't get repeated messages for the same ongoing issue. A recovery message is sent when all checks pass again.

## Updating Configs

See [deploy/host/host-alert.sh](../deploy/host/host-alert.sh) for threshold configs.

Ask claude to `redeploy host alert` after you've made any changes to host-alert.sh
or the Telegram settings in `.env`.
