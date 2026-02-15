# Plan: Playbook Consistency Audit — Fixes

## Context

A full audit of CLAUDE.md and all playbooks revealed issues ranging from deployment-blocking bugs to minor documentation inconsistencies. This plan addresses the real, verified issues — false positives from the audit agents have been eliminated by cross-checking against the actual source files.

The goal: a fresh deployment following these playbooks sequentially should succeed without manual intervention, and re-running on an existing deployment should not break anything.

---

## Issues & Fixes (grouped by file)

### 1. `playbooks/04-vps1-openclaw.md` — the critical playbook

#### 1a. BUG: `openclaw.json` basePath uses shell syntax inside quoted heredoc

- **Line 374**: Uses quoted heredoc `<< 'JSONEOF'` — no variable expansion
- **Line 384**: `"basePath": "${OPENCLAW_DOMAIN_PATH:-/_openclaw}"` written as literal string
- **Impact**: Gateway gets the literal string as its basePath instead of the actual value
- **Fix**: Replace shell variable syntax with the standard `<OPENCLAW_DOMAIN_PATH>` placeholder (same convention as `<OPENCLAW_DOMAIN>`, `<VPS1_IP>` used throughout the playbooks). Claude substitutes the real config value before running the `sudo tee` command — no sed or heredoc changes needed.

#### 1b. BUG: Host alerter sources nonexistent file on VPS

- **Line 700**: `source /home/openclaw/openclaw-config.env 2>/dev/null || true`
- **Problem**: `openclaw-config.env` is a local dev file, never copied to VPS
- **Also**: `TELEGRAM_CHAT_ID` is never written to VPS `.env` (only `TELEGRAM_BOT_TOKEN` is)
- **Impact**: Host alerter silently fails to send any Telegram alerts
- **Fix** (two changes):
  1. Section 4.5 (line ~146): Add `TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}` to the `.env` heredoc
  2. Section 4.8d (line 700): Change source path to `/home/openclaw/openclaw/.env`

#### 1c. MISSING: Variables section incomplete

- **Lines 23-31**: Omits `LOG_WORKER_URL`, `LOG_WORKER_TOKEN`, `VPS1_IP`
- **Fix**: Add all three to the Variables section

#### 1d. COSMETIC: Stale variable hints in section 4.5

- **Lines 129-135**: Commented-out placeholder values (from before automated worker deployment)
- **Fix**: Remove the stale comments

---

### 2. `playbooks/07-verification.md`

#### 2a. Hardcoded domain in verification curl

- **Line 116**: `curl -s https://claw.example.com<OPENCLAW_DOMAIN_PATH>/`
- **Fix**: Replace `claw.example.com` with `<OPENCLAW_DOMAIN>`

#### 2b. Inconsistent VPS IP placeholder format

- **Lines 32, 119**: Uses `<VPS1-IP>` (hyphen)
- **Fix**: Standardize to `<VPS1_IP>` (underscore, matches config variable)

---

### 3. `playbooks/02-base-setup.md`

#### 3a. Inconsistent VPS IP placeholder

- **Lines 112, 226, 229**: Uses `<VPS_IP>` instead of `<VPS1_IP>`
- **Fix**: Standardize to `<VPS1_IP>`

---

### 4. `playbooks/05-cloudflare-tunnel.md`

#### 4a. Inconsistent VPS IP placeholder

- **Line 314**: Uses `<VPS_IP>` instead of `<VPS1_IP>`
- **Fix**: Standardize to `<VPS1_IP>`

---

### 5. `cli/src/types.ts` and `cli/src/ssh.ts` — stale two-VPS references

#### 5a. CLI still has VPS2 references

- `types.ts`: `VPS2_IP`, `VPS2_HOSTNAME`, `NETWORKING_OPTION`, `DOMAIN_GRAFANA`, `VpsTarget = 'vps1' | 'vps2' | 'both'`
- `ssh.ts`: VPS2 IP ternary, `VPS2_COMPOSE_DIR`
- **Fix**: Remove VPS2 references, simplify `VpsTarget` to just `'vps1'`, remove `NETWORKING_OPTION` and `DOMAIN_GRAFANA` from Config interface

---

### 6. `openclaw-config.env.example` and `openclaw-config.env`

#### 6a. Orphaned `VPS1_HOSTNAME`

- Referenced only in stale CLI code (being removed above), not used by any playbook
- **Fix**: Remove from both config files

---

## Files to modify

| File | Changes |
|------|---------|
| `playbooks/04-vps1-openclaw.md` | Fix basePath placeholder, fix host alerter source path, add TELEGRAM_CHAT_ID to .env, update Variables section, remove stale comments |
| `playbooks/07-verification.md` | Fix hardcoded domain, fix VPS IP placeholder format |
| `playbooks/02-base-setup.md` | Fix VPS IP placeholder format (`<VPS_IP>` -> `<VPS1_IP>`) |
| `playbooks/05-cloudflare-tunnel.md` | Fix VPS IP placeholder format |
| `cli/src/types.ts` | Remove VPS2, NETWORKING_OPTION, DOMAIN_GRAFANA |
| `cli/src/ssh.ts` | Remove VPS2 references, simplify to single-VPS |
| `openclaw-config.env.example` | Remove VPS1_HOSTNAME |
| `openclaw-config.env` | Remove VPS1_HOSTNAME |

## Intentionally NOT fixing

- **Sysbox version hardcoded** (04 line 42): Comment already says "check releases for latest". Hardcoding is correct for reproducibility.
- **SSH commands with hardcoded port 222 / adminclaw** (02, 05, 07): These appear AFTER the hardening step has run — they're showing post-hardening usage, not using config variables. Correct as-is.
- **Section 4.5 `.env` heredoc variable expansion**: Uses `<< EOF` (unquoted) so `${AI_GATEWAY_WORKER_URL}` etc. DO expand. Correct as-is.
- **Network creation idempotency** (04 section 4.2): Claude handles errors gracefully when executing step-by-step. Not a scripted unattended flow.
- **Missing `CF_AI_GATEWAY_ID` in config**: Correctly read from `wrangler.jsonc`. No change needed.
- **Slack vars in config**: May be used by gateway itself. Keep as-is.

## Verification

1. **Grep for `<VPS_IP>`** (without `1`) across all playbooks — should return zero results
2. **Grep for `claw.example.com`** across all playbooks — should return zero results
3. **Grep for `openclaw-config.env` in playbook 04** host alerter section — should not appear
4. **Check `openclaw.json` basePath** uses `<OPENCLAW_DOMAIN_PATH>` placeholder
5. **Check CLI compiles**: `cd cli && npx tsc --noEmit`
6. **Read each modified file** end-to-end for internal consistency
