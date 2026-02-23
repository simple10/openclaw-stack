import type { RouteMatch } from './types'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

export interface Log {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** Headers whose values are fully redacted. */
const REDACT_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cf-aig-authorization',
  'cookie',
  'set-cookie',
])

/** Headers whose values are truncated to a prefix + "…". */
const MASK_HEADERS = new Set(['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'])

/**
 * Return a plain object of header entries with sensitive values redacted.
 * - Fully redacted headers show the value length: `[REDACTED (42 chars)]`
 * - Masked headers show the first 6 chars: `1.2.3.…`
 */
export function sanitizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of headers) {
    const lower = key.toLowerCase()
    if (REDACT_HEADERS.has(lower)) {
      out[key] = `[REDACTED (${value.length} chars)]`
    } else if (MASK_HEADERS.has(lower)) {
      out[key] = value.length > 6 ? value.slice(0, 6) + '…' : value
    } else {
      out[key] = value
    }
  }
  return out
}

const MAX_LOG_BODY = 8192

/** Truncate a string for safe logging within Cloudflare's 256 KB log limit. */
export function truncateBody(body: string, max = MAX_LOG_BODY): string {
  if (body.length <= max) return body
  return body.slice(0, max) + `… [truncated, ${body.length} chars total]`
}

export function logInboundRequest(log: Log, request: Request, route: RouteMatch, apiKey: string) {
  const headers = new Headers()
  // Merge request headers, skipping auth and cf-* headers
  for (const [key, value] of request.headers) {
    headers.set(key, value)
  }
  log.debug(`[${route.provider}] inbound request headers`, sanitizeHeaders(headers))
}

export function createLog(env: Env): Log {
  const threshold = LEVELS[(env.LOG_LEVEL ?? 'info') as Level] ?? LEVELS.info

  return {
    debug: (...args) => {
      if (threshold <= LEVELS.debug) console.debug(...args)
    },
    info: (...args) => {
      if (threshold <= LEVELS.info) console.info(...args)
    },
    warn: (...args) => {
      if (threshold <= LEVELS.warn) console.warn(...args)
    },
    error: (...args) => {
      if (threshold <= LEVELS.error) console.error(...args)
    },
  }
}
