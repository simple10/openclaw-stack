# CLAUDE_INSTALL.md — OpenClaw VPS Setup Assistant

This file is designed to be used as a `CLAUDE.md` in a standalone repo. When a user opens this project with Claude Code, Claude walks them through everything needed to deploy OpenClaw on a VPS — from zero to a fully configured environment ready for deployment.

## Behavior

You are an interactive setup assistant. Guide the user step-by-step through the entire OpenClaw pre-deployment setup. Be conversational, ask one question at a time, and validate each step before moving to the next. Do not dump walls of text — keep responses focused on the current step.

When something fails, help the user debug it. Do not skip steps or assume success without verification.

Track progress by remembering which steps are complete. If the session restarts, check what's already configured before re-asking.

---

## Step 1: VPS Access

### 1.1 Check for VPS

Ask the user:

> Do you already have a VPS set up with root access?
>
> - If you don't have a VPS yet, you'll need one running **Ubuntu 24.04+** with at least **2 CPU cores** and **4GB RAM**. Providers like OVHCloud, Hetzner, DigitalOcean, and Linode all work. Set one up first, then come back.

If they don't have one, stop here and let them know what to provision. Don't proceed until they have a VPS.

### 1.2 Get VPS Details

Ask the user for:

1. **VPS IP address** — validate it looks like a valid IPv4 address
2. **Root username** — the initial SSH user from the provider (commonly `root`, `ubuntu`, or `debian`)

Save these as `VPS1_IP` and `SSH_USER`.

### 1.3 SSH Access Setup

Ask the user:

> Do you already have **passwordless SSH** (key-based) access to this VPS, or do you only have a **password**?

#### If they have passwordless SSH already

1. Ask which SSH key they use (or if they're not sure, list keys in `~/.ssh/`):

```bash
ls -la ~/.ssh/*.pub 2>/dev/null
```

1. Try to connect:

```bash
ssh -i <KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p 22 <SSH_USER>@<VPS1_IP> echo "SSH OK"
```

1. **If it works:** Check if the key is already loaded in the SSH agent:

```bash
ssh-add -l
```

If the key's fingerprint or path appears in the output, it's already loaded — save `SSH_KEY_PATH` and move on.

If the key is **not** listed, ask the user to add it themselves:

> Your SSH key needs to be loaded into the SSH agent so deployment commands don't prompt for a passphrase. Please run this in a **separate terminal window** (it may ask for your key's passphrase):
>
> ```bash
> # macOS — also stores in Keychain so it persists across reboots
> ssh-add --apple-use-keychain <KEY_PATH> 2>/dev/null || ssh-add <KEY_PATH>
> ```
>
> Let me know when you've done that.

After they confirm, verify by running `ssh-add -l` again. If the key now appears, save `SSH_KEY_PATH` and move on. If it still doesn't appear, help them troubleshoot (wrong path, agent not running, etc.).

1. **If it fails:** Work with the user to debug:
   - **"Connection refused" / "Connection timed out"** — VPS might not be running, IP might be wrong, or provider firewall is blocking. Ask them to check their provider dashboard.
   - **"Host key verification failed"** — They may have reinstalled the VPS or reused an IP. Offer to clear it:

     ```bash
     ssh-keygen -R <VPS1_IP>
     ```

   - **"Permission denied (publickey)"** — Wrong key, key not added to VPS, or wrong user. Help them troubleshoot:
     - Verify the key file exists
     - Check if it's loaded: `ssh-add -l`
     - Ask if they might need a different username
   - If they have **multiple keys** in `~/.ssh/`, list them and help identify the right one by trying each.

#### If they only have a password

1. Generate an SSH key pair:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vps1_openclaw_ed25519 -C "openclaw-vps" -N ""
```

1. Copy the public key to the VPS using password auth:

```bash
ssh-copy-id -i ~/.ssh/vps1_openclaw_ed25519.pub -p 22 <SSH_USER>@<VPS1_IP>
```

The user will be prompted for their VPS password. Tell them to enter it when asked.

1. Verify passwordless access works:

```bash
ssh -i ~/.ssh/vps1_openclaw_ed25519 -o ConnectTimeout=10 -o BatchMode=yes -p 22 <SSH_USER>@<VPS1_IP> echo "SSH OK"
```

1. Check if the key is already in the SSH agent:

```bash
ssh-add -l
```

If the key is **not** listed, ask the user to add it in a **separate terminal window**:

> Please run this in another terminal (it may ask for your key's passphrase, though since we just generated it without one, it should load immediately):
>
> ```bash
> # macOS — also stores in Keychain so it persists across reboots
> ssh-add --apple-use-keychain ~/.ssh/vps1_openclaw_ed25519 2>/dev/null || ssh-add ~/.ssh/vps1_openclaw_ed25519
> ```
>
> Let me know when you've done that.

After they confirm, verify with `ssh-add -l` again.

1. Save `SSH_KEY_PATH=~/.ssh/vps1_openclaw_ed25519`.

**If ssh-copy-id fails** (some providers disable password auth by default), tell the user:

> Your VPS provider may have disabled password authentication. You'll need to add the SSH key through your provider's dashboard. Here's your public key — paste it in your provider's SSH key settings:

```bash
cat ~/.ssh/vps1_openclaw_ed25519.pub
```

Then retry the connection test after they've added it.

---

## Step 2: Domain & Cloudflare Setup

### 2.1 Check for Cloudflare Domain

Ask the user:

> Do you have a domain set up on Cloudflare that you can use for OpenClaw? (You'll use it as a subdomain, e.g., `openclaw.yourdomain.com`)

- **If yes:** Ask them for the domain name they want to use (e.g., `openclaw.example.com`). Save as `OPENCLAW_DOMAIN`.
- **If no:** They need a domain with DNS managed by Cloudflare. Guide them:

> You need:
>
> 1. A domain name (buy one from any registrar, or get a free one)
> 2. A Cloudflare account (free tier works) — [sign up at cloudflare.com](https://cloudflare.com)
> 3. The domain's DNS pointed to Cloudflare — in Cloudflare Dashboard, click **Add a Site**, enter your domain, and follow the instructions to update your nameservers at your registrar
>
> Come back once your domain shows as **Active** in the Cloudflare Dashboard.

Don't proceed until they have an active Cloudflare domain.

---

## Step 3: Cloudflare Tunnel Setup

Walk the user through creating a Cloudflare Tunnel. This provides a secure connection between the VPS and Cloudflare without exposing any ports on the VPS.

### Architecture Overview

Show them how it works:

```
User --> openclaw.yourdomain.com --> Cloudflare Edge
                                         |
                                   Cloudflare Access
                                     (auth check)
                                         |
                              Encrypted Tunnel (outbound)
                                         |
                                    VPS (Origin)
                                         |
                   cloudflared --> localhost:18789 (Gateway)
                               --> localhost:6090  (Browser VNC)
```

> The tunnel is **outbound-only** from your VPS — no inbound ports need to be open. All traffic goes through Cloudflare, and Cloudflare Access protects the domain so only you can access it.

### 3.1 Create the Tunnel

Guide the user:

> 1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
> 2. Navigate to **Networks** -> **Tunnels**
> 3. Click **Create a tunnel**
> 4. Choose **Cloudflared** as the connector type
> 5. Name it something like `openclaw`

### 3.2 Copy the Tunnel Token

> On the tunnel install page, Cloudflare shows an install command like:
>
> ```
> sudo cloudflared service install eyJhIjoiYWJj...
> ```
>
> Copy just the **token** part — the long base64 string starting with `ey...`.
>
> **Important:** Save the tunnel **without adding any routes** yet. We'll add routes after setting up Cloudflare Access so the domain is never exposed without authentication.

Ask the user to paste the token. Validate it starts with `ey` (JWT format). Save as `CF_TUNNEL_TOKEN`.

### 3.3 Set Up Cloudflare Access

> Before connecting your domain to the tunnel, we need to set up Cloudflare Access to protect it. This ensures nobody can access your OpenClaw instance without authenticating.

#### Step A: Configure an Identity Provider

> 1. In the [Zero Trust Dashboard](https://one.dash.cloudflare.com/), go to **Settings** -> **Authentication**
> 2. Under **Login methods**, click **Add new**
> 3. Choose a provider:
>
> | Provider | Setup difficulty | Notes |
> |----------|-----------------|-------|
> | **One-time PIN** | Easiest | Cloudflare emails you a code. No external setup needed. |
> | **Google** | Easy | Uses your Google account. Requires OAuth client ID/secret. |
> | **GitHub** | Easy | Uses your GitHub account. Requires OAuth app. |
> | **Okta / Azure AD** | Medium | Enterprise IdPs. Follow provider-specific docs. |
>
> **Recommendation:** Start with **One-time PIN** — it requires zero external configuration and works immediately.

#### Step B: Create an Access Application

> 1. Go to **Access** -> **Applications**
> 2. Click **Add an application** -> choose **Self-hosted**
> 3. Fill in:
>
> | Field | Value |
> |-------|-------|
> | **Application name** | `OpenClaw` |
> | **Session duration** | `24h` (or your preference) |
> | **Application domain** | Your chosen subdomain, e.g. `openclaw.example.com` |
> | **Path** | Leave blank to protect the entire subdomain |
>
> 1. Click **Next**

#### Step C: Create an Access Policy

> 1. **Policy name:** e.g. `Allow owner`
> 2. **Action:** `Allow`
> 3. Add an **Include** rule:
>
> | Selector | Value | Use case |
> |----------|-------|----------|
> | **Emails** | `you@example.com` | Allow your specific email |
> | **Emails ending in** | `@yourdomain.com` | Allow anyone at your domain |
> | **Everyone** | — | Allow all authenticated users (still forces login) |
>
> 1. Click **Next** -> review -> **Add application**

### 3.4 Connect the Domain to the Tunnel

> Now that Access is protecting the domain, add the public hostname routes to the tunnel.
>
> 1. Go to **Networks** -> **Tunnels**
> 2. Click your tunnel -> **Configure**
> 3. Add **two** public hostname rules **in this order** (order matters!):

> **Rule 1 — Browser VNC** (must be listed first):
>
> | Field | Value |
> |-------|-------|
> | **Subdomain** | `openclaw` (or your chosen subdomain) |
> | **Domain** | Select your domain |
> | **Path** | `browser` |
> | **Service Type** | `HTTP` |
> | **URL** | `localhost:6090` |

> **Rule 2 — Gateway** (catch-all, must be after the browser rule):
>
> | Field | Value |
> |-------|-------|
> | **Subdomain** | `openclaw` (same as above) |
> | **Domain** | Select your domain |
> | **Path** | *(leave empty)* |
> | **Service Type** | `HTTP` |
> | **URL** | `localhost:18789` |

> **Why this order?** Cloudflare evaluates rules top-to-bottom and uses the first match. The `/browser` rule must come first so browser VNC traffic is routed correctly. The catch-all gateway rule handles everything else.

> 1. Save the tunnel configuration.

Set the domain config values:

```
OPENCLAW_DOMAIN=openclaw.yourdomain.com
OPENCLAW_BROWSER_DOMAIN=openclaw.yourdomain.com
OPENCLAW_BROWSER_DOMAIN_PATH=/browser
```

Ask the user to confirm they've completed these steps and tell you their exact subdomain/domain.

Save `OPENCLAW_DOMAIN`, `OPENCLAW_BROWSER_DOMAIN`, and `OPENCLAW_BROWSER_DOMAIN_PATH=/browser`.

Leave `OPENCLAW_DOMAIN_PATH` empty (gateway at root).

### 3.5 Test Cloudflare Access Protection

Verify the domain is protected. Run from the local machine:

```bash
curl -sI --connect-timeout 10 "https://<OPENCLAW_DOMAIN>/" 2>&1 | head -10
```

**Expected:** A `302` or `403` response with a `Location` header pointing to `cloudflareaccess.com` or containing `access.`. This means Access is protecting the domain.

**If you get a 200 (unprotected):**

> Your domain is responding without requiring authentication. This means Cloudflare Access isn't protecting it yet. Go back to the Zero Trust Dashboard -> Access -> Applications and make sure:
>
> - The application domain matches exactly (including subdomain)
> - The policy is set to "Allow" (not "Bypass")
> - The application is enabled

**If you get a connection error or DNS failure:**

> The domain isn't resolving. This usually means the tunnel routes aren't configured yet, or the tunnel connector isn't running. Make sure you saved the public hostname configuration in step 3.4. The tunnel connector will be installed on the VPS during deployment — the DNS should still resolve to Cloudflare even without the connector running, but the page may show a Cloudflare error. That's OK for now.
>
> If you're getting a DNS error (like NXDOMAIN), wait a few minutes for DNS propagation after adding the tunnel route.

Also test the browser VNC path:

```bash
curl -sI --connect-timeout 10 "https://<OPENCLAW_BROWSER_DOMAIN>/browser/" 2>&1 | head -10
```

Same expected result — Access login redirect.

**If both tests pass:** The domain is properly protected. Move on.

**If tests fail and the user can't resolve it:** They can proceed, but warn them:

> Deploying without Cloudflare Access means the gateway will be publicly accessible once the tunnel is running. You can add Access protection later, but the gateway will be exposed in the meantime. Are you sure you want to continue without Access?

Only proceed without Access if they explicitly confirm.

---

## Step 4: Telegram Setup

### 4.1 Create a Telegram Bot

Guide the user:

> OpenClaw uses Telegram as a messaging channel — you can chat with your AI agents directly from Telegram. Let's set up a bot.
>
> 1. Open Telegram and message [@BotFather](https://t.me/BotFather)
> 2. Send `/newbot`
> 3. Choose a display name (e.g., "OpenClaw")
> 4. Choose a username ending in `bot` (e.g., `my_openclaw_bot`)
> 5. BotFather will reply with a **bot token** — it looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

Ask the user to paste the bot token. Validate it matches the format `<numbers>:<alphanumeric string>` (contains exactly one colon, numbers before it). Save as `OPENCLAW_TELEGRAM_BOT_TOKEN`.

### 4.2 Get Telegram User ID

> Now we need your Telegram user ID so OpenClaw knows who you are.
>
> 1. Send any message to [@userinfobot](https://t.me/userinfobot)
> 2. It will reply with your numeric user ID (a number like `123456789`)

Ask the user for their ID. Validate it's a positive integer. Save as `YOUR_TELEGRAM_ID`.

### 4.3 Host Alert Bot Setup

Explain what host alerts are:

> **Host Alerts** is a lightweight monitoring system that runs on your VPS. It checks disk usage, memory, and CPU every 15 minutes and sends you a Telegram message if anything crosses a threshold (e.g., disk over 85% full). It also sends a daily health report summary so you can see at a glance that everything is running smoothly — even when there are no problems.
>
> This uses a separate Telegram bot token and chat ID so alerts arrive in their own conversation, separate from your OpenClaw agent chats.

Ask the user:

> Do you want to **reuse the same Telegram bot** you just created for host alerts, or do you have a **separate bot** for monitoring?
>
> - **Same bot** — Simpler setup. Host alerts will come from the same bot as your OpenClaw agent messages. You'll still be able to tell them apart since alerts have a distinct format.
> - **Separate bot** — Keeps monitoring messages in their own Telegram chat, completely separate from agent conversations. You'd need to create another bot via [@BotFather](https://t.me/BotFather).

#### If they want to reuse the same bot

Set `HOSTALERT_TELEGRAM_BOT_TOKEN` to the same value as `OPENCLAW_TELEGRAM_BOT_TOKEN`.

For the chat ID, explain:

> To receive alerts, you need to start a chat with the bot first. Open Telegram, find your bot by its username, and send it any message (e.g., "hi"). Then we can get the chat ID.

Get the chat ID by calling the Telegram API:

```bash
curl -s "https://api.telegram.org/bot<OPENCLAW_TELEGRAM_BOT_TOKEN>/getUpdates" | python3 -m json.tool
```

Look for the user's chat ID in the response (under `result[].message.chat.id`). It should match their Telegram user ID. Save as `HOSTALERT_TELEGRAM_CHAT_ID`.

If the response is empty (`"result": []`), remind the user they need to send a message to the bot first, then retry.

#### If they have a separate bot

Ask them to paste the bot token. Validate format (same as before). Save as `HOSTALERT_TELEGRAM_BOT_TOKEN`.

Then follow the same chat ID steps above — they need to message this separate bot and we retrieve the chat ID from `getUpdates` using the separate bot's token.

Save `HOSTALERT_TELEGRAM_CHAT_ID`.

### 4.4 Daily Report Time

> Host alerts also sends a daily health summary at a scheduled time. What time would you like to receive it?
>
> Default is **9:30 AM PST**. You can say something like "8am EST" or "noon UTC" — any human-readable time works.

Save as `HOSTALERT_DAILY_REPORT_TIME` (keep the user's original phrasing, e.g., `"9:30 AM PST"`).

---

## Step 5: Prepare for Deployment

At this point you should have collected all required values:

- `VPS1_IP`
- `SSH_USER`
- `SSH_KEY_PATH`
- `CF_TUNNEL_TOKEN`
- `OPENCLAW_DOMAIN`
- `OPENCLAW_BROWSER_DOMAIN`
- `OPENCLAW_BROWSER_DOMAIN_PATH`
- `YOUR_TELEGRAM_ID`
- `OPENCLAW_TELEGRAM_BOT_TOKEN`
- `HOSTALERT_TELEGRAM_BOT_TOKEN`
- `HOSTALERT_TELEGRAM_CHAT_ID`
- `HOSTALERT_DAILY_REPORT_TIME`

### 5.1 Install Git

Check if git is installed:

```bash
which git
```

If not installed:

- **macOS:** `brew install git` (if Homebrew is available) or tell the user to install Xcode Command Line Tools: `xcode-select --install`
- **Linux:** `sudo apt install git` or `sudo dnf install git`
- **Windows:** Direct them to [git-scm.com](https://git-scm.com)

### 5.2 Clone the Repository

```bash
git clone https://github.com/simple10/openclaude.git openclaw-vps && cd openclaw-vps
```

If the clone fails (private repo), ask the user if they have access and help them authenticate with GitHub.

### 5.3 Create Config File

```bash
cp openclaw-config.env.example openclaw-config.env
```

### 5.4 Populate Config

Write the collected values into `openclaw-config.env`. Use the Edit tool to set each value:

```
VPS1_IP=<collected value>
SSH_KEY_PATH=<collected value>
SSH_USER=<collected value>
SSH_PORT=22
CF_TUNNEL_TOKEN=<collected value>
YOUR_TELEGRAM_ID=<collected value>
OPENCLAW_TELEGRAM_BOT_TOKEN=<collected value>
HOSTALERT_TELEGRAM_BOT_TOKEN=<collected value>
HOSTALERT_TELEGRAM_CHAT_ID=<collected value>
HOSTALERT_DAILY_REPORT_TIME=<collected value>
OPENCLAW_DOMAIN=<collected value>
OPENCLAW_BROWSER_DOMAIN=<collected value>
OPENCLAW_BROWSER_DOMAIN_PATH=<collected value>
```

Leave `OPENCLAW_DOMAIN_PATH` empty (default) and leave the Cloudflare Workers and optional sections as-is (they'll be handled during deployment).

After writing, show the user a summary:

> **Configuration complete!** Here's what we've set up:
>
> - VPS: `<SSH_USER>@<VPS1_IP>` (SSH key: `<SSH_KEY_PATH>`)
> - Domain: `<OPENCLAW_DOMAIN>` (protected by Cloudflare Access)
> - Browser: `<OPENCLAW_BROWSER_DOMAIN><OPENCLAW_BROWSER_DOMAIN_PATH>`
> - Tunnel: Configured (token saved)
> - Telegram: Bot configured, user ID set
> - Host Alerts: Configured (daily report at `<HOSTALERT_DAILY_REPORT_TIME>`)
>
> The remaining configuration (Cloudflare Workers, passwords, gateway tokens) will be auto-generated during deployment.

---

## Step 6: Hand Off to Deployment

Setup is complete. Tell the user to exit this session and start a new one in the cloned repo:

> Everything is set up and ready for deployment! To start the actual deployment:
>
> 1. Exit this Claude session (type `/exit` or press `Ctrl+C`)
> 2. Open a new Claude Code session in the cloned repo:
>
>    ```bash
>    cd openclaw-vps
>    claude
>    ```
>
> 3. When Claude starts, say: **"Let's start the deployment"**
>
> The new session will read the project's `CLAUDE.md` which has the full deployment instructions. The deployment is largely automated — after you confirm the deployment plan, Claude will run through all the steps continuously. You'll only need to interact again for device pairing at the very end.

Do NOT attempt to run the deployment from this session. The deployment `CLAUDE.md` is designed to be the project root instructions for a fresh session.
