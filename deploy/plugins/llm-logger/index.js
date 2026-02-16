// LLM Logger Plugin
// Logs all LLM input/output events to ~/.openclaw/logs/llm.log as JSONL.
// Uses the typed plugin hooks `llm_input` and `llm_output` (registered via api.on()).
//
// IMPORTANT: the required hooks for this plugin were added in openclaw 2026.2.15
// Upgrading openclaw is required to use this plugin if older version.
// Earlier versions will simply fail to trigger the plugin hooks.
//
// Disabled by default to avoid large log files. Enable with:
//   openclaw config set plugins.entries.llm-logger.enabled true
// Then restart the gateway (plugins.* changes are not hot-reloadable).
//
// Verification:
//   1. Enable the plugin and restart gateway
//   2. Send any message to an agent
//   3. Check the log: tail -f ~/.openclaw/logs/llm.log | jq .
//   4. Each LLM call produces two entries: llm_input (prompt) and llm_output (response)
//
// Log file is managed by logrotate (daily, 50M maxsize, 7 rotations).
// File writes only — no LLM content is sent to stdout/stderr (avoids Vector shipping).

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ── Truncation limits ──────────────────────────────────────────────
// Set to 0 (or remove) to disable truncation for that field.
// Default: no truncation — full content logged for development debugging.
const LIMITS = {
  SYSTEM_PROMPT: 0, // 0 = no truncation
  PROMPT: 0, // 0 = no truncation
  HISTORY_COUNT: 0, // 0 = log all history messages; >0 = keep only last N
  HISTORY_MSG: 0, // 0 = no truncation per history message
  RESPONSE: 0, // 0 = no truncation for assistant texts
}

// Keys to redact from logged objects (matches debug-logger pattern)
const SENSITIVE_KEYS = /token|secret|password|apiKey|api_key|authorization/i

function truncate(str, limit) {
  if (!limit || typeof str !== 'string' || str.length <= limit) return str
  return str.slice(0, limit) + `...(truncated, ${str.length} total)`
}

function redactValue(obj) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') return obj
  if (Array.isArray(obj)) return obj.map(redactValue)
  if (typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.test(key)) {
        result[key] = '[REDACTED]'
      } else {
        result[key] = redactValue(value)
      }
    }
    return result
  }
  return obj
}

function truncateHistoryMsg(msg) {
  if (!msg || typeof msg !== 'object') return msg
  if (!LIMITS.HISTORY_MSG) return redactValue(msg)
  const result = { ...msg }
  if (typeof result.content === 'string') {
    result.content = truncate(result.content, LIMITS.HISTORY_MSG)
  }
  return redactValue(result)
}

function formatHistory(messages) {
  if (!Array.isArray(messages)) return messages
  if (!LIMITS.HISTORY_COUNT) {
    // No count limit — log all, but still truncate individual messages if HISTORY_MSG is set
    return LIMITS.HISTORY_MSG ? messages.map((m) => truncateHistoryMsg(m)) : redactValue(messages)
  }
  return {
    count: messages.length,
    last: messages.slice(-LIMITS.HISTORY_COUNT).map((m) => truncateHistoryMsg(m)),
  }
}

function contextFields(ctx) {
  return {
    agentId: ctx.agentId ?? undefined,
    sessionKey: ctx.sessionKey ?? undefined,
    runId: ctx.runId ?? undefined,
    sessionId: ctx.sessionId ?? undefined,
  }
}

// Gateway package.json has "type": "module" — plugins must use ESM exports
export default {
  id: 'llm-logger',

  register(api) {
    const ocDir = join(api.resolvePath('~'), '.openclaw')
    const logsDir = join(ocDir, 'logs')
    const logFile = join(logsDir, 'llm.log')

    // Ensure logs directory exists (fire-and-forget, errors caught below per-write)
    const dirReady = mkdir(logsDir, { recursive: true }).catch(() => {})

    async function writeLine(entry) {
      try {
        await dirReady
        await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8')
      } catch (e) {
        // Silent failure — no LLM content in error message
        console.error(`[llm-logger] Failed to write log entry: ${e.code || e.message}`)
      }
    }

    // ── llm_input handler ──────────────────────────────────────────
    api.on('llm_input', async (event, ctx) => {
      const entry = {
        timestamp: new Date().toISOString(),
        event: 'llm_input',
        ...contextFields(ctx),
        provider: event.provider ?? undefined,
        model: event.model ?? undefined,
      }

      // System prompt
      if (event.systemPrompt !== undefined) {
        entry.systemPrompt = truncate(event.systemPrompt, LIMITS.SYSTEM_PROMPT)
      }

      // Current prompt/messages
      if (event.prompt !== undefined) {
        entry.prompt =
          typeof event.prompt === 'string' ? truncate(event.prompt, LIMITS.PROMPT) : event.prompt
      }
      if (event.messages !== undefined) {
        entry.messages = formatHistory(event.messages)
      }

      // History
      if (event.history !== undefined) {
        entry.history = formatHistory(event.history)
      }

      // Tools
      if (event.tools !== undefined) {
        entry.toolCount = Array.isArray(event.tools) ? event.tools.length : undefined
        entry.toolNames = Array.isArray(event.tools)
          ? event.tools.map((t) => t.name || t.function?.name).filter(Boolean)
          : undefined
      }

      // Temperature, max tokens, etc.
      if (event.temperature !== undefined) entry.temperature = event.temperature
      if (event.maxTokens !== undefined) entry.maxTokens = event.maxTokens

      await writeLine(entry)
    })

    // ── llm_output handler ─────────────────────────────────────────
    api.on('llm_output', async (event, ctx) => {
      const entry = {
        timestamp: new Date().toISOString(),
        event: 'llm_output',
        ...contextFields(ctx),
        provider: event.provider ?? undefined,
        model: event.model ?? undefined,
      }

      // Response content
      if (event.response !== undefined) {
        if (typeof event.response === 'string') {
          entry.response = truncate(event.response, LIMITS.RESPONSE)
        } else if (event.response?.content) {
          // Structured response — truncate text blocks
          entry.response = {
            ...event.response,
            content: Array.isArray(event.response.content)
              ? event.response.content.map((block) => {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    return { ...block, text: truncate(block.text, LIMITS.RESPONSE) }
                  }
                  return block
                })
              : event.response.content,
          }
        } else {
          entry.response = event.response
        }
      }

      // Token usage
      if (event.usage !== undefined) entry.usage = event.usage
      if (event.inputTokens !== undefined) entry.inputTokens = event.inputTokens
      if (event.outputTokens !== undefined) entry.outputTokens = event.outputTokens
      if (event.cacheReadTokens !== undefined) entry.cacheReadTokens = event.cacheReadTokens
      if (event.cacheWriteTokens !== undefined) entry.cacheWriteTokens = event.cacheWriteTokens

      // Stop reason
      if (event.stopReason !== undefined) entry.stopReason = event.stopReason

      // Duration
      if (event.durationMs !== undefined) entry.durationMs = event.durationMs

      // Tool use in response
      if (event.toolCalls !== undefined) {
        entry.toolCalls = Array.isArray(event.toolCalls)
          ? event.toolCalls.map((tc) => ({
              name: tc.name || tc.function?.name,
              id: tc.id,
            }))
          : event.toolCalls
      }

      await writeLine(entry)
    })

    api.logger.info('[llm-logger] Plugin registered — logging to ~/.openclaw/logs/llm.log')
  },
}
