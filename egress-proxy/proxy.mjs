/**
 * Generic egress proxy — forwards requests to an upstream URL specified via query param.
 * Runs on the VPS behind a Cloudflare Tunnel so the request originates from the VPS IP,
 * bypassing WAF rules that block Cloudflare Worker IPs.
 *
 * Env: PORT (default 8787), PROXY_AUTH_TOKEN (required), LOG_LEVEL (default "info")
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT) || 8787
const AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase()

if (!AUTH_TOKEN) {
  console.error('PROXY_AUTH_TOKEN is required')
  process.exit(1)
}

// ── Logging ────────────────────────────────────────────────────────────────

const REDACT_HEADERS = new Set([
  'authorization', 'x-api-key', 'x-proxy-auth',
  'cf-access-client-id', 'cf-access-client-secret',
  'cf-access-jwt-assertion', 'cookie',
])
const MASK_HEADERS = new Set(['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'])

/** Redact sensitive header values for safe logging. */
function sanitizeHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
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

const isDebug = LOG_LEVEL === 'debug'

// ── Server ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Health check — no auth required
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }

  // Authenticate
  const authHeader = req.headers['x-proxy-auth'] || ''
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"unauthorized"}')
    return
  }

  // Extract upstream URL from query param
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`)
  const upstreamUrl = parsedUrl.searchParams.get('_proxyUpstreamURL_')
  if (!upstreamUrl) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":"missing _proxyUpstreamURL_ query param"}')
    return
  }

  // Build final upstream URL, preserving any other query params from the original request
  const upstream = new URL(upstreamUrl)
  for (const [key, value] of parsedUrl.searchParams) {
    if (key !== '_proxyUpstreamURL_') upstream.searchParams.append(key, value)
  }

  // Build headers — strip proxy/tunnel/CF headers, forward everything else
  const headers = { ...req.headers }
  delete headers['host']
  delete headers['connection']
  delete headers['x-proxy-auth']
  // CF Access / Tunnel headers injected by cloudflared — don't leak to upstream
  delete headers['cf-access-client-id']
  delete headers['cf-access-client-secret']
  delete headers['cf-access-jwt-assertion']
  delete headers['cookie']  // CF_Authorization cookie
  delete headers['cf-connecting-ip']
  delete headers['cf-ipcountry']
  delete headers['cf-ray']
  delete headers['cf-visitor']
  delete headers['cf-warp-tag-id']
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-proto']
  delete headers['x-real-ip']
  // cdn-loop accumulates across CF hops — upstream WAFs flag it
  delete headers['cdn-loop']
  delete headers['sec-fetch-mode']
  // CF Worker origin headers — upstream WAFs block requests with these
  delete headers['cf-ew-via']
  delete headers['cf-worker']

  console.log(`[proxy] ${req.method} → ${upstream.href}`)
  if (isDebug) {
    console.log(`[proxy] headers: ${JSON.stringify(sanitizeHeaders(headers))}`)
  }

  try {
    const response = await fetch(upstream.href, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      duplex: 'half',
    })

    console.log(`[proxy] ← ${response.status} ${response.headers.get('content-type') || ''}`)

    // Stream the response back
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      const reader = response.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      }
      pump().catch(() => res.end())
    } else {
      res.end()
    }
  } catch (err) {
    console.error(`[proxy] upstream error: ${err.message}`)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'upstream request failed', detail: err.message }))
  }
})

server.listen(PORT, () => console.log(`egress-proxy listening on :${PORT} (log_level=${LOG_LEVEL})`))
