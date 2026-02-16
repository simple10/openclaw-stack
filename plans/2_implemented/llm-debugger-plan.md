> openclaw just added llm_input and llm_output hooks yesterday. i've updated the source/openclaw so it should be
> available. Also see <https://github.com/openclaw/openclaw/pull/16724/changes>
> please create a new llm-logger plugin that works similarly to debug-logger by dumping the llm logs to file. be
> sure to add to logrotate as these files will be very large

# Plan: Create llm-logger plugin

## Context

OpenClaw added `llm_input` and `llm_output` plugin hooks (PR #16724). These fire on every LLM API call, providing prompts, responses, and token usage. We want a new plugin that logs these events to file for debugging and cost tracking, similar to how the existing `debug-logger` hook logs gateway lifecycle events to `debug.log`.

**Key architectural finding:** The `llm_input`/`llm_output` hooks are **typed plugin hooks** registered via `api.on()`, NOT internal hooks (the `command`/`session`/`agent`/`gateway` system used by debug-logger's HOOK.md + handler.js pattern). The llm-logger must be a **plugin** (like the coordinator plugin), not a managed hook.

**Vector shipping:** Vector ships Docker stdout/stderr via `docker_logs` source — it does NOT read application log files. The `llm.log` file is written via `fs.appendFile`, so it's file-only and never shipped. The plugin must avoid logging LLM content to `api.logger` or `console.log` — only use `console.error` for error messages (which won't contain LLM data).

## Files to Create

### 1. `deploy/plugins/llm-logger/openclaw.plugin.json`

Plugin metadata, same pattern as `deploy/plugins/coordinator/openclaw.plugin.json`.

### 2. `deploy/plugins/llm-logger/index.js`

ESM plugin that registers `llm_input` and `llm_output` handlers via `api.on()`. Writes JSONL to `~/.openclaw/logs/llm.log`.

**Handler design:**

The handler receives typed events (not the generic `InternalHookEvent`):

- `llm_input`: `(event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext)`
- `llm_output`: `(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext)`

Each log entry is a single JSON line:

```json
{
  "timestamp": "...",
  "event": "llm_input" | "llm_output",
  "agentId": "main",
  "sessionKey": "agent:main:main",
  "runId": "run-1",
  "sessionId": "session-1",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  // event-specific fields (see truncation below)
}
```

**Configurable truncation limits** — defined as constants at the top of `index.js`:

```js
// ── Truncation limits ──────────────────────────────────────────────
// Set to 0 (or remove) to disable truncation for that field.
// Default: no truncation — full content logged for development debugging.
const LIMITS = {
  SYSTEM_PROMPT: 0,      // 0 = no truncation
  PROMPT: 0,             // 0 = no truncation
  HISTORY_COUNT: 0,      // 0 = log all history messages; >0 = keep only last N
  HISTORY_MSG: 0,        // 0 = no truncation per history message
  RESPONSE: 0,           // 0 = no truncation for assistant texts
}
```

When a limit is set to `0`, that field is logged in full. Users can set values like `SYSTEM_PROMPT: 500`, `PROMPT: 2000`, `HISTORY_COUNT: 3`, etc. to reduce file size.

**Truncation function:**

```js
function truncate(str, limit) {
  if (!limit || typeof str !== 'string' || str.length <= limit) return str
  return str.slice(0, limit) + `...(truncated, ${str.length} total)`
}
```

**History summarization** (only when `HISTORY_COUNT > 0`):

```js
function formatHistory(messages) {
  if (!Array.isArray(messages)) return messages
  if (!LIMITS.HISTORY_COUNT) {
    // No limit — log all, but still truncate individual messages if HISTORY_MSG is set
    return LIMITS.HISTORY_MSG
      ? messages.map(m => truncateHistoryMsg(m))
      : messages
  }
  return {
    count: messages.length,
    last: messages.slice(-LIMITS.HISTORY_COUNT).map(m => truncateHistoryMsg(m))
  }
}
```

**Sensitive data:** Reuse the same redaction pattern from debug-logger — filter keys matching `token`, `secret`, `password`, `apiKey`, `api_key`, `authorization`. Applied to history messages since they could contain tool results with secrets.

**Logging discipline (no Vector shipping):**

- File writes only via `fs.appendFile` → never touches Docker stdout/stderr
- `api.logger.info()` used ONLY for one-time registration message (no LLM content)
- `console.error` for error messages only (no LLM content in error messages)
- NO `console.log` or `api.logger.info/debug` with event data

**Error handling:** Silent — `console.error` on failure, never throw (matches debug-logger pattern).

## Files to Modify

### 3. `deploy/openclaw.json`

Add `"llm-logger"` to the `plugins.allow` array and add an entry under `plugins.entries`:

```jsonc
"allow": [
  "coordinator",
  "llm-logger"  // LLM logger plugin — logs prompts/responses to llm.log (disabled by default)
],
"entries": {
  // ... existing coordinator entry ...
  // LLM Logger Plugin
  // Logs all LLM input/output events to ~/.openclaw/logs/llm.log (JSONL)
  // For development debugging — disabled by default to avoid large log files.
  // Enable with: openclaw config set plugins.entries.llm-logger.enabled true
  // Verification steps in deploy/plugins/llm-logger/index.js header comment.
  "llm-logger": {
    "enabled": false
  }
}
```

### 4. `deploy/logrotate-openclaw`

Add a **separate rotation block** for `llm.log` with more aggressive settings. LLM logs are much larger than debug/command logs — every LLM call produces two events with substantial payloads.

```
/home/openclaw/.openclaw/logs/llm.log
{
    su root root
    daily
    rotate 7
    maxsize 50M
    missingok
    notifempty
    copytruncate
    delaycompress
    compress
}
```

Key differences from existing block: `daily` (not weekly), `rotate 7` (not 4), `maxsize 50M` (triggers mid-day rotation if needed).

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `deploy/plugins/llm-logger/openclaw.plugin.json` | Create | Plugin metadata |
| `deploy/plugins/llm-logger/index.js` | Create | Plugin implementation |
| `deploy/openclaw.json` | Modify | Add to `plugins.allow` + `plugins.entries` |
| `deploy/logrotate-openclaw` | Modify | Add separate daily rotation block for `llm.log` |

## Deployment

No playbook changes needed — the existing generic deployment steps handle this:

- `docker-compose.override.yml` already bind-mounts `./deploy/plugins` → `/app/deploy/plugins:ro`
- `entrypoint-gateway.sh` section 1h copies all plugins from `deploy/plugins/` to `~/.openclaw/extensions/`
- Playbook 04 section 4.13 SCPs all plugins to VPS via `scp -r deploy/plugins/*`
- Logrotate config is deployed via playbook 04 section 4.14 (`# <<< deploy/logrotate-openclaw >>>` sentinel)

**Note:** `plugins.*` changes require a gateway restart (not hot-reloadable). Plugin is disabled by default — no verification steps in playbooks. Verification instructions are embedded in the `index.js` header comment so agents can read them when asked to enable the plugin.
