// pages/browsers.mjs — Browsers page handler for the OpenClaw dashboard.
// Shows all agent browser containers with status and noVNC links.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPage } from '../layout.mjs'
import { getEffectiveBP } from '../auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function handleRequest(req, res, subPath) {
  if (subPath === '' || subPath === '/') {
    return serveHtml(res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

function serveHtml(res) {
  try {
    const basePath = getEffectiveBP()
    const bodyHtml = readFileSync(join(__dirname, '..', 'html', 'browsers.html'), 'utf8')
    const html = renderPage({
      title: 'Agent Browsers — OpenClaw',
      bodyHtml,
      headExtra: `<script>window.__CONTROL_UI_BASE="${process.env.OPENCLAW_DOMAIN_PATH || ''}";</script>`,
      basePath,
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Browsers page error: ' + e.message)
  }
}
