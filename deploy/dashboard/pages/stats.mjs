// pages/stats.mjs — Stats page handler for the OpenClaw dashboard.
// Thin wrapper: serves the stats HTML template wrapped in layout chrome,
// proxies /stats/api/refresh to the data collection pipeline, and serves
// the themes.json file for the theme engine.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getData } from '../data/stats.mjs'
import { renderPage } from '../layout.mjs'
import { getEffectiveBP } from '../auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function handleRequest(req, res, subPath) {
  if (subPath === '' || subPath === '/') {
    return serveHtml(res)
  }
  if (subPath === '/api/refresh') {
    const data = await getData()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(data))
  }
  if (subPath === '/themes.json') {
    return serveThemes(res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

function serveHtml(res) {
  try {
    const basePath = getEffectiveBP()
    const bodyHtml = readFileSync(join(__dirname, '..', 'html', 'stats.html'), 'utf8')
    const html = renderPage({
      title: 'OpenClaw Stats',
      bodyHtml,
      headExtra: `<script>window.__STATS_BASE="${basePath}/stats";</script>`,
      basePath,
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Stats page error: ' + e.message)
  }
}

function serveThemes(res) {
  try {
    const data = readFileSync(join(__dirname, '..', 'themes.json'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' })
    res.end(data)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('File error: ' + e.message)
  }
}
