# Using Claude Code Subscription

See <https://docs.openclaw.ai/gateway/authentication>

Claude Code OAuth tokens are designed for CI/CD that uses claude code.

```bash
# Get setup token from claude
claude setup-token

# Provide token to openclaw
openclaw models auth paste-token --provider anthropic
```

## How OpenClaw Handles Subscription Tokens

### Setup-Token Flow

The `openclaw models auth setup-token --provider anthropic` command:

1. Prompts user for a token (must start with sk-ant-oat01-, min 80 chars)
2. Stores it as a type: "token" credential in auth-profiles.json
3. Updates the config to reference this auth profile

### Key Finding: No Automatic Refresh

Setup-tokens (subscription tokens) are NOT automatically refreshable by OpenClaw. They are treated as static bearer tokens.

OpenClaw has three credential types:

┌─────────┬──────────┬───────────────────────────────────────────────────────┐
│  Type   │ Refresh? │                        Example                        │
├─────────┼──────────┼───────────────────────────────────────────────────────┤
│ api_key │ No       │ Standard API keys                                     │
├─────────┼──────────┼───────────────────────────────────────────────────────┤
│ token   │ No       │ Setup-tokens (sk-ant-oat01-...)                       │
├─────────┼──────────┼───────────────────────────────────────────────────────┤
│ oauth   │ Yes      │ OAuth with refresh tokens (Qwen Portal, Chutes, etc.) │
└─────────┴──────────┴───────────────────────────────────────────────────────┘

### What Happens When a Token Expires

In src/agents/auth-profiles/oauth.ts:

- On each API call, resolveApiKeyForProfile() checks Date.now() >= cred.expires
- If expired with no refresh capability, it returns null
- OpenClaw then rotates to the next available auth profile
- If all profiles are exhausted, the API call fails

### No Background Process

There's no refresh scheduler. Tokens are checked on-demand when making API requests. If the setup-token expires, you need to
manually run claude setup-token again and re-paste it into OpenClaw.

### Key Source Files

┌──────────────────────────────────────┬──────────────────────────────────┐
│                 File                 │               Role               │
├──────────────────────────────────────┼──────────────────────────────────┤
│ src/commands/models/auth.ts          │ CLI setup-token command          │
├──────────────────────────────────────┼──────────────────────────────────┤
│ src/agents/auth-profiles/types.ts    │ Credential type definitions      │
├──────────────────────────────────────┼──────────────────────────────────┤
│ src/agents/auth-profiles/oauth.ts    │ Token resolution & OAuth refresh │
├──────────────────────────────────────┼──────────────────────────────────┤
│ src/agents/pi-embedded-runner/run.ts │ Runtime API key injection        │
└──────────────────────────────────────┴──────────────────────────────────┘

OpenClaw does not support OAuth token refresh for Anthropic or standard OpenAI.

Providers WITH OAuth refresh:

- Chutes — custom refresh handler
- Qwen Portal — custom refresh handler
- OpenAI Codex — via pi-ai library (this is the Codex CLI product, not the standard OpenAI API)
- Google Gemini CLI — via pi-ai library
- Google Antigravity — via pi-ai library

Anthropic & OpenAI — no OAuth:

- Anthropic — supports api_key (static) or token (setup-token from claude setup-token). The setup-token is a static bearer
token that expires and must be manually renewed. It's labeled "oauth" in some config paths but it's not true OAuth with
refresh tokens.
- OpenAI — standard API key only (static, no refresh needed since OpenAI API keys don't expire)

So for Anthropic, when the setup-token expires, you'd need to manually run claude setup-token again and re-paste it into
OpenClaw. There's no way around this currently — Anthropic doesn't expose a public OAuth refresh flow that OpenClaw could
use.
