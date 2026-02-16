# Setting Up Claude Code Auth Token in a Sandbox Container

> Give these instructions to claude to automate the `claude setup-token` process as much as possible

## Overview

This procedure authenticates Claude Code inside an OpenClaw sandbox container using `claude setup-token`. The sandbox environment has constraints that require specific workarounds.

## Prerequisites

- SSH access to the VPS (`openclaw-config.env` sourced for `SSH_KEY_PATH`, `SSH_PORT`, `SSH_USER`, `VPS1_IP`)
- The sandbox container must be running (use `scripts/ssh-agent.sh` to start it if stopped)
- The user must have a Claude subscription (required for `setup-token`)

## Key Constraints & Workarounds

| Constraint | Cause | Workaround |
|---|---|---|
| `claude setup-token` requires a TTY (Ink raw mode) | Cannot run via simple `docker exec` or pipe input | Use **tmux** (`/opt/skill-bins/tmux`) inside the sandbox |
| OAuth token exchange fails with HTTP 400 | Sandbox has `HTTPS_PROXY` env var pointing to a Cloudflare Worker that fails CONNECT tunnels | Run with `env -u HTTPS_PROXY` to bypass the proxy |
| Cannot open a browser from the sandbox | Headless environment | User must manually click the OAuth URL and paste the code back |
| Token is displayed but NOT auto-stored | `setup-token` outputs a token for manual use | Set `CLAUDE_CODE_OAUTH_TOKEN` in `~/.bashrc` |

## Procedure

### Helper Variables

```bash
# Source config
source openclaw-config.env
GW="openclaw-gateway"
# Get the sandbox container name (replace "code" with the target agent ID)
SANDBOX=$(ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec --user node $GW openclaw sandbox list --json 2>/dev/null" \
  | sed '/^{"time":/d' \
  | python3 -c "import json,sys; data=json.load(sys.stdin); [print(c['containerName']) for c in data.get('containers',[]) if 'code' in c.get('sessionKey','')]")
```

### Step 1: Start `claude setup-token` in tmux (without HTTPS_PROXY)

```bash
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    tmux kill-server 2>/dev/null || true
    tmux new-session -d -s setup \"env -u HTTPS_PROXY claude setup-token 2>&1 | tee /tmp/setup-log; sleep 300\"
  '"
```

Key details:

- `env -u HTTPS_PROXY` — unsets the proxy so OAuth token exchange can reach `platform.claude.com` directly
- `| tee /tmp/setup-log` — captures output so the token can be retrieved even after the process exits
- `; sleep 300` — keeps the tmux session alive after the command finishes so you can read the pane

### Step 2: Wait ~12 seconds, then capture the OAuth URL

```bash
sleep 12
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX \
    tmux capture-pane -t setup -p" | grep -A5 'https://claude.ai'
```

The URL will be split across multiple lines due to terminal width. Reassemble it into a single URL (remove line breaks).

### Step 3: User authorizes and obtains the code

1. User clicks the OAuth URL in their browser
2. User authenticates on claude.ai
3. User is redirected to `platform.claude.com/oauth/code/callback`
4. The page displays a code in the format: `<code>#<state>`
5. User provides this code

### Step 4: Send the code via tmux (literal mode + carriage return)

```bash
CODE="<the full code#state string from the user>"
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    tmux send-keys -t setup -l \"$CODE\"
    tmux send-keys -t setup C-m
  '"
```

Important:

- Use `send-keys -l` (literal flag) for the code text — prevents tmux from interpreting special characters
- Use a separate `send-keys C-m` for Enter (carriage return)
- Both commands in a single `sh -c` to minimize delay

### Step 5: Check the result (~10 seconds later)

```bash
sleep 10
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    tmux capture-pane -t setup -p | tail -10
    echo ===
    cat /tmp/setup-log 2>/dev/null | strings | tail -10
  '"
```

On success, the output will contain:

```
sk-ant-oat01-<...long token...>

Store this token securely. You won't be able to see it again.

Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

On failure (`OAuth error: Request failed with status code 400`):

- The code likely expired — retry from Step 1
- Ensure `HTTPS_PROXY` was properly unset

### Step 6: Persist the token in the sandbox

```bash
TOKEN="sk-ant-oat01-<the token from step 5>"
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    echo \"export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN\" >> ~/.bashrc
  '"
```

### Step 7: Verify authentication

```bash
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN
    claude auth status
  '"
```

Expected output:

```json
{
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}
```

### Step 8: Clean up

```bash
ssh -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec $GW docker exec -u 1000:1000 $SANDBOX sh -c '
    tmux kill-server 2>/dev/null || true
    rm -f /tmp/setup-log
  '"
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `Raw mode is not supported` error | You're not using tmux. The command MUST run inside a tmux session for Ink TTY support. |
| `CONNECT tunnel failed, response 400` | `HTTPS_PROXY` is still set. Use `env -u HTTPS_PROXY`. |
| `OAuth error: Request failed with status code 400` | Code expired or was already used. Retry from Step 1. Move quickly between Steps 2-4. |
| tmux session disappears immediately | The command errored. Check `/tmp/setup-log` for output. Add `; sleep 300` to keep the session alive. |
| Token works but `claude auth status` shows `loggedIn: false` | The env var isn't set in the current shell. Source `~/.bashrc` or export it manually. |

## Notes

- The token is a long-lived OAuth token (format: `sk-ant-oat01-*`). Store it securely.
- The sandbox also has `ANTHROPIC_BASE_URL` set to the AI Gateway Worker proxy — this is separate from `HTTPS_PROXY` and should be left as-is for normal Claude API calls.
- If the sandbox is recreated (e.g., after `openclaw sandbox recreate`), the token in `~/.bashrc` will be lost and this procedure must be repeated.
