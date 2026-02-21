/**
 * Debug Logger Hook — logs all gateway events to ~/.openclaw/logs/debug.log
 *
 * Captures command, agent, and gateway events in JSONL format for debugging
 * and audit purposes. Unlike command-logger (command events only), this hook
 * captures everything.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Strips context.cfg from log messages when true - cfg is openclaw.json config */
const STRIP_CONTEXT_CFG = true

/**
 * Resolve state directory (inlined to avoid coupling to compiled gateway paths).
 */
function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw')
}

const SENSITIVE_KEYS = new Set([
  'token',
  'secret',
  'password',
  'apiKey',
  'api_key',
  'authorization',
])

/**
 * Serialize context values safely — redact secrets, cap depth, truncate strings.
 */
function safeContext(ctx, depth = 0) {
  if (!ctx || typeof ctx !== 'object') return ctx
  if (depth > 3) return '[depth-limited]'
  if (Array.isArray(ctx)) return ctx.map((v) => safeContext(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'function') continue
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = '[redacted]'
    } else if (typeof v === 'string' && v.length > 512) {
      out[k] = v.slice(0, 512) + '...(truncated)'
    } else if (typeof v === 'object' && v !== null) {
      out[k] = safeContext(v, depth + 1)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Log all events to debug.log
 */
const debugLogger = async (event) => {
  try {
    const logDir = path.join(stateDir(), 'logs')
    await fs.mkdir(logDir, { recursive: true })

    const logFile = path.join(logDir, 'debug.log')
    const logData = {
      ...event, // type, action, sessionKey, context, timestamp, messages
      timestamp: event.timestamp.toISOString(),
      context: safeContext(event.context),
    }

    if (STRIP_CONTEXT_CFG && logData.context?.cfg) {
      delete logData.context.cfg
    }

    const logLine = await fs.appendFile(logFile, JSON.stringify(logData) + '\n', 'utf-8')
  } catch (err) {
    console.error(
      '[debug-logger] Failed to log event:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

export default debugLogger
