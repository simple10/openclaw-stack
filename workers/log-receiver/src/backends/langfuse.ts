import type { LlemtrySpan, LlemtryBatch } from '../llemtry'

const MAX_PAYLOAD_BYTES = 3.5 * 1024 * 1024

/**
 * Map short model aliases to full versioned names for Langfuse cost matching.
 * Langfuse's default-model-prices.json uses regex patterns that require
 * the full versioned name (e.g. claude-sonnet-4-5-20250929).
 * OpenClaw often sends the short alias (e.g. claude-sonnet-4-5).
 * Models without a date suffix (e.g. claude-opus-4-6) match as-is and don't need an entry.
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
}

function resolveModelName(model: string): string {
  return MODEL_ALIAS_MAP[model] ?? model
}

/**
 * Convert llemtry spans to Langfuse batch ingestion format and POST to the API.
 * Best-effort — logs errors but never throws.
 */
export async function sendToLangfuse(
  spans: LlemtrySpan[],
  resource: LlemtryBatch['resource'],
  env: Env,
  log: (...args: unknown[]) => void
): Promise<void> {
  if (spans.length === 0) return

  if (!env.LANGFUSE_BASE_URL) {
    log('[langfuse] LANGFUSE_BASE_URL is not set — aborting. Set this to your Langfuse instance URL (e.g. https://cloud.langfuse.com).')
    return
  }
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    log('[langfuse] LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing — aborting.')
    return
  }

  try {
    const batch: Array<Record<string, unknown>> = []

    for (const span of spans) {
      const sessionId = span.traceId
      const agentId = span.attributes['openclaw.agent.id']
      const rawModel = span.attributes['gen_ai.request.model'] ?? 'unknown'
      const model = resolveModelName(rawModel)
      const traceId = `${sessionId}-${span.spanId}`
      const generationId = span.spanId

      const startTime = nanoToISO(span.startTimeUnixNano)
      const endTime = nanoToISO(span.endTimeUnixNano)

      // Metadata shared by trace and generation
      const sharedMeta: Record<string, unknown> = {}
      if (resource.instanceId) sharedMeta.instanceId = resource.instanceId
      if (resource.hostname) sharedMeta.hostname = resource.hostname

      // Input/output from events (needed by both trace and generation)
      let input: unknown
      let output: unknown
      if (span.events) {
        const promptEvent = span.events.find((e) => e.name === 'gen_ai.content.prompt')
        const completionEvent = span.events.find((e) => e.name === 'gen_ai.content.completion')
        if (promptEvent) input = promptEvent.body
        if (completionEvent) output = completionEvent.body
      }

      // Trace — groups under Langfuse session
      batch.push({
        id: crypto.randomUUID(),
        type: 'trace-create',
        timestamp: startTime,
        body: {
          id: traceId,
          sessionId,
          name: agentId ? `agent-${agentId}` : 'openclaw-generation',
          input,
          output,
          metadata: {
            ...sharedMeta,
            agentId,
            runId: span.spanId,
            sessionKey: span.attributes['openclaw.session.key'],
          },
        },
      })

      // Usage
      const usage: Record<string, unknown> = { unit: 'TOKENS' }
      const inputTokens = span.attributes['gen_ai.usage.input_tokens']
      const outputTokens = span.attributes['gen_ai.usage.output_tokens']
      if (inputTokens != null) usage.input = inputTokens
      if (outputTokens != null) usage.output = outputTokens
      if (inputTokens != null && outputTokens != null) usage.total = inputTokens + outputTokens

      // Generation metadata — all openclaw.* attributes
      const genMeta: Record<string, unknown> = { ...sharedMeta }
      for (const [key, value] of Object.entries(span.attributes)) {
        if (key.startsWith('openclaw.') && value !== undefined) {
          genMeta[key] = value
        }
      }

      // Cache tokens
      const cacheRead = span.attributes['openclaw.usage.cache_read_tokens']
      const cacheWrite = span.attributes['openclaw.usage.cache_write_tokens']
      if (cacheRead != null) genMeta.cacheReadInputTokens = cacheRead
      if (cacheWrite != null) genMeta.cacheCreationInputTokens = cacheWrite

      // Model parameters
      const modelParams: Record<string, string> = {}
      const maxTokens = span.attributes['gen_ai.request.max_tokens']
      const temperature = span.attributes['gen_ai.request.temperature']
      if (maxTokens != null) modelParams.max_tokens = String(maxTokens)
      if (temperature != null) modelParams.temperature = String(temperature)

      // Generation
      batch.push({
        id: crypto.randomUUID(),
        type: 'generation-create',
        timestamp: startTime,
        body: {
          traceId,
          id: generationId,
          name: model,
          model,
          input,
          output,
          startTime,
          endTime,
          usage,
          metadata: genMeta,
          statusMessage: span.status.code,
          ...(Object.keys(modelParams).length > 0 && { modelParameters: modelParams }),
        },
      })
    }

    const payload = JSON.stringify({ batch })

    if (payload.length > MAX_PAYLOAD_BYTES) {
      log(`[langfuse] Batch exceeds 3.5 MB (${(payload.length / 1024 / 1024).toFixed(1)} MB), skipping`)
      return
    }

    const baseUrl = env.LANGFUSE_BASE_URL
    const basicAuth = btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)

    const res = await fetch(`${baseUrl}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: payload,
    })

    if (!res.ok) {
      const body = await res.text()
      log(`[langfuse] Ingestion failed: ${res.status} ${body.slice(0, 500)}`)
    }
  } catch (err) {
    log('[langfuse] Unexpected error:', err)
  }
}

/** Convert epoch nanoseconds string to ISO 8601 timestamp. */
function nanoToISO(nanoStr: string): string {
  const ms = Math.floor(Number(nanoStr) / 1_000_000)
  return new Date(ms).toISOString()
}
