import type { ProviderConfig, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

/** Proxy the request to a generic OpenAI-compatible provider. */
export async function proxyGeneric(
  apiKey: string,
  request: Request,
  config: ProviderConfig,
  path: string,
  log: Log,
  provider: string,
  preReadBody?: string
): Promise<Response> {
  const targetUrl = `${config.baseUrl}/${path}`

  const headers = new Headers(request.headers)

  // Replace gateway auth token with the real provider API key
  headers.set('Authorization', `Bearer ${apiKey}`)

  // Strip Cloudflare-injected metadata headers that shouldn't reach upstream providers
  for (const key of [...headers.keys()]) {
    if (key.startsWith('cf-')) headers.delete(key)
  }

  // Set provider-config headers (e.g. cf-aig-authorization for CF AI Gateway mode)
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      headers.set(key, value)
    }
  }

  const body = preReadBody ?? await request.text()
  log.debug(`[${provider}] url=${targetUrl}`)
  log.debug(`[${provider}] upstream headers`, sanitizeHeaders(headers))
  log.debug(`[${provider}] request body`, truncateBody(body))

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method !== 'GET' ? body : undefined,
  })
}
