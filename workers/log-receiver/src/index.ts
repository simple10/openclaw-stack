import { validateAuth } from './auth'
import { handlePreflight, addCorsHeaders } from './cors'
import { jsonError } from './errors'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handlePreflight()
    }

    const { pathname } = new URL(request.url)

    // Health check — no auth required
    if (request.method === 'GET' && pathname === '/health') {
      return addCorsHeaders(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }

    // POST /logs — receive log events from Vector
    if (request.method === 'POST' && pathname === '/logs') {
      const authError = await validateAuth(request, env.AUTH_TOKEN)
      if (authError) {
        return addCorsHeaders(jsonError(authError, 401))
      }

      return addCorsHeaders(await handleLogs(request, env))
    }

    return addCorsHeaders(jsonError('Not found', 404))
  },
} satisfies ExportedHandler<Env>

// Fields to strip from logged entries to save console output space
const PRUNED_FIELDS = ['container_id', 'source_type', 'label', 'image']

// Max console output bytes (half of Cloudflare's 256KB limit, leaving headroom
// for request metadata, headers, and the summary line)
const BYTE_BUDGET = 128 * 1024

// Default levels if LOGGABLE_LEVELS env var is missing or empty
const DEFAULT_LOGGABLE_LEVELS = 'warn,error,fatal,panic'

const LEVEL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:panic|fatal)\b/i, 'error'],
  [/\berr(?:or)?\b/i, 'error'],
  [/\bwarn(?:ing)?\b/i, 'warn'],
  [/\bdebug\b/i, 'debug'],
  [/\btrace\b/i, 'debug'],
]

/** Map detected level to the appropriate console method. */
function consoleForLevel(level: string): (...args: unknown[]) => void {
  switch (level) {
    case 'error':
    case 'fatal':
    case 'panic':
      return console.error
    case 'warn':
      return console.warn
    case 'debug':
    case 'trace':
      return console.debug
    default:
      return console.log
  }
}

/**
 * Detect log level from an entry.
 *
 * Priority: explicit `.level` field (set by Vector's tag_level transform)
 * → keyword scan of `.message` → stderr promoted to "warn" → default "info".
 */
function detectLevel(entry: Record<string, unknown>): string {
  // Vector's tag_level transform sets this field
  if (typeof entry.level === 'string' && entry.level) {
    return entry.level
  }

  // Fallback: scan message text for level keywords
  const msg = typeof entry.message === 'string' ? entry.message : ''
  for (const [pattern, level] of LEVEL_PATTERNS) {
    if (pattern.test(msg)) return level
  }

  // stderr without a keyword match → promote to warn
  if (entry.stream === 'stderr') return 'warn'

  return 'info'
}

/**
 * Handle incoming log events from Vector.
 *
 * Vector's HTTP sink sends batches as a JSON array (default framing) or
 * newline-delimited JSON. Each event has fields like container_name, message, stream, timestamp.
 *
 * Only warn/error entries are logged to console — Cloudflare captures Worker
 * console output via real-time Logs dashboard and Logpush. A summary line is
 * always emitted with counts so filtered entries remain visible in aggregate.
 */
async function handleLogs(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  if (!body.trim()) {
    return jsonError('Empty request body', 400)
  }

  // Vector's HTTP sink sends batches as a JSON array or newline-delimited JSON
  let entries: Array<Record<string, unknown>>
  try {
    const trimmed = body.trim()
    if (trimmed.startsWith('[')) {
      entries = JSON.parse(trimmed) as Array<Record<string, unknown>>
    } else {
      entries = trimmed
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    }
  } catch {
    console.error(`Failed to parse batch: ${body.slice(0, 200)}`)
    return jsonError('Invalid JSON batch', 400)
  }

  const loggableLevels = new Set(
    (env.LOGGABLE_LEVELS || DEFAULT_LOGGABLE_LEVELS).split(',').map((s) => s.trim())
  )

  let total = 0
  let logged = 0
  let filtered = 0
  let droppedByBudget = 0
  let bytesUsed = 0
  const levels: Record<string, number> = {}

  for (const entry of entries) {
    total++

    const level = detectLevel(entry)
    levels[level] = (levels[level] ?? 0) + 1

    if (!loggableLevels.has(level)) {
      filtered++
      continue
    }

    // Strip bulky fields to save console space
    for (const field of PRUNED_FIELDS) {
      delete entry[field]
    }

    // Hoist inner JSON message — OpenClaw emits JSON-formatted log lines, so
    // entry.message may be '{"message":"actual text",...}'. Extracting .message
    // gives the Cloudflare dashboard a clean primary text to display.
    if (
      typeof entry.message === 'string' &&
      entry.message.startsWith('{') &&
      entry.message.includes('"message":')
    ) {
      try {
        const inner = JSON.parse(entry.message) as Record<string, unknown>
        if (typeof inner.message === 'string') {
          entry.message = inner.message
        }
      } catch {
        // Not valid JSON — keep original message
      }
    }

    // Estimate size for byte budget, but pass the object to console so
    // Cloudflare Workers Logs extracts fields (especially `message`) natively.
    const estimatedSize = JSON.stringify(entry).length
    if (bytesUsed + estimatedSize > BYTE_BUDGET) {
      droppedByBudget++
      continue
    }

    consoleForLevel(level)(entry)
    bytesUsed += estimatedSize
    logged++
  }

  // Always emit a summary so filtered counts are visible in Cloudflare dashboard.
  // Pass as object so Workers Logs extracts fields (including `message`) automatically.
  const levelParts = Object.entries(levels)
    .map(([l, n]) => `${l}=${n}`)
    .join(' ')
  console.debug({
    _summary: true,
    message: `[BATCH] logged:${logged} filtered:${filtered} total:${total} > ${levelParts}`,
    total,
    logged,
    filtered,
    droppedByBudget,
    levels,
  })

  return new Response(JSON.stringify({ status: 'ok', count: total }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
