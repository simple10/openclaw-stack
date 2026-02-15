import type { ProviderConfig, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

/** Proxy the request to OpenAI (via AI Gateway or direct). */
export async function proxyOpenAI(
  apiKey: string,
  request: Request,
  config: ProviderConfig,
  path: string,
  log: Log
): Promise<Response> {
  const url = `${config.baseUrl}/${path}`

  const headers = new Headers(request.headers)

  // Replace auth token with OpenAI API key
  headers.set('Authorization', `Bearer ${apiKey}`)

  // Set provider-config headers (e.g. cf-aig-authorization for gateway mode)
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      headers.set(key, value)
    }
  }

  const body = await request.text()
  log.debug(`[openai] url=${url}`)
  log.debug('[openai] upstream headers', sanitizeHeaders(headers))
  log.debug('[openai] request body', truncateBody(body))

  return fetch(url, {
    method: request.method,
    headers,
    body,
  })
}
