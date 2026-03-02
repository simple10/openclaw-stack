import { authenticateRequest, validateAdminToken } from './auth'
import { getProviderConfig } from './config'
import { handlePreflight, addCorsHeaders } from './cors'
import { jsonError } from './errors'
import { isLlemtryEnabled, isLlmRoute, reportGeneration } from './llemtry'
import { createLog, logInboundRequest } from './log'
import { matchProviderRoute } from './routing'
import { getProviderApiKey } from './keys'
import { handleAdminRequest, handleTokenRotation, handleGetUserCreds, handleUpdateUserCreds } from './admin'
import { serveConfigPage } from './config-ui'
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

    // Config UI — no auth required (the page handles auth via JS)
    if (request.method === 'GET' && pathname === '/config') {
      return serveConfigPage()
    }

    const log = createLog(env)

    // Guard: AUTH_KV must be configured for all authenticated routes
    if (!env.AUTH_KV) {
      return addCorsHeaders(jsonError('AUTH_KV not configured', 500))
    }

    // Admin routes — protected by ADMIN_AUTH_TOKEN env var
    if (pathname.startsWith('/admin/')) {
      if (!env.ADMIN_AUTH_TOKEN) {
        return addCorsHeaders(jsonError('ADMIN_AUTH_TOKEN not configured', 500))
      }
      const isAdmin = await validateAdminToken(request, env.ADMIN_AUTH_TOKEN)
      if (!isAdmin) {
        return addCorsHeaders(jsonError('Invalid or missing admin credentials', 401))
      }
      const response = await handleAdminRequest(request, pathname, env.AUTH_KV, log)
      return addCorsHeaders(response)
    }

    // Self-service endpoints — protected by user's own token
    if (pathname.startsWith('/auth/')) {
      const userId = await authenticateRequest(request, env.AUTH_KV)
      if (!userId) {
        return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
      }

      if (request.method === 'POST' && pathname === '/auth/rotate') {
        const response = await handleTokenRotation(userId, env.AUTH_KV, log)
        return addCorsHeaders(response)
      }
      if (request.method === 'GET' && pathname === '/auth/creds') {
        const response = await handleGetUserCreds(userId, env.AUTH_KV)
        return addCorsHeaders(response)
      }
      if (request.method === 'PUT' && pathname === '/auth/creds') {
        const response = await handleUpdateUserCreds(request, userId, env.AUTH_KV, log)
        return addCorsHeaders(response)
      }

      return addCorsHeaders(jsonError('Not found', 404))
    }

    // Proxy routes — authenticate user via KV token
    const userId = await authenticateRequest(request, env.AUTH_KV)
    if (!userId) {
      return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
    }

    // Route to provider
    const route = matchProviderRoute(request.method, pathname)
    if (!route) {
      console.error(`No route match: ${request.method} ${pathname}`)
      return addCorsHeaders(jsonError('Not found', 404))
    }

    const apiKey = await getProviderApiKey(route.provider, userId, env.AUTH_KV, log)
    if (!apiKey) {
      console.error(`No API key configured for ${route.provider}: ${request.method} ${route}`)
      return addCorsHeaders(jsonError(`No API key configured for ${route.provider}`, 500))
    }

    if (env.LOG_LEVEL === 'debug') {
      logInboundRequest(log, request, route, apiKey)
    }

    const providerConfig = getProviderConfig(route.provider)

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

    // Detect upstream WAF blocks (e.g. chatgpt.com blocks Cloudflare Worker IPs)
    // and return a useful JSON error instead of forwarding the HTML challenge page.
    if (response.status === 403) {
      const ct = response.headers.get('content-type') || ''
      if (ct.includes('text/html')) {
        const host = new URL(providerConfig.baseUrl).hostname
        log.error(`[proxy] upstream ${host} returned 403 HTML — likely WAF/bot block`)
        return addCorsHeaders(jsonError(
          `Upstream ${host} blocked this request (403). ` +
          `chatgpt.com blocks requests from Cloudflare Workers. ` +
          `Set EGRESS_PROXY_URL to route through the VPS egress proxy sidecar.`,
          502
        ))
      }
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
