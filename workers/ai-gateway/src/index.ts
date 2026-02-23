import { validateAuthToken } from './auth'
import { PROVIDER_CONFIG } from './config'
import { handlePreflight, addCorsHeaders } from './cors'
import { jsonError } from './errors'
import { isLlemtryEnabled, isLlmRoute, reportGeneration } from './llemtry'
import { createLog, logInboundRequest } from './log'
import { matchProviderRoute } from './routing'
import { getProviderApiKey } from './keys'
import { proxyOpenAI } from './providers/openai'
import { proxyAnthropic } from './providers/anthropic'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handlePreflight()
    }

    const { pathname } = new URL(request.url)

    // Health check — no auth required
    if (request.method === 'GET' && pathname === '/health') {
      return addCorsHeaders(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }

    const log = createLog(env)

    // Auth check for all other routes
    const authToken = await validateAuthToken(request, env.AUTH_TOKEN)
    if (!authToken) {
      return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
    }

    // Route to provider
    const route = matchProviderRoute(request.method, pathname)
    if (!route) {
      return addCorsHeaders(jsonError('Not found', 404))
    }

    const apiKey = getProviderApiKey(route.provider, authToken, env)
    if (!apiKey) {
      console.error(`No API key configured for ${route.provider}: ${request.method} ${route}`)
      return addCorsHeaders(jsonError(`No API key configured for ${route.provider}`, 500))
    }

    if (env.LOG_LEVEL === 'debug') {
      logInboundRequest(log, request, route, apiKey)
    }

    const providerConfig = PROVIDER_CONFIG[route.provider]

    // CF AI Gateway uses a different path format (strips /v1/, adds provider prefix)
    const isGateway = providerConfig.baseUrl.includes('gateway.ai.cloudflare.com')
    const upstreamPath = isGateway ? route.gatewayPath : route.directPath

    // When llemtry is enabled for an LLM route, pre-read the request body
    // so it can be shared with both the proxy function and llemtry reporting
    const llemtryActive = isLlemtryEnabled(env, log) && isLlmRoute(route.directPath)
    const startTime = llemtryActive ? new Date() : undefined
    const requestBody = llemtryActive ? await request.text() : undefined

    let response: Response
    if (route.provider === 'anthropic') {
      response = await proxyAnthropic(
        apiKey,
        request,
        providerConfig,
        upstreamPath,
        log,
        requestBody
      )
    } else {
      response = await proxyOpenAI(apiKey, request, providerConfig, upstreamPath, log, requestBody)
    }

    // Llemtry: tee the response stream and report in the background
    if (llemtryActive && response.ok && response.body) {
      const statusCode = response.status
      const responseHeaders = new Headers(response.headers)
      const [clientStream, reportStream] = response.body.tee()
      response = new Response(clientStream, response)

      ctx.waitUntil(
        reportGeneration(env, log, {
          provider: route.provider,
          requestBody: requestBody!,
          responseStream: reportStream,
          responseHeaders,
          statusCode,
          startTime: startTime!,
        })
      )
    }

    return addCorsHeaders(response)
  },
} satisfies ExportedHandler<Env>
