// pages/home.mjs — Home page handler for the OpenClaw dashboard.
// Serves the main dashboard page with all stats panels plus Agent Browsers
// and Browser Downloads boxes. Also provides API endpoints for browser
// container status and recent media files. Exports browser helpers for
// the noVNC proxy in server.mjs.

import { readFileSync, watch, watchFile } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import JSON5 from 'json5'
import { getData } from '../data/stats.mjs'
import { getRecentMedia } from './media.mjs'
import { renderPage } from '../layout.mjs'
import { getEffectiveBP } from '../auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BROWSERS_JSON = '/home/node/.openclaw/sandbox/browsers.json'
const OPENCLAW_CONFIG = '/home/node/.openclaw/openclaw.json'

// ── Agent config detection ───────────────────────────────────────────
let allAgentIds = []
let nonMainAgents = new Set()
let browserDeniedAgents = new Set()
let agentNames = new Map()

function loadAgentConfig() {
  try {
    const raw = readFileSync(OPENCLAW_CONFIG, 'utf8')
    const config = JSON5.parse(raw)
    const agents = config?.agents?.list || []
    const nonMain = new Set()
    const denied = new Set()
    const names = new Map()
    for (const agent of agents) {
      if (agent.name) names.set(agent.id, agent.name)
      if (agent?.sandbox?.mode === 'non-main') {
        nonMain.add(agent.id)
      }
      const deny = agent?.tools?.deny || []
      if (deny.includes('browser')) {
        denied.add(agent.id)
      }
    }
    const sandboxDeny = config?.tools?.sandbox?.tools?.deny || []
    if (sandboxDeny.includes('browser')) {
      for (const agent of agents) {
        const agentAllow = agent?.tools?.allow || []
        if (!agentAllow.includes('browser')) {
          denied.add(agent.id)
        }
      }
    }
    allAgentIds = agents.map((a) => a.id).filter(Boolean)
    nonMainAgents = nonMain
    browserDeniedAgents = denied
    agentNames = names
    if (nonMain.size > 0) {
      console.log(`[dashboard:home] Non-main agents (browser hidden when stopped): ${[...nonMain].join(', ')}`)
    }
    if (denied.size > 0) {
      console.log(`[dashboard:home] Browser-denied agents: ${[...denied].join(', ')}`)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log(`[dashboard:home] Could not read agent config: ${err.message}`)
    }
  }
}

function watchAgentConfig() {
  let debounceTimer = null
  const reload = () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => loadAgentConfig(), 500)
  }
  try {
    watch(OPENCLAW_CONFIG, reload)
  } catch { /* file may not exist yet */ }
  watchFile(OPENCLAW_CONFIG, { interval: 30000 }, reload)
}

// ── Browser helpers (also used by server.mjs for noVNC proxy) ────────

export function readBrowsers() {
  try {
    const data = readFileSync(BROWSERS_JSON, 'utf8')
    return JSON.parse(data).entries || []
  } catch {
    return []
  }
}

export function findEntry(agentId) {
  const entries = readBrowsers()
  return entries.find((e) => e.sessionKey === `agent:${agentId}`)
}

export function getContainerStatus(containerName) {
  return new Promise((res) => {
    execFile(
      'docker',
      [
        'inspect',
        '--format',
        '{{.State.Running}}|{{(index (index .NetworkSettings.Ports "6080/tcp") 0).HostPort}}',
        containerName,
      ],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return res({ running: false })
        const parts = stdout.trim().split('|')
        if (parts[0] === 'true' && parts[1]) {
          return res({ running: true, noVncPort: parseInt(parts[1], 10) })
        }
        res({ running: false })
      }
    )
  })
}

// ── Home page handler ────────────────────────────────────────────────

export async function handleRequest(req, res, path) {
  if (path === '/' || path === '') {
    return serveHomePage(res)
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
}

// ── API endpoints ────────────────────────────────────────────────────

export async function handleBrowsersApi(req, res) {
  const basePath = getEffectiveBP()
  const entries = readBrowsers()
  const entryMap = new Map(entries.map((e) => [e.sessionKey.replace('agent:', ''), e]))

  const seenIds = new Set(allAgentIds)
  const agentIds = [...allAgentIds]
  for (const [id] of entryMap) {
    if (!seenIds.has(id)) agentIds.push(id)
  }

  const checked = await Promise.all(
    agentIds
      .filter((id) => !(nonMainAgents.has(id) && browserDeniedAgents.has(id)))
      .map(async (id) => {
        const entry = entryMap.get(id) || null
        if (!entry) return { id, name: agentNames.get(id) || id, containerName: '', running: false, denied: browserDeniedAgents.has(id) }
        const status = await getContainerStatus(entry.containerName)
        return {
          id,
          name: agentNames.get(id) || id,
          containerName: entry.containerName,
          running: status.running,
          denied: !status.running && browserDeniedAgents.has(id),
          url: status.running ? `${basePath}/browser/${id}/` : null,
        }
      })
  )

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=5' })
  res.end(JSON.stringify(checked))
}

export function handleMediaApi(req, res) {
  const media = getRecentMedia(5)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(media))
}

// ── Home page rendering ──────────────────────────────────────────────

function serveHomePage(res) {
  try {
    const basePath = getEffectiveBP()
    const bodyHtml = readFileSync(join(__dirname, '..', 'html', 'home.html'), 'utf8')
    const html = renderPage({
      title: 'OpenClaw Mission Control',
      bodyHtml,
      headExtra: `<script>window.__STATS_BASE="${basePath}/stats";window.__CONTROL_UI_BASE="${process.env.OPENCLAW_DOMAIN_PATH || ''}";</script>`,
      basePath,
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Home page error: ' + e.message)
  }
}

// ── Initialization ───────────────────────────────────────────────────

export function init() {
  loadAgentConfig()
  watchAgentConfig()
}
