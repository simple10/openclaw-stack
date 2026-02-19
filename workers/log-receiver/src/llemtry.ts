import { jsonError } from './errors'
import { sendToLangfuse } from './backends/langfuse'

// ---------------------------------------------------------------------------
// Types — OTEL-inspired, OpenClaw-specific LLM telemetry
// ---------------------------------------------------------------------------

export interface LlemtryBatch {
  resource: {
    serviceName: string
    instanceId?: string
    hostname?: string
    attributes?: Record<string, string | number | boolean>
  }
  spans: LlemtrySpan[]
}

export interface LlemtrySpan {
  traceId: string // sessionId — groups all LLM calls in a session
  spanId: string // runId — unique per LLM round-trip
  parentSpanId?: string
  name: string // "gen_ai.generate"
  kind: 'client'
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: 'OK' | 'ERROR'; message?: string }
  attributes: {
    'gen_ai.system'?: string
    'gen_ai.request.model'?: string
    'gen_ai.usage.input_tokens'?: number
    'gen_ai.usage.output_tokens'?: number
    'gen_ai.request.max_tokens'?: number
    'gen_ai.request.temperature'?: number
    'gen_ai.response.stop_reason'?: string
    'openclaw.agent.id'?: string
    'openclaw.session.id': string
    'openclaw.session.key'?: string
    'openclaw.run.id': string
    'openclaw.usage.cache_read_tokens'?: number
    'openclaw.usage.cache_write_tokens'?: number
    'openclaw.tool_calls'?: string
    'openclaw.images_count'?: number
    [key: string]: string | number | boolean | undefined
  }
  events?: Array<{
    name: string
    timeUnixNano: string
    body: unknown
  }>
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleLlemtry(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text()
  if (!body.trim()) {
    return jsonError('Empty request body', 400)
  }

  let batch: LlemtryBatch
  try {
    batch = JSON.parse(body)
  } catch {
    return jsonError('Invalid JSON', 400)
  }

  if (!batch.resource || !Array.isArray(batch.spans)) {
    return jsonError('Invalid llemtry batch: missing resource or spans', 400)
  }

  // Log summary (visible in CF Workers Logs dashboard)
  const spanCount = batch.spans.length
  if (spanCount > 0) {
    const models = [...new Set(batch.spans.map((s) => s.attributes['gen_ai.request.model']).filter(Boolean))]
    const agents = [...new Set(batch.spans.map((s) => s.attributes['openclaw.agent.id']).filter(Boolean))]
    const totalInput = batch.spans.reduce((sum, s) => sum + (s.attributes['gen_ai.usage.input_tokens'] ?? 0), 0)
    const totalOutput = batch.spans.reduce((sum, s) => sum + (s.attributes['gen_ai.usage.output_tokens'] ?? 0), 0)
    console.log({
      _llemtry: true,
      message: `[LLEMTRY] spans:${spanCount} models:[${models.join(',')}] agents:[${agents.join(',')}] tokens:${totalInput}in/${totalOutput}out`,
      spans: spanCount,
      models,
      agents,
      totalInput,
      totalOutput,
      instance: batch.resource.instanceId,
    })
  }

  // Dispatch to configured backends (non-blocking)
  const backends: Promise<void>[] = []

  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    backends.push(sendToLangfuse(batch.spans, batch.resource, env, console.error))
  }
  // Future:
  // if (env.POSTHOG_API_KEY) backends.push(sendToPostHog(...))
  // if (env.TRACELOOP_API_KEY) backends.push(sendToTraceloop(...))

  if (backends.length > 0) {
    ctx.waitUntil(Promise.allSettled(backends))
  }

  return new Response(JSON.stringify({ status: 'ok', count: spanCount }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
