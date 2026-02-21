// Unified Telemetry Plugin
// Replaces both llm-logger plugin and debug-logger hook.
//
// Hooks into ALL OpenClaw event types via the typed plugin API:
//   - llm_input / llm_output (LLM calls)
//   - session_start / session_end (session lifecycle)
//   - before_compaction / after_compaction (context compaction)
//   - before_agent_start / agent_end (agent lifecycle)
//   - before_tool_call / after_tool_call (tool execution)
//   - message_received / message_sent (messaging)
//   - gateway_start / gateway_stop (gateway lifecycle)
//
// Output destinations (all independently configurable):
//   1. Local file (~/.openclaw/logs/telemetry.log) — JSONL
//   2. Log Worker /events — batched event shipping for D1 storage
//   3. Log Worker /llemtry — existing Langfuse span format (LLM events only)
//
// Configuration: openclaw.json → plugins.entries.telemetry.config
// Requires gateway restart after config changes (plugins.* not hot-reloadable).

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// ── Constants ────────────────────────────────────────────────────────

const SUMMARY_TRUNCATE_LENGTH = 500
const SENSITIVE_KEYS = /token|secret|password|apiKey|api_key|authorization/i

// Stale pending input cleanup interval (5 minutes)
const PENDING_INPUT_TTL_MS = 5 * 60 * 1000
const PENDING_CLEANUP_INTERVAL_MS = 60 * 1000

// ── Granularity helpers ──────────────────────────────────────────────

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

/**
 * Apply granularity level to content fields.
 * - full: all data, no truncation
 * - summary: metadata + truncated content (first 500 chars of text fields)
 * - metadata: event type, timestamps, IDs, durations, counts only (no content)
 * - off: skip entirely (caller checks before calling)
 */
function applyGranularity(data, level) {
  if (level === 'full') return redactValue(data)
  if (level === 'metadata') return filterMetadataOnly(data)
  if (level === 'summary') return truncateContent(redactValue(data))
  return data
}

function filterMetadataOnly(data) {
  if (!data || typeof data !== 'object') return data
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.test(key)) continue
    // Keep numbers, booleans, and short strings (IDs, names)
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else if (typeof value === 'string' && value.length <= 100) {
      result[key] = value
    }
    // Drop large text content, arrays, nested objects
  }
  return result
}

function truncateContent(data) {
  if (!data || typeof data !== 'object') return data
  if (Array.isArray(data)) return data.map(truncateContent)
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > SUMMARY_TRUNCATE_LENGTH) {
      result[key] = truncate(value, SUMMARY_TRUNCATE_LENGTH)
    } else if (Array.isArray(value)) {
      result[key] = truncateContent(value)
    } else if (typeof value === 'object' && value !== null) {
      result[key] = truncateContent(value)
    } else {
      result[key] = value
    }
  }
  return result
}

// ── Llemtry span assembly (carried over from llm-logger) ────────────

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

function makeSendSpan(url, token, instanceId, hostname) {
  return async function sendSpan(span) {
    const batch = {
      resource: {
        serviceName: 'openclaw-gateway',
        instanceId,
        hostname,
      },
      spans: [span],
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  }
}

// ── Event batch sender for /events ──────────────────────────────────

function makeEventSender(url, token, instanceId, hostname) {
  const buffer = []
  let flushTimer = null
  let batchSize = 50
  let flushIntervalMs = 10000

  function configure(opts) {
    if (opts.batchSize) batchSize = opts.batchSize
    if (opts.flushIntervalMs) flushIntervalMs = opts.flushIntervalMs
  }

  async function flush() {
    if (buffer.length === 0) return
    const events = buffer.splice(0, buffer.length)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          instance: { id: instanceId, hostname },
          events,
        }),
      })
      if (!res.ok) {
        console.error(`[telemetry] /events flush failed: HTTP ${res.status}`)
      }
    } catch (err) {
      console.error(`[telemetry] /events flush error: ${err.message}`)
    }
  }

  function enqueue(event) {
    buffer.push(event)
    if (buffer.length >= batchSize) {
      flush()
    }
    // Reset flush timer on each enqueue
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, flushIntervalMs)
  }

  async function shutdown() {
    if (flushTimer) clearTimeout(flushTimer)
    await flush()
  }

  return { enqueue, configure, flush, shutdown }
}

// ── Plugin export ───────────────────────────────────────────────────

export default {
  id: 'telemetry',

  register(api) {
    const cfg = api.pluginConfig ?? {}
    const eventsCfg = cfg.events ?? {}
    const llemtryCfg = cfg.llemtry ?? {}
    const categories = cfg.categories ?? {}

    // Category granularity defaults
    const granularity = {
      llm: categories.llm || 'full',
      session: categories.session || 'full',
      tool: categories.tool || 'summary',
      message: categories.message || 'summary',
      agent: categories.agent || 'full',
      gateway: categories.gateway || 'metadata',
    }

    // ── File logging setup ──────────────────────────────────────
    const logFileName = cfg.logFile ?? 'telemetry.log'
    const fileLoggingEnabled = logFileName !== ''

    const ocDir = join(api.resolvePath('~'), '.openclaw')
    const logsDir = join(ocDir, 'logs')
    const logFile = fileLoggingEnabled ? join(logsDir, logFileName) : null

    const dirReady = fileLoggingEnabled
      ? mkdir(logsDir, { recursive: true }).catch(() => {})
      : Promise.resolve()

    async function writeLine(entry) {
      if (!fileLoggingEnabled) return
      try {
        await dirReady
        await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8')
      } catch (e) {
        console.error(`[telemetry] File write failed: ${e.code || e.message}`)
      }
    }

    // ── Deployment identifiers ──────────────────────────────────
    const INSTANCE_ID = process.env.OPENCLAW_INSTANCE_ID || undefined
    const HOSTNAME = process.env.VPS_HOSTNAME || undefined

    // ── Events output (/events endpoint) ────────────────────────
    const eventsWanted = eventsCfg.enabled === true || eventsCfg.enabled === 'true'
    const eventsUrl = eventsCfg.url || undefined
    const eventsToken = eventsCfg.authToken || undefined
    let eventSender = null

    if (eventsWanted) {
      if (!eventsUrl || !eventsToken) {
        api.logger.error(
          '[telemetry] events.enabled is true but events.url or events.authToken is missing. ' +
            'Event shipping to D1 will NOT be active.'
        )
      } else {
        eventSender = makeEventSender(eventsUrl, eventsToken, INSTANCE_ID, HOSTNAME)
        eventSender.configure({
          batchSize: eventsCfg.batchSize || 50,
          flushIntervalMs: eventsCfg.flushIntervalMs || 10000,
        })
        api.logger.info(`[telemetry] Event shipping enabled → ${eventsUrl}`)
      }
    }

    // ── Llemtry output (/llemtry endpoint) ──────────────────────
    const llemtryWanted = llemtryCfg.enabled === true || llemtryCfg.enabled === 'true'
    const llemtryUrl = llemtryCfg.url || undefined
    const llemtryToken = llemtryCfg.authToken || undefined
    let llemtryEnabled = false
    let sendSpan = null

    if (llemtryWanted) {
      if (!llemtryUrl || !llemtryToken) {
        api.logger.error(
          '[telemetry] llemtry.enabled is true but url or authToken is missing. ' +
            'LLM telemetry will NOT be sent.'
        )
      } else {
        api.logger.info(`[telemetry] LLM telemetry enabled → ${llemtryUrl}`)
        llemtryEnabled = true
        sendSpan = makeSendSpan(llemtryUrl, llemtryToken, INSTANCE_ID, HOSTNAME)
      }
    }

    // In-memory buffer: runId → pending input event (for llemtry span assembly)
    const pendingInputs = new Map()

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

    // ── Shared emit function ────────────────────────────────────
    // All event handlers call this to write to file and enqueue for /events
    function emit(type, category, event, ctx, data) {
      const level = granularity[category]
      if (level === 'off') return

      const processed = applyGranularity(data, level)

      const entry = {
        type,
        category,
        timestamp: new Date().toISOString(),
        agentId: ctx?.agentId ?? undefined,
        sessionId: event?.sessionId ?? ctx?.sessionId ?? undefined,
        sessionKey: ctx?.sessionKey ?? undefined,
        data: processed,
      }

      // Write to local file
      writeLine(entry)

      // Ship to /events
      if (eventSender) {
        eventSender.enqueue(entry)
      }
    }

    // ── Context helpers ─────────────────────────────────────────
    function contextFields(event, ctx) {
      return {
        agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey,
        runId: event?.runId ?? ctx?.runId,
        sessionId: event?.sessionId ?? ctx?.sessionId,
      }
    }

    // ── LLM hooks ───────────────────────────────────────────────

    api.on('llm_input', async (event, ctx) => {
      const data = {
        ...contextFields(event, ctx),
        provider: event.provider,
        model: event.model,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages ?? event.messages ?? event.history,
        imagesCount: event.imagesCount,
        temperature: event.temperature,
        maxTokens: event.maxTokens,
      }

      // Count tools if provided
      if (event.tools !== undefined) {
        data.toolCount = Array.isArray(event.tools) ? event.tools.length : undefined
        data.toolNames = Array.isArray(event.tools)
          ? event.tools.map((t) => t.name || t.function?.name).filter(Boolean)
          : undefined
      }

      emit('llm_input', 'llm', event, ctx, data)

      // Buffer for llemtry span assembly
      if (llemtryEnabled) {
        const runId = event.runId ?? ctx.runId
        if (runId) {
          pendingInputs.set(runId, { timestamp: Date.now(), event, ctx })
        }
      }
    })

    api.on('llm_output', async (event, ctx) => {
      const response = event.lastAssistant ?? event.response

      const data = {
        ...contextFields(event, ctx),
        provider: event.provider,
        model: event.model,
        response,
        inputTokens: event.usage?.input ?? event.inputTokens ?? 0,
        outputTokens: event.usage?.output ?? event.outputTokens ?? 0,
        cacheReadTokens: event.usage?.cacheRead ?? event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.usage?.cacheWrite ?? event.cacheWriteTokens ?? 0,
        totalTokens: event.usage?.total ?? event.totalTokens,
        stopReason: event.stopReason ?? response?.stopReason ?? response?.stop_reason,
        durationMs: event.durationMs,
      }

      // Extract tool calls from response
      if (event.toolCalls !== undefined) {
        data.toolCalls = Array.isArray(event.toolCalls)
          ? event.toolCalls.map((tc) => ({ name: tc.name || tc.function?.name, id: tc.id }))
          : event.toolCalls
      } else if (response?.content && Array.isArray(response.content)) {
        const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
        if (toolUseBlocks.length > 0) {
          data.toolCalls = toolUseBlocks.map((b) => ({ name: b.name, id: b.id }))
        }
      }

      emit('llm_output', 'llm', event, ctx, data)

      // Assemble llemtry span and send
      if (llemtryEnabled) {
        const runId = event.runId ?? ctx.runId
        const input = runId ? pendingInputs.get(runId) : undefined
        if (runId) pendingInputs.delete(runId)

        const span = buildLlemtrySpan(input, event, ctx)
        sendSpan(span).catch((err) =>
          console.error(`[telemetry] llemtry send failed: ${err.message}`)
        )
      }
    })

    // ── Session hooks ───────────────────────────────────────────

    api.on('session_start', async (event, ctx) => {
      emit('session_start', 'session', event, ctx, {
        ...contextFields(event, ctx),
        resumedFrom: event.resumedFrom,
      })
    })

    api.on('session_end', async (event, ctx) => {
      emit('session_end', 'session', event, ctx, {
        ...contextFields(event, ctx),
        messageCount: event.messageCount,
        durationMs: event.durationMs,
      })
    })

    api.on('before_compaction', async (event, ctx) => {
      emit('before_compaction', 'session', event, ctx, {
        ...contextFields(event, ctx),
        messageCount: event.messageCount,
        tokenCount: event.tokenCount,
      })
    })

    api.on('after_compaction', async (event, ctx) => {
      emit('after_compaction', 'session', event, ctx, {
        ...contextFields(event, ctx),
        compactedCount: event.compactedCount,
        tokenCount: event.tokenCount,
      })
    })

    // ── Agent hooks ─────────────────────────────────────────────

    api.on('before_agent_start', async (event, ctx) => {
      emit('before_agent_start', 'agent', event, ctx, {
        ...contextFields(event, ctx),
        prompt: event.prompt,
      })
    })

    api.on('agent_end', async (event, ctx) => {
      emit('agent_end', 'agent', event, ctx, {
        ...contextFields(event, ctx),
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
      })
    })

    // ── Tool hooks ──────────────────────────────────────────────

    api.on('before_tool_call', async (event, ctx) => {
      emit('before_tool_call', 'tool', event, ctx, {
        ...contextFields(event, ctx),
        toolName: event.toolName,
        params: event.params,
      })
    })

    api.on('after_tool_call', async (event, ctx) => {
      emit('after_tool_call', 'tool', event, ctx, {
        ...contextFields(event, ctx),
        toolName: event.toolName,
        result: event.result,
        error: event.error,
        durationMs: event.durationMs,
      })
    })

    // ── Message hooks ───────────────────────────────────────────

    api.on('message_received', async (event, ctx) => {
      emit('message_received', 'message', event, ctx, {
        ...contextFields(event, ctx),
        from: event.from,
        content: event.content,
        channelId: event.channelId,
      })
    })

    api.on('message_sent', async (event, ctx) => {
      emit('message_sent', 'message', event, ctx, {
        ...contextFields(event, ctx),
        to: event.to,
        content: event.content,
        success: event.success,
        error: event.error,
      })
    })

    // ── Gateway hooks ───────────────────────────────────────────

    api.on('gateway_start', async (event, ctx) => {
      emit('gateway_start', 'gateway', event, ctx, {
        port: event.port,
      })
    })

    api.on('gateway_stop', async (event, ctx) => {
      emit('gateway_stop', 'gateway', event, ctx, {
        reason: event.reason,
      })
      // Flush any buffered events before the gateway process exits
      if (eventSender) {
        await eventSender.shutdown()
      }
    })

    // ── Registration log ────────────────────────────────────────
    const outputs = []
    if (fileLoggingEnabled) outputs.push(`file:${logFileName}`)
    if (eventSender) outputs.push('events:/events')
    if (llemtryEnabled) outputs.push('llemtry')
    api.logger.info(`[telemetry] Plugin registered — outputs: [${outputs.join(', ')}]`)
  },
}
