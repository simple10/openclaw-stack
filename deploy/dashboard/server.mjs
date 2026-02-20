#!/usr/bin/env node

// server.mjs — Dashboard HTTP server entry point.
// Routes requests through two-layer auth (CF Access + device pairing),
// dispatches to page handlers, serves static assets, and proxies noVNC
// browser sessions. Zero dependencies (Node.js built-ins only).

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve, extname, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkCfAccess, checkSession, checkWs,
  handleAuthPost, authGatePage,
  PAIRING_AUTH_ENABLED,
  getEffectiveBP, setEffectiveBP, getConfiguredBP,
  init as initAuth,
} from './auth.mjs'

import {
  handleRequest as handleHome,
  handleBrowsersApi,
  handleMediaApi,
  findEntry,
  getContainerStatus,
  init as initHome,
} from './pages/home.mjs'

import { handleRequest as handleBrowsers } from './pages/browsers.mjs'
import { handleRequest as handleStats } from './pages/stats.mjs'
import { handleRequest as handleMedia } from './pages/media.mjs'
import { handleRequest as handleLogs } from './pages/logs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 6090
const PUBLIC_DIR = join(__dirname, 'public')

// ── Static file serving ─────────────────────────────────────────────
// Serves CSS, JS, and JSON from the public/ directory.
// Allowlisted extensions only, path traversal protection.

const STATIC_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function serveStatic(req, res, subPath) {
  const ext = extname(subPath).toLowerCase()
  const mime = STATIC_MIME[ext]
  if (!mime) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  const filePath = resolve(PUBLIC_DIR, subPath.startsWith('/') ? subPath.slice(1) : subPath)
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  try {
    const data = readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }
}

// ── noVNC error pages ───────────────────────────────────────────────

function containerDownPage(agentId) {
  const bp = getEffectiveBP()
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Browser Not Running</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #f0f0f0; }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Browser Not Running</h1>
  <p>The browser container for agent <strong>"${agentId}"</strong> is registered but not currently running.</p>
  <p>Browser containers are started on-demand when an agent uses the browser tool.</p>
  <p>Send a browser task to the agent to start a new session, then refresh this page.</p>
  <p style="margin-top: 24px;"><a href="${bp}/">&larr; Back to dashboard</a></p>
</body>
</html>`
}

function notFoundPage(msg) {
  const bp = getEffectiveBP()
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Not Found</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #f0f0f0; }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Not Found</h1>
  <p>${msg}</p>
  <p><a href="${bp}/">&larr; Back to dashboard</a></p>
</body>
</html>`
}

// ── HTTP request handler ────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Layer 1: Cloudflare Access JWT
  if (!await checkCfAccess(req, res)) return

  const url = new URL(req.url, `http://${req.headers.host}`)
  let path = url.pathname
  const BP = getConfiguredBP()

  // Base path handling: strip configured prefix if present
  if (BP) {
    if (path === BP) {
      res.writeHead(302, { Location: `${BP}/` })
      res.end()
      return
    }
    if (path.startsWith(BP + '/')) {
      path = path.slice(BP.length)
    }
  }

  // Auto-detect base path when DASHBOARD_BASE_PATH is not set.
  // If the first path segment isn't a known route or agent, treat it as a prefix.
  if (!BP) {
    const seg = path.match(/^\/([^/]+)(\/.*)?$/)
    if (
      seg &&
      seg[1] !== 'media' &&
      seg[1] !== '_auth' &&
      seg[1] !== 'browser' &&
      seg[1] !== 'browsers' &&
      seg[1] !== 'stats' &&
      seg[1] !== 'logs' &&
      seg[1] !== 'api' &&
      seg[1] !== 'public' &&
      !findEntry(seg[1])
    ) {
      const detected = `/${seg[1]}`
      const currentBP = getEffectiveBP()
      if (!currentBP) {
        setEffectiveBP(detected)
        console.log(
          `[dashboard] Auto-detected base path: ${detected} (set DASHBOARD_BASE_PATH=${detected} to make this explicit)`
        )
      }
      if (getEffectiveBP() === detected) {
        if (!seg[2]) {
          res.writeHead(302, { Location: `${detected}/` })
          res.end()
          return
        }
        path = seg[2]
      }
    }
  }

  // Layer 2: Device pairing auth (/_auth routes exempt from cookie check)
  if (PAIRING_AUTH_ENABLED) {
    if (path === '/_auth') {
      if (req.method === 'POST') {
        handleAuthPost(req, res)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(authGatePage())
      return
    }

    if (!checkSession(req, res)) return
  }

  const bp = getEffectiveBP()

  // ── Route dispatch ────────────────────────────────────────────────

  // Static assets
  if (path.startsWith('/public/')) {
    serveStatic(req, res, path.slice('/public'.length))
    return
  }

  // Home page
  if (path === '/' || path === '') {
    return handleHome(req, res, path)
  }

  // Browsers page
  if (path === '/browsers' || path.startsWith('/browsers/')) {
    const subPath = path === '/browsers' ? '' : path.slice('/browsers'.length)
    return handleBrowsers(req, res, subPath)
  }

  // Stats dashboard
  if (path === '/stats' || path.startsWith('/stats/')) {
    const subPath = path === '/stats' ? '' : path.slice('/stats'.length)
    return handleStats(req, res, subPath)
  }

  // Logs explorer
  if (path === '/logs' || path.startsWith('/logs/')) {
    const subPath = path === '/logs' ? '' : path.slice('/logs'.length)
    return handleLogs(req, res, subPath)
  }

  // Media browser
  if (path === '/media' || path.startsWith('/media/')) {
    const subPath = path === '/media' ? '/' : path.slice('/media'.length)
    return handleMedia(req, res, subPath)
  }

  // Browser status API
  if (path === '/api/browsers') {
    return handleBrowsersApi(req, res)
  }

  // Media preview API
  if (path === '/api/media/recent') {
    return handleMediaApi(req, res)
  }

  // Bare /browser or /browser/ → redirect to home
  if (path === '/browser' || path === '/browser/') {
    res.writeHead(302, { Location: `${bp}/` })
    res.end()
    return
  }

  // noVNC browser proxy: /browser/<agent-id>/*
  const browserMatch = path.match(/^\/browser\/([^/]+)(\/.*)?$/)
  if (!browserMatch) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(notFoundPage('Page not found.'))
    return
  }

  const agentId = browserMatch[1]
  const subPath = browserMatch[2] || '/'

  // Bare /browser/<agent-id>/ → redirect to vnc.html with websockify path
  if (subPath === '/') {
    const wsPrefix = bp.startsWith('/') ? bp.slice(1) : bp
    res.writeHead(302, {
      Location: `${bp}/browser/${agentId}/vnc.html?path=${
        wsPrefix ? wsPrefix + '/' : ''
      }browser/${agentId}/websockify`,
    })
    res.end()
    return
  }

  const entry = findEntry(agentId)
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(notFoundPage(`No browser session for agent <strong>"${agentId}"</strong>.`))
    return
  }

  // Get real container status (browsers.json ports are stale after restarts)
  const containerStatus = await getContainerStatus(entry.containerName)
  if (!containerStatus.running) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(containerDownPage(agentId))
    return
  }

  // Proxy HTTP to browser container's noVNC
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: containerStatus.noVncPort,
      path: subPath + url.search,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(containerDownPage(agentId))
    }
  })
  req.pipe(proxyReq)
})

// ── WebSocket upgrade handler (noVNC) ───────────────────────────────

server.on('upgrade', async (req, socket, head) => {
  if (!await checkWs(req, socket)) return

  const url = new URL(req.url, `http://${req.headers.host}`)
  let wsPath = url.pathname
  const BP = getConfiguredBP()

  // Strip base path prefix
  if (BP && wsPath.startsWith(BP + '/')) {
    wsPath = wsPath.slice(BP.length)
  } else if (!BP) {
    const ebp = getEffectiveBP()
    if (ebp && wsPath.startsWith(ebp + '/')) {
      wsPath = wsPath.slice(ebp.length)
    }
  }

  const match = wsPath.match(/^\/browser\/([^/]+)(\/.*)?$/)
  if (!match) {
    socket.destroy()
    return
  }

  const agentId = match[1]
  const subPath = match[2] || '/'
  const entry = findEntry(agentId)
  if (!entry) {
    socket.destroy()
    return
  }

  const containerStatus = await getContainerStatus(entry.containerName)
  if (!containerStatus.running) {
    socket.destroy()
    return
  }

  // Connect to backend noVNC WebSocket
  const backend = connect(containerStatus.noVncPort, '127.0.0.1', () => {
    const reqLine = `${req.method} ${subPath + url.search} HTTP/${req.httpVersion}\r\n`
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')
    backend.write(reqLine + headers + '\r\n\r\n')
    if (head.length > 0) backend.write(head)
    socket.pipe(backend)
    backend.pipe(socket)
  })

  backend.on('error', () => socket.destroy())
  socket.on('error', () => backend.destroy())
})

// ── Startup ─────────────────────────────────────────────────────────

initAuth()
initHome()

server.listen(PORT, () => {
  const bp = getConfiguredBP()
  console.log(
    `[dashboard] Listening on port ${PORT}${
      bp ? `, base path: ${bp}` : ' (no base path — will auto-detect from first request if needed)'
    }`
  )
})
