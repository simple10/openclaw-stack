# Plan: Route All LLM Providers Through AI Gateway Worker

## Context

Currently the gateway container receives `ANTHROPIC_API_KEY` directly — the real Anthropic key lives on the VPS. We want ALL LLM provider traffic to route through the AI Gateway Worker (Cloudflare). Real API keys stay only on the Worker; the VPS gets the Worker's `AUTH_TOKEN` as every provider's API key and the Worker URL as every provider's base URL.

This ensures:

- No real provider API keys on the VPS
- Unsupported providers fail at the Worker (404) rather than bypassing to default endpoints
- All LLM traffic gets Cloudflare AI Gateway analytics

The AI Gateway Worker currently only handles Anthropic + OpenAI. Other providers will 404 at the Worker, which is the intended behavior until the Worker is expanded.

## Built-in Provider Env Vars (from Context7 docs)

| Provider | API Key Env Var | Base URL Env Var | Notes |
|----------|----------------|------------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | SDK-confirmed |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | SDK-confirmed |
| Google | `GOOGLE_API_KEY` | — | No standard base URL env var |
| xAI | `XAI_API_KEY` | — | OpenAI-compatible |
| Groq | `GROQ_API_KEY` | — | OpenAI-compatible |
| Cerebras | `CEREBRAS_API_KEY` | — | OpenAI-compatible |
| Mistral | `MISTRAL_API_KEY` | — | Has own SDK |
| OpenRouter | `OPENROUTER_API_KEY` | — | OpenAI-compatible |

**Excluded:** GitHub Copilot (OAuth-based, not API key).

Only Anthropic and OpenAI have confirmed SDK-level `*_BASE_URL` env var support. For the rest, setting `*_API_KEY` to the gateway token prevents real key leakage. Requests to those providers will fail with an auth error at the provider's API (wrong token), which is acceptable — the key isolation goal is still met.

## Changes

### 1. `openclaw-config.env` (lines 17-24)

Replace `ANTHROPIC_API_KEY` with required AI Gateway vars:

```bash
# Before
# API Keys (required)
ANTHROPIC_API_KEY=sk-123

# AI Gateway Worker (optional — ...)
# AI_GATEWAY_WORKER_URL=https://ai-gateway-proxy.<account>.workers.dev
# AI_GATEWAY_AUTH_TOKEN=<worker-auth-token>

# After
# AI Gateway (required — routes ALL LLM requests through Cloudflare AI Gateway)
# Real provider API keys live only on the Worker (Cloudflare), never on the VPS.
AI_GATEWAY_WORKER_URL=https://ai-gateway-proxy.<account>.workers.dev
AI_GATEWAY_AUTH_TOKEN=<worker-auth-token>
```

### 2. `openclaw-config.env.example` (lines 17-25)

Same change as above but with example placeholder comments.

### 3. `playbooks/04-vps1-openclaw.md`

**3a. Variables section (line 27):** Replace `ANTHROPIC_API_KEY` with `AI_GATEWAY_WORKER_URL` and `AI_GATEWAY_AUTH_TOKEN`.

**3b. Section 4.5 — .env file creation (lines ~128-140):**

Replace the `ANTHROPIC_API_KEY` line and comments:

```bash
# Before
# Model provider
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# After
# AI Gateway — all provider API keys and base URLs are mapped in compose override
AI_GATEWAY_WORKER_URL=${AI_GATEWAY_WORKER_URL}
AI_GATEWAY_AUTH_TOKEN=${AI_GATEWAY_AUTH_TOKEN}
```

**3c. Section 4.6 — compose override environment block (lines 232-237):**

Replace single `ANTHROPIC_API_KEY` with all provider mappings:

```yaml
    environment:
      - NODE_ENV=production
      # AI Gateway: route all LLM providers through the Worker.
      # All API keys -> AUTH_TOKEN, Anthropic/OpenAI base URLs -> Worker URL.
      # Providers the Worker doesn't handle yet will fail at the Worker (404),
      # preventing requests from leaking to default provider endpoints.
      - ANTHROPIC_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - ANTHROPIC_BASE_URL=${AI_GATEWAY_WORKER_URL}
      - OPENAI_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - OPENAI_BASE_URL=${AI_GATEWAY_WORKER_URL}
      - GOOGLE_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - XAI_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - GROQ_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - CEREBRAS_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - MISTRAL_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - OPENROUTER_API_KEY=${AI_GATEWAY_AUTH_TOKEN}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - TZ=UTC
```

### 4. `REQUIREMENTS.md`

**4a. Section 3.4 (~line 309):** Replace `ANTHROPIC_API_KEY — From .env` with note about AI Gateway provider mapping.

**4b. Section 3.14 env var table (~lines 645-646):** Replace `ANTHROPIC_API_KEY` row with `AI_GATEWAY_WORKER_URL` and `AI_GATEWAY_AUTH_TOKEN` rows.

### 5. `CLAUDE.md`

**5a. Config example (~line 65):** Replace `ANTHROPIC_API_KEY=sk-ant-...` with `AI_GATEWAY_WORKER_URL` and `AI_GATEWAY_AUTH_TOKEN` under the `# Required` section (move from Workers section).

**5b. Required field validation (~line 120):** Replace `ANTHROPIC_API_KEY` check with `AI_GATEWAY_WORKER_URL` and `AI_GATEWAY_AUTH_TOKEN` checks.

### 6. `playbooks/08-workers.md` (lines 80-83)

Update architecture comment:

```bash
# Before
# The ANTHROPIC_API_KEY on VPS becomes the Worker's AUTH_TOKEN
# The ANTHROPIC_BASE_URL points to the Worker
# This way, the real Anthropic key never touches the VPS

# After
# All provider API keys on the VPS are set to the Worker's AUTH_TOKEN
# Anthropic and OpenAI base URLs point to the Worker
# No real provider API keys ever touch the VPS
```

### 7. `README.md`

**7a. Line 47:** Replace `Anthropic API Key - needed by OpenClaw to run onboarding process` with `AI Gateway Worker - proxies all LLM requests (real API keys live on the Worker)`.

**7b. Lines 118-127 (Step 2.1):** Replace Anthropic key checklist item with AI Gateway Worker URL & auth token. Add note that real provider keys are configured as Worker secrets.

**7c. Line 292:** Update security note to state keys are never on the VPS (not conditional "when using AI Gateway").

### 8. `TODO.md` (line 19)

Replace `Test ANTHROPIC_BASE_URL env var with OpenClaw/Anthropic SDK` with `Test AI Gateway routing end-to-end (all provider keys via AI_GATEWAY_AUTH_TOKEN)`.

## No Changes Needed

- `workers/ai-gateway/` source code — Worker stays as-is (expanding it is a separate task)
- `openclaw.json` configuration — no provider config there currently
- `vector.toml` — unrelated to LLM providers
- `playbooks/05-cloudflare-tunnel.md` — tunnel routes to localhost:18789, no provider awareness
- `playbooks/06-backup.md` — backs up .env file regardless of contents

## Verification

1. After deploying: `curl http://localhost:18789/health` from VPS should return OK (gateway starts with AI Gateway token as its Anthropic key)
2. Send a test Anthropic request through the gateway — should route through AI Gateway Worker
3. Verify Cloudflare AI Gateway dashboard shows the request
4. Verify no real API keys exist on the VPS (check `.env` file contents)
