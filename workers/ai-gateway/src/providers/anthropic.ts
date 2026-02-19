import type { ProviderConfig, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/** Proxy the request to Anthropic (via AI Gateway or direct). */
export async function proxyAnthropic(
  apiKey: string,
  request: Request,
  config: ProviderConfig,
  path: string,
  log: Log,
  preReadBody?: string
): Promise<Response> {
  const url = `${config.baseUrl}/${path}`

  const headers = new Headers()

  // Set provider-config headers (e.g. cf-aig-authorization for gateway mode)
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      headers.set(key, value)
    }
  }

  // Merge request headers, skipping auth and cf-* headers
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key' || lower.startsWith('cf-')) continue
    if (!headers.has(key)) headers.set(key, value)
  }

  // Ensure anthropic-version is set
  if (!headers.has('anthropic-version')) {
    headers.set('anthropic-version', DEFAULT_ANTHROPIC_VERSION)
  }

  if (apiKey.startsWith('sk-ant-oat')) {
    // Using OAuth token
    headers.set('authorization', `Bearer ${apiKey}`)
    log.debug(`[anthropic] Using OAuth Token: ${apiKey.substring(0, 10)}...`)
  } else {
    // Using regular API key
    headers.set('x-api-key', apiKey)
    log.debug(`[anthropic] Using API key: ${apiKey.substring(0, 10)}...`)
  }

  const body = preReadBody ?? await request.text()

  log.debug(`[anthropic] url=${url}`)
  log.debug('[anthropic] upstream headers', sanitizeHeaders(headers))
  log.debug('[anthropic] request body', truncateBody(body))

  return fetch(url, {
    method: 'POST',
    headers,
    body,
  })
}
