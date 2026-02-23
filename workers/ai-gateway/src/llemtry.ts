import type { Log, Provider } from './types'

const MAX_OUTPUT_BYTES = 100 * 1024 // 100KB

/** Returns true when llemtry is explicitly enabled and endpoint/token are configured. */
export function isLlemtryEnabled(env: Env, log: Log): boolean {
  if (env.LLEMTRY_ENABLED !== 'true') return false
  if (!env.LLEMTRY_ENDPOINT || !env.LLEMTRY_AUTH_TOKEN) {
    log.error('[llemtry] LLEMTRY_ENABLED is true but LLEMTRY_ENDPOINT and/or LLEMTRY_AUTH_TOKEN are missing')
    return false
  }
  return true
}

/** Returns true for LLM generation routes (excludes embeddings, models, etc). */
export function isLlmRoute(directPath: string): boolean {
  return directPath === 'v1/messages' || directPath === 'v1/chat/completions'
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

interface ParsedRequest {
  model?: string
  messages?: unknown
  stream?: boolean
  max_tokens?: number
  temperature?: number
  system?: unknown
  top_p?: number
}

function parseRequestBody(body: string): ParsedRequest {
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface UsageInfo {
  input?: number
  output?: number
  total?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

interface ParsedResponse {
  output?: string
  usage?: UsageInfo
  model?: string
  metadata: Record<string, unknown>
}

/** Parse a non-streaming JSON response body. */
function parseJsonResponse(text: string): ParsedResponse {
  const metadata: Record<string, unknown> = {}
  try {
    const json = JSON.parse(text)
    let output: string | undefined

    // Anthropic format
    if (json.content && Array.isArray(json.content)) {
      output = json.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
    }
    // OpenAI format
    else if (json.choices?.[0]?.message?.content) {
      output = json.choices[0].message.content
    }

    if (output && output.length > MAX_OUTPUT_BYTES) {
      output = output.slice(0, MAX_OUTPUT_BYTES)
      metadata.output_truncated = true
    }

    let usage: UsageInfo | undefined
    if (json.usage) {
      usage = {
        input: json.usage.input_tokens ?? json.usage.prompt_tokens,
        output: json.usage.output_tokens ?? json.usage.completion_tokens,
        total:
          json.usage.input_tokens != null
            ? json.usage.input_tokens + (json.usage.output_tokens ?? 0)
            : json.usage.total_tokens,
        cacheCreationInputTokens: json.usage.cache_creation_input_tokens,
        cacheReadInputTokens: json.usage.cache_read_input_tokens,
      }
    }

    return { output, usage, model: json.model, metadata }
  } catch {
    return { metadata }
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface SSEEvent {
  event?: string
  data: string
}

/** Async generator that yields SSE events from a ReadableStream. */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined
  let currentData: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop()!

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          currentData.push(line.slice(6))
        } else if (line.trim() === '') {
          // Empty line = end of event
          if (currentData.length > 0) {
            yield { event: currentEvent, data: currentData.join('\n') }
            currentEvent = undefined
            currentData = []
          }
        }
      }
    }
    // Flush remaining
    if (currentData.length > 0) {
      yield { event: currentEvent, data: currentData.join('\n') }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Parse Anthropic SSE stream for output text and usage. */
async function parseAnthropicStream(stream: ReadableStream<Uint8Array>): Promise<ParsedResponse> {
  const metadata: Record<string, unknown> = {}
  let output = ''
  let truncated = false
  let usage: UsageInfo | undefined
  let model: string | undefined

  try {
    for await (const { data } of parseSSE(stream)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      switch (parsed.type) {
        case 'message_start': {
          const msg = parsed.message
          model = msg?.model
          if (msg?.usage) {
            usage = {
              input: msg.usage.input_tokens,
              output: 0,
              total: msg.usage.input_tokens,
              cacheCreationInputTokens: msg.usage.cache_creation_input_tokens,
              cacheReadInputTokens: msg.usage.cache_read_input_tokens,
            }
          }
          break
        }
        case 'content_block_delta': {
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text && !truncated) {
            output += parsed.delta.text
            if (output.length > MAX_OUTPUT_BYTES) {
              output = output.slice(0, MAX_OUTPUT_BYTES)
              truncated = true
              metadata.output_truncated = true
            }
          }
          break
        }
        case 'message_delta': {
          if (parsed.usage?.output_tokens != null && usage) {
            usage.output = parsed.usage.output_tokens
            usage.total = (usage.input ?? 0) + parsed.usage.output_tokens
          }
          break
        }
      }
    }
  } catch {
    metadata.output_partial = true
  }

  return { output: output || undefined, usage, model, metadata }
}

/** Parse OpenAI SSE stream for output text and usage. */
async function parseOpenAIStream(stream: ReadableStream<Uint8Array>): Promise<ParsedResponse> {
  const metadata: Record<string, unknown> = {}
  let output = ''
  let truncated = false
  let usage: UsageInfo | undefined
  let model: string | undefined

  try {
    for await (const { data } of parseSSE(stream)) {
      if (data === '[DONE]') break

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }

      if (!model && parsed.model) model = parsed.model

      const content = parsed.choices?.[0]?.delta?.content
      if (content && !truncated) {
        output += content
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(0, MAX_OUTPUT_BYTES)
          truncated = true
          metadata.output_truncated = true
        }
      }

      // Usage (only present if stream_options.include_usage was set)
      if (parsed.usage) {
        usage = {
          input: parsed.usage.prompt_tokens,
          output: parsed.usage.completion_tokens,
          total: parsed.usage.total_tokens,
        }
      }
    }
  } catch {
    metadata.output_partial = true
  }

  return { output: output || undefined, usage, model, metadata }
}

// ---------------------------------------------------------------------------
// Llemtry reporting
// ---------------------------------------------------------------------------

export interface ReportOptions {
  provider: Provider
  requestBody: string
  responseStream: ReadableStream<Uint8Array>
  responseHeaders: Headers
  statusCode: number
  startTime: Date
}

/** Convert a Date to epoch nanoseconds as a string. */
function toNanoString(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString()
}

/** Parse the response stream and report to log worker via llemtry. Best-effort, never throws. */
export async function reportGeneration(env: Env, log: Log, opts: ReportOptions): Promise<void> {
  try {
    const req = parseRequestBody(opts.requestBody)

    // Determine streaming from response Content-Type
    const contentType = opts.responseHeaders.get('content-type') ?? ''
    const isStreaming = contentType.includes('text/event-stream')

    let parsed: ParsedResponse
    if (isStreaming) {
      parsed =
        opts.provider === 'anthropic'
          ? await parseAnthropicStream(opts.responseStream)
          : await parseOpenAIStream(opts.responseStream)
    } else {
      const text = await streamToText(opts.responseStream)
      parsed = parseJsonResponse(text)
    }

    const endTime = new Date()
    const model = parsed.model ?? req.model ?? 'unknown'
    const spanId = crypto.randomUUID()

    // Build input — include system prompt for Anthropic if present
    const input: Record<string, unknown> = { messages: req.messages }
    if (req.system) input.system = req.system

    // Build llemtry batch
    const batch = {
      resource: {
        serviceName: 'openclaw-ai-gateway',
      },
      spans: [
        {
          traceId: crypto.randomUUID(),
          spanId,
          name: 'gen_ai.generate',
          kind: 'client' as const,
          startTimeUnixNano: toNanoString(opts.startTime),
          endTimeUnixNano: toNanoString(endTime),
          status: {
            code: (opts.statusCode >= 200 && opts.statusCode < 300 ? 'OK' : 'ERROR') as 'OK' | 'ERROR',
          },
          attributes: {
            'gen_ai.system': opts.provider,
            'gen_ai.request.model': model,
            ...(parsed.usage?.input != null && { 'gen_ai.usage.input_tokens': parsed.usage.input }),
            ...(parsed.usage?.output != null && { 'gen_ai.usage.output_tokens': parsed.usage.output }),
            ...(req.max_tokens != null && { 'gen_ai.request.max_tokens': req.max_tokens }),
            ...(req.temperature != null && { 'gen_ai.request.temperature': req.temperature }),
            'openclaw.session.id': 'ai-gateway',
            'openclaw.run.id': spanId,
            ...(parsed.usage?.cacheReadInputTokens != null && {
              'openclaw.usage.cache_read_tokens': parsed.usage.cacheReadInputTokens,
            }),
            ...(parsed.usage?.cacheCreationInputTokens != null && {
              'openclaw.usage.cache_write_tokens': parsed.usage.cacheCreationInputTokens,
            }),
          },
          events: [
            {
              name: 'gen_ai.content.prompt',
              timeUnixNano: toNanoString(opts.startTime),
              body: input,
            },
            {
              name: 'gen_ai.content.completion',
              timeUnixNano: toNanoString(endTime),
              body: parsed.output ?? '',
            },
          ],
        },
      ],
    }

    const payload = JSON.stringify(batch)

    const res = await fetch(env.LLEMTRY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLEMTRY_AUTH_TOKEN}`,
      },
      body: payload,
    })

    if (!res.ok) {
      const body = await res.text()
      log.error(`[llemtry] Ingestion failed: ${res.status} ${body}`)
    } else {
      log.debug(
        `[llemtry] Reported generation ${spanId} (model=${model}, tokens=${
          parsed.usage?.total ?? '?'
        })`
      )
    }
  } catch (err) {
    log.error('[llemtry] Unexpected error:', err)
  }
}

/** Read a ReadableStream to a string. */
async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}
