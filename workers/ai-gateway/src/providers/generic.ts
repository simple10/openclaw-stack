import type { Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

/** Proxy the request to a generic OpenAI-compatible provider. */
export async function proxyGeneric(
  apiKey: string,
  request: Request,
  baseUrl: string,
  directPath: string,
  log: Log,
  provider: string,
  preReadBody?: string
): Promise<Response> {
  const targetUrl = `${baseUrl}/${directPath}`

  const headers = new Headers()
  headers.set('content-type', request.headers.get('content-type') || 'application/json')
  headers.set('authorization', `Bearer ${apiKey}`)
  const accept = request.headers.get('accept')
  if (accept) headers.set('accept', accept)

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
