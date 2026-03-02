# Plan: Install Script + Onboarding Playbook

## Context

The current `docs/CLAUDE_INSTALL.md` is a stale document designed as a standalone CLAUDE.md for a separate repo. It walks users through VPS setup manually but references outdated env var names and config patterns. We need to replace it with:

1. **`install.sh`** — A bash script that automates the mechanical setup (clone, copy examples, SSH setup, populate `.env`)
2. **`playbooks/00-onboarding.md`** — A Claude-guided playbook for interactive stack.yml configuration
3. **CLAUDE.md update** — Add "onboard" entry point
4. **Delete `docs/CLAUDE_INSTALL.md`**

---

## 1. `install.sh` — Bootstrap Script (repo root)

Handles everything mechanical before Claude takes over. Reuses SSH setup logic from the old `CLAUDE_INSTALL.md` (Steps 1.2–1.3).

**Flow:**

```
 1. Check prerequisites (git, node ≥22, npm)
 2. Clone repo (skip if already inside it)
 3. cd into repo, npm install
 4. Copy example files:
      .env.example → .env
      stack.yml.example → stack.yml
      workers/ai-gateway/wrangler.jsonc.example → workers/ai-gateway/wrangler.jsonc
      workers/log-receiver/wrangler.jsonc.example → workers/log-receiver/wrangler.jsonc
 5. Prompt: VPS IP address → validate → sed into .env
 6. Prompt: VPS hostname (default: same as IP) → sed into .env
 7. Prompt: Root username (default: ubuntu) → sed into .env
 8. Prompt: Passwordless SSH already set up?
    YES → list ~/.ssh/*.pub, try connecting with each → find working key → sed SSH_KEY into .env
    NO  → ssh-keygen -t ed25519 -f ~/.ssh/vps1_openclaw_ed25519 -N ""
        → ssh-copy-id (or print pubkey if password auth disabled)
        → verify connectivity
        → sed SSH_KEY into .env
 9. Final SSH connectivity verification
10. Print summary of what was configured
11. Print: "Run: claude 'onboard'" to start guided configuration
```

**Design notes:**

- Idempotent — safe to re-run. Skips clone if already in repo. Skips file copies if targets exist (prompts to overwrite).
- Uses `sed -i` to replace values in `.env` (match on `^KEY=` pattern)
- SSH key auto-detection: iterate `~/.ssh/*.pub`, try `ssh -o BatchMode=yes -o ConnectTimeout=5` with corresponding private key
- If `ssh-copy-id` fails: print public key, ask user to add via provider dashboard, then retry
- Does NOT launch `claude` automatically — user might not have it installed yet. Just prints the next step.
- ~150 lines of bash

---

## 2. `playbooks/00-onboarding.md` — Claude-Guided Configuration

Triggered by user saying "onboard". Claude walks through each stack.yml decision interactively, one question at a time.

**Sections:**

### § 0. Prerequisites Check

- Verify `.env` has `VPS_IP`, `SSH_USER`, `SSH_KEY` populated (install.sh should have done this)
- Verify SSH connectivity
- If not populated, tell user to run `install.sh` first

### § 1. Domain & Cloudflare

- Ask for `ROOT_DOMAIN` → write to `.env`
- Ask: Do you have a **Cloudflare API token** for automated tunnel/DNS setup, or have you **already configured** a Cloudflare Tunnel + Access manually?
  - **API token (recommended):** Walk through creating one at `dash.cloudflare.com/profile/api-tokens` with permissions: Account Settings Read, Cloudflare Tunnel Edit, DNS Edit (scoped to zone). Write to `.env` as `CLOUDFLARE_API_TOKEN`. Deployment playbooks auto-create tunnel + DNS via `scripts/cf-tunnel-setup.sh`.
  - **Already configured:** Ask for tunnel token → write to `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. Refer to `docs/CLOUDFLARE-TUNNEL.md` for Cloudflare Access setup if not done yet.
  - **Need help:** Refer to `docs/CLOUDFLARE-TUNNEL.md` for full walkthrough, then come back.

### § 2. Egress Proxy (Codex)

- Ask: Do you plan on using a **ChatGPT Codex subscription** with OpenClaw?
  - **Yes:** Leave `egress_proxy` section enabled in stack.yml. Generate a random auth token → write `EGRESS_PROXY_AUTH_TOKEN` to `.env`.
  - **No:** Comment out the entire `egress_proxy:` block in stack.yml.

### § 3. Claw Setup

- Ask: Do you want one OpenClaw instance or multiple? (You can always add more later)
  - **One (default):** Keep `personal-claw` as-is in stack.yml. Just need one Telegram bot.
  - **Multiple:** Walk through naming each claw. Auto-assign unique ports (gateway: 18789, 18790, ...; dashboard: 6090, 6091, ...). Add entries to stack.yml `claws:` section.
- For each claw: walk through Telegram bot creation
  - Create via @BotFather → paste token → write to `.env` (e.g. `PERSONAL_CLAW_TELEGRAM_BOT_TOKEN`)
  - Each claw **must** have a unique bot token (polling conflicts otherwise)
- Get user's Telegram ID via @userinfobot → write to `.env` as `ADMIN_TELEGRAM_ID`

### § 4. Host Alerts

- Ask: Want VPS monitoring alerts via Telegram? (Disk, memory, CPU checks every 15 min + daily report)
  - **Yes (recommended):** Create separate bot via @BotFather (or reuse). Get chat ID via `getUpdates` API. Write to `.env`.
  - **Skip for now:** Comment out `host_alerter` in stack.yml.

### § 5. Resource Allocation

- Ask: Maximize VPS resources for OpenClaw, or reserve some for other services?
  - **Maximize (recommended):** Keep defaults (90% CPU, 90% memory)
  - **Reserve some:** Ask percentage → update `stack.resources.max_cpu` and `stack.resources.max_mem` in stack.yml

### § 6. Summary & Handoff

- Print summary of all choices made
- Confirm with user
- Instruct: run `claude "start"` → enters existing Setup Question Flow → "New deployment" → `00-fresh-deploy-setup.md`

---

## 3. CLAUDE.md Changes

**Playbook table:** Add `00-onboarding.md | Interactive first-time stack configuration`

**Setup Question Flow:** Add before the existing numbered steps:

```
**If user says "onboard":** Follow 00-onboarding.md for guided first-time configuration.
This is for new users who ran install.sh and need to configure their stack.
```

---

## 4. Delete `docs/CLAUDE_INSTALL.md`

Replaced by install.sh + 00-onboarding.md.

---

## Files

| File | Change |
|------|--------|
| `install.sh` | **New** — bootstrap bash script (~150 lines) |
| `playbooks/00-onboarding.md` | **New** — Claude-guided config playbook |
| `CLAUDE.md` | Add "onboard" route + playbook table entry |
| `docs/CLAUDE_INSTALL.md` | **Delete** |

---

## Verification

1. Run `bash install.sh` in a temp directory — verify clone, npm install, file copies, prompts work
2. Verify `.env` gets VPS_IP, SSH_USER, SSH_KEY populated correctly
3. Verify wrangler.jsonc files are created for both workers
4. Say "onboard" in a Claude session — verify it routes to 00-onboarding.md
5. Walk through each onboarding question — verify .env and stack.yml are updated correctly
6. After onboarding, say "start" → verify it enters the existing deployment flow
