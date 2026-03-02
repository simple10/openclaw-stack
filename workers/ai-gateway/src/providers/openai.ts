import type { ProviderConfig, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

/** Proxy the request to OpenAI (via AI Gateway or direct). */
export async function proxyOpenAI(
  apiKey: string,
  request: Request,
  config: ProviderConfig,
  path: string,
  log: Log,
  preReadBody?: string
): Promise<Response> {
  const targetUrl = `${config.baseUrl}/${path}`

  const headers = new Headers(request.headers)

  // Replace auth token with OpenAI API key
  headers.set('Authorization', `Bearer ${apiKey}`)

  // Set provider-config headers (e.g. cf-aig-authorization for gateway mode,
  // X-Proxy-Auth for egress proxy)
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      headers.set(key, value)
    }
  }

  // When egress proxy is configured, wrap the target URL in the proxy URL
  // and strip CF-injected headers that shouldn't reach the upstream
  const url = config.egressProxyUrl
    ? `${config.egressProxyUrl}?_proxyUpstreamURL_=${encodeURIComponent(targetUrl)}`
    : targetUrl

  if (config.egressProxyUrl) {
    for (const h of [
      'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
      'x-real-ip', 'x-forwarded-proto', 'x-forwarded-for',
    ]) {
      headers.delete(h)
    }
  }

  const body = preReadBody ?? await request.text()
  log.debug(`[openai] url=${url}`)
  log.debug('[openai] upstream headers', sanitizeHeaders(headers))
  log.debug('[openai] request body', truncateBody(body))

  return fetch(url, {
    method: request.method,
    headers,
    body,
  })
}
