import { jsonError } from './errors'

// ---------------------------------------------------------------------------
// Types — telemetry events from the unified telemetry plugin
// ---------------------------------------------------------------------------

interface EventBatch {
  instance: {
    id?: string
    hostname?: string
  }
  events: TelemetryEvent[]
}

interface TelemetryEvent {
  type: string
  category: string
  timestamp: string
  agentId?: string
  sessionId?: string
  sessionKey?: string
  data?: Record<string, unknown>
}

const VALID_CATEGORIES = new Set(['llm', 'session', 'tool', 'message', 'agent', 'gateway'])

// Max events per batch (prevents abuse)
const MAX_BATCH_SIZE = 200

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text()
  if (!body.trim()) {
    return jsonError('Empty request body', 400)
  }

  let batch: EventBatch
  try {
    batch = JSON.parse(body)
  } catch {
    return jsonError('Invalid JSON', 400)
  }

  if (!batch.instance || !Array.isArray(batch.events)) {
    return jsonError('Invalid event batch: missing instance or events', 400)
  }

  if (batch.events.length === 0) {
    return new Response(JSON.stringify({ status: 'ok', count: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (batch.events.length > MAX_BATCH_SIZE) {
    return jsonError(`Batch too large: ${batch.events.length} events (max ${MAX_BATCH_SIZE})`, 400)
  }

  // Validate events and build D1 statements upfront (synchronous — fast)
  const instanceId = batch.instance.id || null
  let validationErrors = 0
  const stmts: D1PreparedStatement[] = []

  for (const event of batch.events) {
    if (!event.type || !event.category || !event.timestamp) {
      validationErrors++
      continue
    }
    if (!VALID_CATEGORIES.has(event.category)) {
      validationErrors++
      continue
    }

    const data = event.data || {}

    // Extract common numeric fields from data
    const durationMs = toIntOrNull(data.durationMs)
    const inputTokens = toIntOrNull(data.inputTokens ?? data.input_tokens)
    const outputTokens = toIntOrNull(data.outputTokens ?? data.output_tokens)
    const cacheReadTokens = toIntOrNull(data.cacheReadTokens ?? data.cache_read_tokens)
    const cacheWriteTokens = toIntOrNull(data.cacheWriteTokens ?? data.cache_write_tokens)
    const totalTokens = toIntOrNull(data.totalTokens ?? data.total_tokens)
    const costTotal = toFloatOrNull(data.costTotal ?? data.cost_total)

    // Split data into meta (small structured) and content (large text)
    const { meta, content } = splitData(data, event.type)

    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (
          type, category, timestamp, agent_id, session_id, session_key, instance_id,
          duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_total, meta, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        event.type,
        event.category,
        event.timestamp,
        event.agentId || null,
        event.sessionId || null,
        event.sessionKey || null,
        instanceId,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        costTotal,
        meta ? JSON.stringify(meta) : null,
        content ? JSON.stringify(content) : null
      )
    )
  }

  // D1 insert runs after response is sent (non-blocking, like llmetry handler)
  const total = batch.events.length
  if (stmts.length > 0) {
    ctx.waitUntil(
      (async () => {
        try {
          const results = await env.DB.batch(stmts)
          const inserted = results.filter((r: D1Result) => r.success).length
          const insertErrors = results.filter((r: D1Result) => !r.success).length

          // Log summary for CF Workers Logs dashboard
          const categories: Record<string, number> = {}
          for (const event of batch.events) {
            if (event.category) {
              categories[event.category] = (categories[event.category] ?? 0) + 1
            }
          }
          const catParts = Object.entries(categories)
            .map(([c, n]) => `${c}=${n}`)
            .join(' ')

          console.log({
            _events: true,
            message: `[EVENTS] inserted:${inserted} errors:${
              validationErrors + insertErrors
            } total:${total} | ${catParts}`,
            inserted,
            errors: validationErrors + insertErrors,
            total,
            categories,
            instance: instanceId,
          })
        } catch (err) {
          console.error(
            '[events] D1 batch insert failed:',
            err instanceof Error ? err.message : err
          )
        }
      })()
    )
  }

  return new Response(
    JSON.stringify({ status: 'ok', accepted: stmts.length, errors: validationErrors }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIntOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

function toFloatOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Fields that go into the meta column (small structured data)
const META_FIELDS = new Set([
  'model',
  'provider',
  'toolName',
  'toolCount',
  'toolNames',
  'error',
  'stopReason',
  'success',
  'reason',
  'from',
  'to',
  'channelId',
  'messageCount',
  'tokenCount',
  'compactedCount',
  'resumedFrom',
  'port',
  'imagesCount',
])

// Fields that are already extracted as top-level D1 columns or as top-level
// entry fields (agentId, sessionId, etc.) — exclude from meta/content
const EXTRACTED_FIELDS = new Set([
  'agentId',
  'sessionId',
  'sessionKey',
  'runId',
  'durationMs',
  'duration_ms',
  'inputTokens',
  'input_tokens',
  'outputTokens',
  'output_tokens',
  'cacheReadTokens',
  'cache_read_tokens',
  'cacheWriteTokens',
  'cache_write_tokens',
  'totalTokens',
  'total_tokens',
  'costTotal',
  'cost_total',
])

/**
 * Split event data into meta (small fields for indexing) and content (large text fields).
 * Fields already extracted as top-level columns are excluded from both.
 */
function splitData(
  data: Record<string, unknown>,
  _type: string
): { meta: Record<string, unknown> | null; content: Record<string, unknown> | null } {
  const meta: Record<string, unknown> = {}
  const content: Record<string, unknown> = {}
  let hasMeta = false
  let hasContent = false

  for (const [key, value] of Object.entries(data)) {
    if (EXTRACTED_FIELDS.has(key)) continue

    if (META_FIELDS.has(key)) {
      meta[key] = value
      hasMeta = true
    } else {
      content[key] = value
      hasContent = true
    }
  }

  return {
    meta: hasMeta ? meta : null,
    content: hasContent ? content : null,
  }
}
