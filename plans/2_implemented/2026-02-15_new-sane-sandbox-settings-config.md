>
> i've update openclaw.json with a much better balance of power vs security with main agent running on the gateway
> host (sandbox.mode: "non-main"). please review the config and let me know if you have any concerns.
>
> then let's plan an update to the playbooks. we're adding YOUR_TELEGRAM_ID to the configs to streamline the whole
> experience for the user. the telegram id is required to allow for elevated tools on main.
>

# Plan: Add YOUR_TELEGRAM_ID to deployment config and update playbooks

## Context

The `deploy/openclaw.json` config has been updated with significant improvements:

- `sandbox.mode` changed from `"all"` to `"non-main"` — main agent operator DMs run on the gateway host (full filesystem, Docker, gateway control), while all other sessions remain sandboxed
- Main agent gets `"tools": { "allow": ["gateway"] }` for gateway control
- New `tools.elevated` section gates host exec access from sandboxed sessions to specific Telegram sender IDs
- Code agent gets more resources (4g RAM, 4 CPUs, 7-day prune, `workspaceAccess: "rw"`)
- Skills agent gets tighter limits (1g RAM, 1 CPU, browser and sessions_spawn denied)

The `elevated.allowFrom.telegram` uses `{{YOUR_TELEGRAM_ID}}` as a template placeholder, but the playbook doesn't currently substitute it. We need to thread `YOUR_TELEGRAM_ID` through the deployment pipeline.

## Config Review Concerns

The updated `openclaw.json` looks solid. Two items to note:

1. **`{{YOUR_TELEGRAM_ID}}` not substituted** — The `# VARS:` comment in playbook § 4.8 (line 333) only lists `GATEWAY_TOKEN` and `OPENCLAW_DOMAIN_PATH`. If `YOUR_TELEGRAM_ID` isn't added, the literal string `{{YOUR_TELEGRAM_ID}}` ends up in the deployed config, breaking elevated mode.

2. **Main agent removed `sandbox.docker.network: "bridge"`** — The old config explicitly set `network: "bridge"` on main. With `mode: "non-main"`, operator DMs run on the host (no sandbox needed), but non-operator sessions (group chats, subagent spawns) still get sandboxed and will inherit the default `network: "none"`. This is probably fine since main delegates everything to sub-agents anyway, but worth being aware of.

## Changes

### 1. `playbooks/00-fresh-deploy-setup.md` — validate YOUR_TELEGRAM_ID

**§ 0.2** — Add `YOUR_TELEGRAM_ID` to required config validation. It's listed in the "REQUIRED TO START DEPLOYMENT" section of `openclaw-config.env.example`, so the playbook should validate it.

Add validation item #7:

```
7. **`YOUR_TELEGRAM_ID`** — Must be set and numeric (Telegram user IDs are integers).
   If empty, warn the user: "Send a message to @userinfobot on Telegram to get your numeric user ID."
```

Add to the error message template:

```
> - `YOUR_TELEGRAM_ID` is empty — send a message to @userinfobot on Telegram to get your ID
```

### 2. `playbooks/04-vps1-openclaw.md` — substitute YOUR_TELEGRAM_ID

**§ 4.8** (line 333) — Add `YOUR_TELEGRAM_ID` to the VARS comment:

```bash
# VARS: GATEWAY_TOKEN (from .env on VPS), OPENCLAW_DOMAIN_PATH (from openclaw-config.env), YOUR_TELEGRAM_ID (from openclaw-config.env)
```

This tells Claude to substitute `{{YOUR_TELEGRAM_ID}}` with the value from `openclaw-config.env` when writing the heredoc content.

### 3. `openclaw-config.env.example` — already correct

Line 4 already has `YOUR_TELEGRAM_ID` in the required section with the `@userinfobot` hint. No changes needed.

### 4. `deploy/openclaw.json` — already correct

The `{{YOUR_TELEGRAM_ID}}` template placeholder is in the right place. No changes needed.

## Files

| File | Change |
|------|--------|
| `playbooks/00-fresh-deploy-setup.md` | Add `YOUR_TELEGRAM_ID` to § 0.2 required config validation |
| `playbooks/04-vps1-openclaw.md` | Add `YOUR_TELEGRAM_ID` to § 4.8 VARS comment for template substitution |

## Verification

1. Read `openclaw-config.env.example` — confirm `YOUR_TELEGRAM_ID` is documented in the required section
2. Read `playbooks/00-fresh-deploy-setup.md` § 0.2 — confirm validation added
3. Read `playbooks/04-vps1-openclaw.md` § 4.8 — confirm VARS comment includes `YOUR_TELEGRAM_ID`
4. Grep for `{{YOUR_TELEGRAM_ID}}` across the codebase — should only appear in `deploy/openclaw.json` (the template source)
