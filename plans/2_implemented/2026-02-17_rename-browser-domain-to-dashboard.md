# Rename OPENCLAW_BROWSER_DOMAIN → OPENCLAW_DASHBOARD_DOMAIN

## Context

During the novnc-proxy → dashboard rename, `OPENCLAW_BROWSER_DOMAIN_PATH` was correctly renamed to `OPENCLAW_DASHBOARD_DOMAIN_PATH`, but the hostname variable `OPENCLAW_BROWSER_DOMAIN` was intentionally kept. It should now be renamed to `OPENCLAW_DASHBOARD_DOMAIN` for consistency.

## Change

Global find-and-replace of `OPENCLAW_BROWSER_DOMAIN` → `OPENCLAW_DASHBOARD_DOMAIN` in all active files. Files under `plans/2_implemented/` are historical records and should NOT be updated.

## Files to Update (10 files + live config)

| File | Occurrences |
|------|-------------|
| `openclaw-config.env` | 1 (live config) |
| `openclaw-config.env.example` | 1 |
| `CLAUDE.md` | 1 |
| `deploy/openclaw.json` | 1 (comment) |
| `playbooks/00-fresh-deploy-setup.md` | 4 |
| `playbooks/07-verification.md` | 1 |
| `playbooks/08-post-deploy.md` | 1 |
| `docs/CLAUDE_INSTALL.md` | 6 |
| `docs/CLOUDFLARE-TUNNEL.md` | 2 |
| `docs/DASHBOARD.md` | 5 |
| `docs/TESTING.md` | 2 |

## Verification

`grep -r OPENCLAW_BROWSER_DOMAIN --include='*.md' --include='*.json' --include='*.env*' --include='*.sh' .` — should return zero hits (excluding `plans/2_implemented/`).
