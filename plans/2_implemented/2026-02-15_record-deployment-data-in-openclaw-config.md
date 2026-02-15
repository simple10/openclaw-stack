# Plan: Record deployment data in openclaw-config.env as it's generated

## Context

If Claude's session crashes mid-deploy or context gets compressed before the final deployment report (§ 8.6), three critical values are lost forever — user passwords and the gateway token. They're only displayed to stdout once. This adds commented lines to `openclaw-config.env` as each value is generated, creating a persistent local safety net.

## Values to record

| Value | Generated in | Currently persisted? |
|-------|-------------|---------------------|
| `adminclaw` password | `02-base-setup.md` line 101 | No — stdout only |
| `openclaw` password | `02-base-setup.md` line 121 | No — stdout only |
| Gateway token | `04-vps1-openclaw.md` line 193 | VPS `.env` only (not local) |
| Gateway access URL | Composed from domain + token | Nowhere until report |

Worker tokens/URLs are already written as active variables in `openclaw-config.env` during `01-workers.md` — no change needed for those.

## Comment format

```bash
# ── Deployment Record (auto-generated) ───────────────────
# Written by playbooks as values are generated. Safety net
# in case the session ends before the deployment report.
# DEPLOYED: ADMINCLAW_PASSWORD=<value>
# DEPLOYED: OPENCLAW_PASSWORD=<value>
# DEPLOYED: GATEWAY_TOKEN=<value>
# DEPLOYED: GATEWAY_URL=https://domain/path/chat?token=<value>
```

The `# DEPLOYED:` prefix keeps them as comments (safe to source) and makes them greppable. On re-runs, update existing lines in-place rather than appending duplicates.

## Files to modify (4 files)

### 1. `openclaw-config.env.example` — add template at bottom

After line 32 (`HOSTALERT_TELEGRAM_CHAT_ID=`), append the deployment record section with empty placeholders so users know the format exists.

### 2. `playbooks/02-base-setup.md` — record passwords after generation

Insert instruction between the password script closing ``` (line 136) and `**Workflow after setup:**` (line 138). Tell Claude to write/update the `ADMINCLAW_PASSWORD` and `OPENCLAW_PASSWORD` deploy record lines in `openclaw-config.env` immediately after the SSH script runs.

### 3. `playbooks/04-vps1-openclaw.md` — record gateway token after generation

Insert instruction between the credentials display closing ``` (line 248) and the `---` separator (line 250). Tell Claude to write/update `GATEWAY_TOKEN` and `GATEWAY_URL` deploy record lines, composing the URL from `OPENCLAW_DOMAIN` and `OPENCLAW_DOMAIN_PATH`.

### 4. `playbooks/08-post-deploy.md` — reference as fallback in § 8.6

- Update "Values to collect" item 1 (line 321): check `# DEPLOYED:` lines as first fallback before saying passwords are lost
- Update bottom note (line 434): same — check deploy record lines before suggesting VNC reset

## What stays the same

- No changes to deployment commands or scripts
- Worker token handling unchanged (already tracked as active variables)
- Deployment report format unchanged
- `# DEPLOYED:` lines left in place permanently — harmless comments, permanent local record

## Verification

1. Read modified sections to confirm instructions are clear and correctly placed
2. Confirm `openclaw-config.env.example` template is properly formatted as comments
3. `source openclaw-config.env.example` would not export any DEPLOYED values (they're comments)
