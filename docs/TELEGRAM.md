# Telegram Setup

The host alerter script sends VPS health alerts (disk, memory, container crashes) to Telegram. This requires a bot token and a chat ID.

Both values are optional — if left empty in `openclaw-config.env`, the alerter silently skips Telegram notifications.

## 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a display name (e.g., "OpenClaw Alerts")
4. Choose a username ending in `bot` (e.g., `openclaw_alerts_bot`)
5. BotFather replies with your **bot token** — a string like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
6. Copy the token into `openclaw-config.env`:

   ```bash
   HOSTALERT_TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```

## 2. Get Your Chat ID

### Option A: Personal DMs (simplest)

1. Open Telegram and send any message to your bot
2. Open this URL in a browser (replace `<TOKEN>` with your bot token):

   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

3. Find `"chat":{"id":123456789}` in the JSON — that number is your chat ID

### Option B: Group Chat

1. In Telegram, add your bot to a group - can be a new group or existing one
2. Send a **slash command** in the group (e.g., `/start` or `/hello`) — bots have privacy mode enabled by default and only see slash commands in groups
3. Check `getUpdates` as above — the group chat ID will be a negative number (e.g., `-1001234567890`)

> **Tip:** If slash commands don't appear in `getUpdates`, disable privacy mode: message `@BotFather`, send `/setprivacy`, select your bot, choose `Disable`, then **remove and re-add** the bot to the group (the change only takes effect on rejoin).

### Save the Chat ID

```bash
# openclaw-config.env
HOSTALERT_TELEGRAM_CHAT_ID=123456789
```

## 3. Test It

Send a test message locally:

```bash
./scripts/telegram-test.sh
```

Or with a custom message:

```bash
./scripts/telegram-test.sh "Hello from OpenClaw"
```

You should receive the message in Telegram from your bot.

## How Alerts Work

The host alerter (`/home/openclaw/scripts/host-alert.sh`) runs via cron every 15 minutes and checks:

- Disk usage (threshold: 85%)
- Memory usage (threshold: 90%)
- Docker daemon health
- Container crash/restart detection

Alerts are only sent on **state changes** — you won't get repeated messages for the same ongoing issue. A recovery message is sent when all checks pass again.
