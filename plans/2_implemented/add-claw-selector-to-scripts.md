# Plan: Interactive Claw Selection Menu for Multi-Claw Scripts

## Context

In a multi-claw setup, scripts that use `resolve_gateway()` (in `scripts/lib/resolve-gateway.sh`) currently error out with a static list of `--instance` hints when multiple containers are detected. The user must re-run the command with the `--instance` flag. This is the same UX issue in `logs-explorer.sh` direct mode, which has its own instance resolution.

The goal is to present an interactive numbered menu (like the agent picker in `ssh-agent.sh` and `start-browser.sh`) instead of erroring, using a shared lib to avoid code duplication.

## Approach

### 1. Create `scripts/lib/select-claw.sh` — shared interactive picker

A single function `select_claw()` that:

- Takes a newline-separated list of claw names
- **1 item**: auto-selects, prints info to stderr
- **Multiple + interactive terminal**: shows numbered menu, reads selection from `/dev/tty`
- **Multiple + non-interactive**: errors with `--instance` hints (preserves scripted/CI behavior)
- Returns the selected name on stdout

Uses `/dev/tty` for `read` to work correctly when called inside `$()` subshells (where stdout is captured by pipe but the terminal is still accessible).

### 2. Modify `scripts/lib/resolve-gateway.sh` — use `select_claw()`

- Source `select-claw.sh` at the top
- Replace the single-container and multiple-container handling with a call to `select_claw()`
- Keep the zero-container error as-is (different message: "Start with openclaw-multi.sh start")

**This fixes all 11 scripts that source resolve-gateway.sh automatically:**
`ssh-openclaw.sh`, `health-check.sh`, `logs-openclaw.sh`, `openclaw.sh`, `restart-gateway.sh`, `restart-sandboxes.sh`, `start-browser.sh`, `ssh-agent.sh`, `update-openclaw.sh`, `update-sandboxes.sh`, `update-sandbox-toolkit.sh`

### 3. Modify `scripts/logs-explorer.sh` — use `select_claw()` in direct mode

Replace the inline instance resolution (lines 81-105) with:

- Source `select-claw.sh`
- SSH to list instances (keep existing SSH call)
- Pass list to `select_claw()` instead of inline count/error logic

### Scripts that DON'T need changes

- `ssh-vps.sh`, `telegram-test.sh` — not claw-specific
- `logs-docker.sh` — streams all compose logs, not instance-specific
- `sync-configs.sh`, `sync-media.sh` — intentionally operate on ALL instances when no `--instance` given

## Menu UX

```
Multiple claws detected:

  [1] main-claw
  [2] muxxibot-claw

Select claw [1-2]:
```

Matches the existing numbered-picker style from `ssh-agent.sh` and `start-browser.sh`.

## Verification

- Run any script without `--instance` in a multi-claw setup → should see interactive menu
- Run with `--instance main-claw` → should skip menu (existing behavior preserved)
- Run with `OPENCLAW_INSTANCE=main-claw` → should skip menu (env var still works)
- Pipe output: `scripts/openclaw.sh status 2>/dev/null` → should error with --instance hints (non-interactive)
- Single claw setup → should auto-detect as before
