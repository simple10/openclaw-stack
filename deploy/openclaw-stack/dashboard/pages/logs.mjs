// pages/logs.mjs — Logs explorer page handler for the OpenClaw dashboard.
// Serves the logs HTML template wrapped in layout chrome and proxies
// API requests to the data/logs.mjs module.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessions, getLlmCalls, getSummary, getSessionMetrics, getSessionTrace } from '../data/logs.mjs'
import { renderPage } from '../layout.mjs'
import { getEffectiveBP } from '../auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function handleRequest(req, res, subPath) {
  if (subPath === '' || subPath === '/') {
    return serveHtml(res)
  }

  if (subPath === '/api/sessions') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const agent = url.searchParams.get('agent') || ''
    try {
      const data = await getSessions(agent || undefined)
      json(res, data)
    } catch (e) {
      error(res, e)
    }
    return
  }

  if (subPath === '/api/llm-calls') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const agent = url.searchParams.get('agent') || ''
    const model = url.searchParams.get('model') || ''
    const session = url.searchParams.get('session') || ''
    try {
      const data = await getLlmCalls(agent || undefined, model || undefined, session || undefined)
      json(res, data)
    } catch (e) {
      error(res, e)
    }
    return
  }

  if (subPath === '/api/summary') {
    try {
      const data = await getSummary()
      json(res, data)
    } catch (e) {
      error(res, e)
    }
    return
  }

  // Session-specific endpoints: /api/session/:id/metrics and /api/session/:id/trace
  const sessionMatch = subPath.match(/^\/api\/session\/([^/]+)\/(metrics|trace)$/)
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1])
    const action = sessionMatch[2]
    const url = new URL(req.url, `http://${req.headers.host}`)
    const agent = url.searchParams.get('agent') || ''

    try {
      const data = action === 'metrics'
        ? await getSessionMetrics(sessionId, agent || undefined)
        : await getSessionTrace(sessionId, agent || undefined)
      if (data) json(res, data)
      else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session not found' }))
      }
    } catch (e) {
      error(res, e)
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

function serveHtml(res) {
  try {
    const basePath = getEffectiveBP()
    const bodyHtml = readFileSync(join(__dirname, '..', 'html', 'logs.html'), 'utf8')
    const html = renderPage({
      title: 'OpenClaw Logs',
      bodyHtml,
      headExtra: `<script>window.__LOGS_BASE="${basePath}/logs";</script>`,
      basePath,
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Logs page error: ' + e.message)
  }
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function error(res, e) {
  console.error('[dashboard:logs] API error:', e.message)
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: e.message }))
}
