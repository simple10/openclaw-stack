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
//
// LLM Telemetry (llemtry):
//   When ENABLE_LLEMTRY_LOGGING=true, also sends spans to the Log Worker's /llemtry
//   endpoint for forwarding to Langfuse (or other backends). Derives the URL from
//   LOG_WORKER_URL (replaces /logs suffix with /llemtry). Uses LOG_WORKER_TOKEN for auth.

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

// ── Llemtry configuration (from environment) ───────────────────────
const LLEMTRY_ENABLED_ENV = process.env.ENABLE_LLEMTRY_LOGGING === 'true'
const LLEMTRY_URL = process.env.LOG_WORKER_URL
  ? process.env.LOG_WORKER_URL.replace(/\/logs$/, '/llemtry')
  : undefined
const LLEMTRY_TOKEN = process.env.LOG_WORKER_TOKEN
const INSTANCE_ID = process.env.OPENCLAW_INSTANCE_ID || undefined
const HOSTNAME = process.env.VPS_HOSTNAME || undefined

// Stale pending input cleanup interval (5 minutes)
const PENDING_INPUT_TTL_MS = 5 * 60 * 1000
const PENDING_CLEANUP_INTERVAL_MS = 60 * 1000

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

function contextFields(event, ctx) {
  return {
    agentId: ctx.agentId ?? undefined,
    sessionKey: ctx.sessionKey ?? undefined,
    // runId is on the event object, not ctx
    runId: event.runId ?? ctx.runId ?? undefined,
    sessionId: event.sessionId ?? ctx.sessionId ?? undefined,
  }
}

// ── Llemtry span assembly helpers ──────────────────────────────────

function buildLlemtrySpan(input, outputEvent, ctx) {
  const startNano = input ? String(input.timestamp * 1_000_000) : String(Date.now() * 1_000_000)
  const endNano = String(Date.now() * 1_000_000)

  return {
    traceId: outputEvent.sessionId ?? ctx.sessionId,
    spanId: outputEvent.runId ?? ctx.runId,
    name: 'gen_ai.generate',
    kind: 'client',
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    status: { code: 'OK' },
    attributes: {
      'gen_ai.system': outputEvent.provider,
      'gen_ai.request.model': outputEvent.model,
      'gen_ai.usage.input_tokens': outputEvent.usage?.input,
      'gen_ai.usage.output_tokens': outputEvent.usage?.output,
      'gen_ai.request.max_tokens': input?.event?.maxTokens,
      'gen_ai.request.temperature': input?.event?.temperature,
      'gen_ai.response.stop_reason': outputEvent.stopReason ?? outputEvent.lastAssistant?.stopReason ?? outputEvent.lastAssistant?.stop_reason,
      'openclaw.agent.id': ctx.agentId,
      'openclaw.session.id': outputEvent.sessionId ?? ctx.sessionId,
      'openclaw.session.key': ctx.sessionKey,
      'openclaw.run.id': outputEvent.runId ?? ctx.runId,
      'openclaw.usage.cache_read_tokens': outputEvent.usage?.cacheRead,
      'openclaw.usage.cache_write_tokens': outputEvent.usage?.cacheWrite,
      'openclaw.images_count': input?.event?.imagesCount,
    },
    events: [
      input && {
        name: 'gen_ai.content.prompt',
        timeUnixNano: startNano,
        body: {
          system: input.event.systemPrompt,
          messages: input.event.historyMessages,
          prompt: input.event.prompt,
        },
      },
      {
        name: 'gen_ai.content.completion',
        timeUnixNano: endNano,
        body: outputEvent.lastAssistant ?? outputEvent.assistantTexts,
      },
    ].filter(Boolean),
  }
}

async function sendSpan(span) {
  const batch = {
    resource: {
      serviceName: 'openclaw-gateway',
      instanceId: INSTANCE_ID,
      hostname: HOSTNAME,
    },
    spans: [span],
  }
  const res = await fetch(LLEMTRY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLEMTRY_TOKEN}`,
    },
    body: JSON.stringify(batch),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
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

    // ── Llemtry output validation ────────────────────────────────
    let llemtryEnabled = LLEMTRY_ENABLED_ENV
    if (llemtryEnabled) {
      if (!LLEMTRY_URL || !LLEMTRY_TOKEN) {
        api.logger.error(
          '[llm-logger] ENABLE_LLEMTRY_LOGGING is true but LOG_WORKER_URL or LOG_WORKER_TOKEN is missing. ' +
            'LLM telemetry will NOT be sent. Set these env vars or disable ENABLE_LLEMTRY_LOGGING.'
        )
        llemtryEnabled = false
      } else {
        api.logger.info(`[llm-logger] LLM telemetry enabled → ${LLEMTRY_URL}`)
      }
    }

    // In-memory buffer: runId → pending input event (for span assembly)
    const pendingInputs = new Map()

    // Periodic cleanup of stale pending inputs (prevents memory leaks)
    if (llemtryEnabled) {
      setInterval(() => {
        const now = Date.now()
        for (const [runId, entry] of pendingInputs) {
          if (now - entry.timestamp > PENDING_INPUT_TTL_MS) {
            pendingInputs.delete(runId)
          }
        }
      }, PENDING_CLEANUP_INTERVAL_MS)
    }

    // ── llm_input handler ──────────────────────────────────────────
    // Actual OpenClaw event fields: runId, sessionId, provider, model,
    // systemPrompt, prompt, historyMessages, imagesCount
    api.on('llm_input', async (event, ctx) => {
      const entry = {
        timestamp: new Date().toISOString(),
        event: 'llm_input',
        ...contextFields(event, ctx),
        provider: event.provider ?? undefined,
        model: event.model ?? undefined,
      }

      // System prompt
      if (event.systemPrompt !== undefined) {
        entry.systemPrompt = truncate(event.systemPrompt, LIMITS.SYSTEM_PROMPT)
      }

      // Current prompt
      if (event.prompt !== undefined) {
        entry.prompt =
          typeof event.prompt === 'string' ? truncate(event.prompt, LIMITS.PROMPT) : event.prompt
      }

      // History messages (OpenClaw uses historyMessages, not messages/history)
      const history = event.historyMessages ?? event.messages ?? event.history
      if (history !== undefined) {
        entry.history = formatHistory(history)
      }

      // Image count
      if (event.imagesCount !== undefined) entry.imagesCount = event.imagesCount

      // Tools (if provided by future OpenClaw versions)
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

      // Buffer for llemtry span assembly
      if (llemtryEnabled) {
        const runId = event.runId ?? ctx.runId
        if (runId) {
          pendingInputs.set(runId, {
            timestamp: Date.now(),
            event,
            ctx,
          })
        }
      }
    })

    // ── llm_output handler ─────────────────────────────────────────
    // Actual OpenClaw event fields: runId, sessionId, provider, model,
    // assistantTexts, lastAssistant, usage{input,output,cacheRead,cacheWrite,total}
    api.on('llm_output', async (event, ctx) => {
      const entry = {
        timestamp: new Date().toISOString(),
        event: 'llm_output',
        ...contextFields(event, ctx),
        provider: event.provider ?? undefined,
        model: event.model ?? undefined,
      }

      // Response content — OpenClaw provides lastAssistant (message object)
      // and assistantTexts (array of text strings)
      const response = event.lastAssistant ?? event.response
      if (response !== undefined) {
        if (typeof response === 'string') {
          entry.response = truncate(response, LIMITS.RESPONSE)
        } else if (response?.content) {
          // Structured response — truncate text blocks
          entry.response = {
            ...response,
            content: Array.isArray(response.content)
              ? response.content.map((block) => {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    return { ...block, text: truncate(block.text, LIMITS.RESPONSE) }
                  }
                  return block
                })
              : response.content,
          }
        } else {
          entry.response = response
        }
      }

      // Token usage — OpenClaw uses {input, output, cacheRead, cacheWrite, total}
      // Normalize to inputTokens/outputTokens for consistent log schema
      if (event.usage !== undefined) {
        entry.usage = event.usage
        // Also write normalized top-level fields for easy parsing
        entry.inputTokens = event.usage?.input ?? 0
        entry.outputTokens = event.usage?.output ?? 0
        entry.cacheReadTokens = event.usage?.cacheRead ?? 0
        entry.cacheWriteTokens = event.usage?.cacheWrite ?? 0
      }
      // Fallback: check for top-level token fields (future-proofing)
      if (event.inputTokens !== undefined) entry.inputTokens = event.inputTokens
      if (event.outputTokens !== undefined) entry.outputTokens = event.outputTokens
      if (event.cacheReadTokens !== undefined) entry.cacheReadTokens = event.cacheReadTokens
      if (event.cacheWriteTokens !== undefined) entry.cacheWriteTokens = event.cacheWriteTokens

      // Stop reason — extract from lastAssistant if available
      const stopReason = event.stopReason ?? response?.stopReason ?? response?.stop_reason
      if (stopReason !== undefined) entry.stopReason = stopReason

      // Duration (if provided by future OpenClaw versions)
      if (event.durationMs !== undefined) entry.durationMs = event.durationMs

      // Tool calls — extract from lastAssistant content blocks
      if (event.toolCalls !== undefined) {
        entry.toolCalls = Array.isArray(event.toolCalls)
          ? event.toolCalls.map((tc) => ({ name: tc.name || tc.function?.name, id: tc.id }))
          : event.toolCalls
      } else if (response?.content && Array.isArray(response.content)) {
        // Extract tool_use blocks from the assistant message
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
        if (toolUseBlocks.length > 0) {
          entry.toolCalls = toolUseBlocks.map((b) => ({ name: b.name, id: b.id }))
        }
      }

      await writeLine(entry)

      // Assemble llemtry span and send
      if (llemtryEnabled) {
        const runId = event.runId ?? ctx.runId
        const input = runId ? pendingInputs.get(runId) : undefined
        if (runId) pendingInputs.delete(runId)

        const span = buildLlemtrySpan(input, event, ctx)
        sendSpan(span).catch((err) =>
          console.error(`[llm-logger] llemtry send failed: ${err.message}`)
        )
      }
    })

    api.logger.info('[llm-logger] Plugin registered — logging to ~/.openclaw/logs/llm.log')
  },
}
