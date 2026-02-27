// pages/changelog.mjs — Changelog page handler for the OpenClaw dashboard.
// Reads CHANGELOG.md from the container and embeds it alongside version info.
// Git log data is fetched client-side from the existing stats API.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPage } from '../layout.mjs'
import { getEffectiveBP } from '../auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Cache CHANGELOG.md content (read once, it doesn't change at runtime)
let cachedChangelog = null

function getChangelog() {
  if (cachedChangelog !== null) return cachedChangelog
  try {
    cachedChangelog = readFileSync('/app/CHANGELOG.md', 'utf8')
  } catch {
    cachedChangelog = ''
  }
  return cachedChangelog
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync('/app/package.json', 'utf8'))
    return pkg.version || ''
  } catch {
    return ''
  }
}

export async function handleRequest(req, res, subPath) {
  if (subPath === '' || subPath === '/') {
    return serveHtml(res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

function serveHtml(res) {
  try {
    const basePath = getEffectiveBP()
    const changelog = getChangelog()
    const version = getVersion()
    const bodyHtml = readFileSync(join(__dirname, '..', 'html', 'changelog.html'), 'utf8')
    const html = renderPage({
      title: `OpenClaw Changelog ${version}`,
      bodyHtml,
      headExtra: [
        `<script>window.__STATS_BASE="${basePath}/stats";</script>`,
        `<script>window.__CHANGELOG_DATA=${JSON.stringify({ version, changelog })};</script>`,
      ].join('\n'),
      basePath,
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Changelog page error: ' + e.message)
  }
}
