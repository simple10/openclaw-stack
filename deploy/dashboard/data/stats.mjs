// data/stats.mjs — Stats data collection pipeline for the OpenClaw dashboard.
// Reads session files, cron jobs, agent config, git history, and gateway health.
// Ported from openclaw-dashboard/refresh.sh (Python). Zero dependencies.
// Exports getData() with a 30-second debounce cache.

import { readFileSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const OPENCLAW_PATH = '/home/node/.openclaw'
const AGENTS_BASE = join(OPENCLAW_PATH, 'agents')
const CONFIG_PATH = join(OPENCLAW_PATH, 'openclaw.json')
const CRON_PATH = join(OPENCLAW_PATH, 'cron/jobs.json')

// Alert thresholds
const COST_HIGH = 50
const COST_WARN = 20
const CONTEXT_WARN = 80
const MEMORY_WARN_KB = 640 * 1024

// Debounce cache
let cached = null
let cachedAt = 0
let pending = null
const CACHE_MS = 30_000

// Format a date in a specific timezone as "YYYY-MM-DD HH:MM"
function fmtDate(ms, tz) {
  if (!ms) return ''
  const d = new Date(ms)
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

console.log('[stats] Stats dashboard module loaded')

// ── Export ────────────────────────────────────────────────────────────

export async function getData() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached
  if (pending) return pending
  pending = collect()
    .then(d => { cached = d; cachedAt = Date.now(); return d })
    .finally(() => { pending = null })
  return pending
}

// ── Utilities ────────────────────────────────────────────────────────

function run(cmd, args, opts) {
  return new Promise(r => {
    execFile(cmd, args, { timeout: 5000, ...opts }, (e, out) => r(e ? '' : out.trim()))
  })
}

function stripComments(s) {
  return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function readJsonc(p) {
  try { return JSON.parse(stripComments(readFileSync(p, 'utf8'))) } catch { return null }
}

function toDate(d) { return d.toISOString().slice(0, 10) }

function round2(n) { return Math.round(n * 100) / 100 }

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function modelName(m) {
  let s = m.toLowerCase()
  if (s.includes('/')) s = s.split('/').pop()
  if (s.includes('opus-4-6')) return 'Claude Opus 4.6'
  if (s.includes('opus')) return 'Claude Opus 4.5'
  if (s.includes('sonnet')) return 'Claude Sonnet'
  if (s.includes('haiku')) return 'Claude Haiku'
  if (s.includes('grok-4-fast')) return 'Grok 4 Fast'
  if (s.includes('grok-4') || s.includes('grok4')) return 'Grok 4'
  if (s.includes('gemini-2.5-pro') || s.includes('gemini-pro')) return 'Gemini 2.5 Pro'
  if (s.includes('gemini-3-flash')) return 'Gemini 3 Flash'
  if (s.includes('gemini-2.5-flash')) return 'Gemini 2.5 Flash'
  if (s.includes('gemini') || s.includes('flash')) return 'Gemini Flash'
  if (s.includes('minimax-m2.5')) return 'MiniMax M2.5'
  if (s.includes('minimax-m2') || s.includes('minimax')) return 'MiniMax'
  if (s.includes('glm-5')) return 'GLM-5'
  if (s.includes('glm-4')) return 'GLM-4'
  if (s.includes('k2p5') || s.includes('kimi')) return 'Kimi K2.5'
  if (s.includes('gpt-5.3-codex')) return 'GPT-5.3 Codex'
  if (s.includes('gpt-5')) return 'GPT-5'
  if (s.includes('gpt-4o')) return 'GPT-4o'
  if (s.includes('gpt-4')) return 'GPT-4'
  if (s.includes('o1')) return 'O1'
  if (s.includes('o3')) return 'O3'
  return m
}

// ── Bucket helpers ───────────────────────────────────────────────────

function addTo(map, name, inp, out, cr, tt, cost) {
  if (!map[name]) map[name] = { calls: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 }
  const b = map[name]
  b.calls++; b.input += inp; b.output += out; b.cacheRead += cr; b.totalTokens += tt; b.cost += cost
}

function toList(map) {
  return Object.entries(map).sort((a, b) => b[1].cost - a[1].cost).map(([model, v]) => ({
    model, calls: v.calls, input: fmt(v.input), output: fmt(v.output),
    cacheRead: fmt(v.cacheRead), totalTokens: fmt(v.totalTokens), cost: round2(v.cost),
    inputRaw: v.input, outputRaw: v.output, cacheReadRaw: v.cacheRead, totalTokensRaw: v.totalTokens,
  }))
}

function sumCost(map) { return Object.values(map).reduce((s, b) => s + b.cost, 0) }

// ── Agent directory listing ──────────────────────────────────────────

function agentDirs() {
  try {
    return readdirSync(AGENTS_BASE, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch { return [] }
}

// ── Read all session stores (single pass) ────────────────────────────

function readStores() {
  const knownSids = new Map()
  const sidToKey = new Map()
  const groupNames = {}
  const stores = []

  for (const dir of agentDirs()) {
    const store = readJson(join(AGENTS_BASE, dir, 'sessions', 'sessions.json'))
    if (!store) continue
    stores.push({ dir, store })

    for (const [key, val] of Object.entries(store)) {
      const sid = val.sessionId
      if (!sid) continue
      if (!sidToKey.has(sid)) sidToKey.set(sid, key)

      if (!key.includes(':run:')) {
        let t = 'other'
        if (key.includes('cron:')) t = 'cron'
        else if (key.includes('subagent:')) t = 'subagent'
        else if (key.includes('group:')) t = 'group'
        else if (key.includes('telegram')) t = 'telegram'
        else if (key.endsWith(':main')) t = 'main'
        knownSids.set(sid, t)
      }

      if (key.includes('group:') && !key.includes('topic') && !key.includes('run:') && !key.includes('subagent')) {
        const gid = key.split('group:').pop().split(':')[0]
        const name = val.subject || val.displayName || ''
        if (name && !name.startsWith('telegram:')) groupNames[gid] = name
      }
    }
  }

  return { knownSids, sidToKey, groupNames, stores }
}

// ── Build sessions list ──────────────────────────────────────────────

function buildSessions(stores, now) {
  const list = []
  const nowMs = now.getTime()

  for (const { dir, store } of stores) {
    for (const [key, val] of Object.entries(store)) {
      if (!val.sessionId || key.includes(':run:')) continue

      let stype = 'other'
      if (key.includes('cron:')) stype = 'cron'
      else if (key.includes('subagent:')) stype = 'subagent'
      else if (key.includes('group:')) stype = 'group'
      else if (key.includes('telegram')) stype = 'telegram'
      else if (key.endsWith(':main')) stype = 'main'

      const ctx = val.contextTokens || 0
      const total = val.totalTokens || 0
      const pct = ctx > 0 ? Math.round(total / ctx * 1000) / 10 : 0
      const updated = val.updatedAt || 0
      const age = updated > 0 ? (nowMs - updated) / 60000 : 9999

      if (age >= 1440) continue

      const rawLabel = val.label || ''
      const originLabel = val.origin?.label || ''
      const subject = val.subject || ''

      let keyShort = key
      for (const pfx of ['agent:work:', 'agent:main:', 'agent:group:']) {
        if (key.startsWith(pfx)) { keyShort = key.slice(pfx.length); break }
      }

      const trim = s => s ? s.replace(/\s*id[:\-]\s*-?\d+/g, '').trim() : ''
      const display = trim(rawLabel) || trim(subject) || trim(originLabel) || keyShort

      list.push({
        name: display.slice(0, 50), key, agent: dir,
        model: val.model || 'unknown', contextPct: Math.min(pct, 100),
        lastActivity: updated > 0 ? new Date(updated).toISOString().slice(11, 19) : '',
        updatedAt: updated, totalTokens: total, type: stype,
        spawnedBy: val.spawnedBy || '', active: age < 30,
        label: rawLabel, subject: (subject || originLabel || rawLabel).slice(0, 50),
      })
    }
  }

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return list.slice(0, 20)
}

// ── Cron jobs ────────────────────────────────────────────────────────

function readCrons() {
  const data = readJson(CRON_PATH)
  if (!data?.jobs) return []

  return data.jobs.map(job => {
    const sched = job.schedule || {}
    let schedStr = ''
    if (sched.kind === 'cron') schedStr = sched.expr || ''
    else if (sched.kind === 'every') {
      const ms = sched.everyMs || 0
      if (ms >= 86400000) schedStr = `Every ${Math.floor(ms / 86400000)}d`
      else if (ms >= 3600000) schedStr = `Every ${Math.floor(ms / 3600000)}h`
      else if (ms >= 60000) schedStr = `Every ${Math.floor(ms / 60000)}m`
      else schedStr = `Every ${ms}ms`
    } else if (sched.kind === 'at') schedStr = (sched.at || '').slice(0, 16)
    else schedStr = JSON.stringify(sched)

    const state = job.state || {}
    const lastMs = state.lastRunAtMs || 0
    const nextMs = state.nextRunAtMs || 0
    const tz = sched.tz || undefined

    return {
      name: job.name || 'Unknown',
      schedule: schedStr,
      enabled: job.enabled !== false,
      lastRun: fmtDate(lastMs, tz),
      lastStatus: state.lastStatus || 'none',
      lastDurationMs: state.lastDurationMs || 0,
      lastError: state.lastError || '',
      nextRun: fmtDate(nextMs, tz),
      model: job.payload?.model || '',
    }
  })
}

// ── Token usage from JSONL ───────────────────────────────────────────

function parseTokens(knownSids, sidToKey, today, d7, d30) {
  const modelsAll = {}, modelsToday = {}, models7d = {}, models30d = {}
  const subAll = {}, subToday = {}, sub7d = {}, sub30d = {}
  const dailyCosts = {}, dailyTokens = {}, dailyCalls = {}
  const dailySubCosts = {}, dailySubCount = {}
  const subRuns = []

  for (const dir of agentDirs()) {
    const sessDir = join(AGENTS_BASE, dir, 'sessions')
    let files
    try { files = readdirSync(sessDir) } catch { continue }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.deleted.'))

    for (const file of jsonlFiles) {
      const sid = file.split('.jsonl')[0]
      const sessionKey = sidToKey.get(sid) || ''
      const isSub = sessionKey.includes('subagent:') || !knownSids.has(sid)

      let sessionCost = 0, sessionModel = '', sessionFirstTs = null, sessionLastTs = null
      const sessionTask = sessionKey || sid.slice(0, 12)

      let content
      try { content = readFileSync(join(sessDir, file), 'utf8') } catch { continue }

      for (const line of content.split('\n')) {
        if (!line) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }

        const msg = obj.message
        if (!msg || msg.role !== 'assistant') continue
        const usage = msg.usage
        if (!usage || !usage.totalTokens) continue

        const model = msg.model || 'unknown'
        if (model.includes('delivery-mirror')) continue

        const name = modelName(model)
        const cost = typeof usage.cost === 'object' ? (usage.cost.total || 0) : 0
        const inp = usage.input || 0
        const out = usage.output || 0
        const cr = usage.cacheRead || 0
        const tt = usage.totalTokens || 0

        addTo(modelsAll, name, inp, out, cr, tt, cost)

        if (isSub) {
          addTo(subAll, name, inp, out, cr, tt, cost)
          sessionCost += cost
          sessionModel = name
        }

        const ts = obj.timestamp || ''
        let msgDate = ''
        if (ts) {
          try {
            const dt = new Date(ts)
            if (!isNaN(dt.getTime())) {
              msgDate = toDate(dt)
              if (!sessionFirstTs) sessionFirstTs = dt
              sessionLastTs = dt
            }
          } catch { /* skip */ }
        }

        if (msgDate) {
          if (!dailyCosts[msgDate]) dailyCosts[msgDate] = {}
          dailyCosts[msgDate][name] = (dailyCosts[msgDate][name] || 0) + cost
          if (!dailyTokens[msgDate]) dailyTokens[msgDate] = {}
          dailyTokens[msgDate][name] = (dailyTokens[msgDate][name] || 0) + tt
          if (!dailyCalls[msgDate]) dailyCalls[msgDate] = {}
          dailyCalls[msgDate][name] = (dailyCalls[msgDate][name] || 0) + 1

          if (isSub) {
            dailySubCosts[msgDate] = (dailySubCosts[msgDate] || 0) + cost
          }

          if (msgDate === today) {
            addTo(modelsToday, name, inp, out, cr, tt, cost)
            if (isSub) addTo(subToday, name, inp, out, cr, tt, cost)
          }
          if (msgDate >= d7) {
            addTo(models7d, name, inp, out, cr, tt, cost)
            if (isSub) addTo(sub7d, name, inp, out, cr, tt, cost)
          }
          if (msgDate >= d30) {
            addTo(models30d, name, inp, out, cr, tt, cost)
            if (isSub) addTo(sub30d, name, inp, out, cr, tt, cost)
          }
        }
      }

      if (isSub && sessionCost > 0 && sessionLastTs) {
        const dur = sessionFirstTs && sessionLastTs
          ? Math.round((sessionLastTs - sessionFirstTs) / 1000)
          : 0
        const d = toDate(sessionLastTs)
        subRuns.push({
          task: sessionTask.slice(0, 60), agent: dir, model: sessionModel,
          cost: Math.round(sessionCost * 10000) / 10000,
          durationSec: dur, status: 'completed',
          timestamp: fmtDate(sessionLastTs.getTime()),
          date: d,
        })
        dailySubCount[d] = (dailySubCount[d] || 0) + 1
      }
    }
  }

  subRuns.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  return {
    modelsAll, modelsToday, models7d, models30d,
    subagentAll: subAll, subagentToday: subToday, subagent7d: sub7d, subagent30d: sub30d,
    dailyCosts, dailyTokens, dailyCalls, dailySubCosts, dailySubCount,
    subagentRuns: subRuns,
  }
}

// ── Version ──────────────────────────────────────────────────────────

let cachedVersion = null
function getVersion() {
  if (cachedVersion) return cachedVersion
  try {
    const pkg = JSON.parse(readFileSync('/app/package.json', 'utf8'))
    cachedVersion = pkg.version || '—'
  } catch { cachedVersion = '—' }
  return cachedVersion
}

// ── Gateway health ───────────────────────────────────────────────────

async function getGateway() {
  const gw = { status: 'offline', pid: null, uptime: '', memory: '', memoryLimit: '', rss: 0 }
  try {
    const out = await run('pgrep', ['-f', 'dist/index.js.*gateway'])
    const pids = out.split('\n').filter(p => p && p !== String(process.pid))
    if (pids[0]) {
      gw.pid = parseInt(pids[0], 10)
      gw.status = 'online'
      const ps = await run('ps', ['-p', pids[0], '-o', 'lstart=,rss='])
      const tokens = ps.split(/\s+/).filter(Boolean)
      if (tokens.length >= 6) {
        const kb = parseInt(tokens[tokens.length - 1], 10)
        const startStr = tokens.slice(0, tokens.length - 1).join(' ')
        const startMs = new Date(startStr).getTime()
        if (!isNaN(startMs)) {
          const elapsed = Date.now() - startMs
          gw.uptime = fmtUptime(elapsed)
        }
        gw.rss = kb
        if (kb > 1048576) gw.memory = (kb / 1048576).toFixed(1) + ' GB'
        else if (kb > 1024) gw.memory = Math.round(kb / 1024) + ' MB'
        else gw.memory = kb + ' KB'
      }
    }
  } catch { /* ignore */ }

  // Container memory limit from cgroups (works in Docker/Sysbox)
  try {
    const { readFileSync } = await import('node:fs')
    // Try cgroup v2 first, then v1
    let limitBytes = 0
    let usageBytes = 0
    try {
      const max = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
      if (max !== 'max') limitBytes = parseInt(max, 10)
      usageBytes = parseInt(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10)
    } catch {
      try {
        limitBytes = parseInt(readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim(), 10)
        usageBytes = parseInt(readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(), 10)
      } catch { /* no cgroup info */ }
    }
    if (limitBytes > 0 && limitBytes < 1e18) {
      const fmtGB = (b) => (b / (1024 ** 3)).toFixed(1) + ' GB'
      gw.memoryLimit = `${fmtGB(usageBytes)} / ${fmtGB(limitBytes)}`
    }
  } catch { /* ignore */ }

  return gw
}

function fmtUptime(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return `${h}h ${rm}m`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return `${d}d ${rh}h ${rm}m`
}

// ── Git log ──────────────────────────────────────────────────────────

function getGit() {
  try {
    const content = readFileSync('/app/.git-info', 'utf8')
    const now = Date.now()
    return content.split('\n').filter(l => l.includes('\t')).map(l => {
      const parts = l.split('\t')
      const hash = parts[0]
      const message = parts.slice(1, -1).join('\t')
      const dateStr = parts[parts.length - 1]
      return { hash, message, ago: relTime(now - new Date(dateStr).getTime()) }
    })
  } catch { return [] }
}

function relTime(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

// ── OpenClaw config ──────────────────────────────────────────────────

function parseConfig(groupNames) {
  const res = {
    compactionMode: 'unknown', skills: [], availableModels: [],
    agentConfig: {
      primaryModel: '', primaryModelId: '', imageModel: '', imageModelId: '',
      fallbacks: [], streamMode: 'off', telegramDmPolicy: '—', telegramGroups: 0,
      channels: [], compaction: {}, agents: [], search: {}, gateway: {},
      hooks: [], plugins: [], skills: [], bindings: [], tts: false, diagnostics: false,
      subagentConfig: {},
    },
  }

  const oc = readJsonc(CONFIG_PATH)
  if (!oc) return res

  try {
    const defs = oc.agents?.defaults || {}
    const list = oc.agents?.list || []
    const primary = defs.model?.primary || ''
    const fallbacks = defs.model?.fallbacks || []
    const imgModel = defs.imageModel?.primary || ''
    const models = defs.models || {}
    const aliases = {}
    const params = {}
    for (const [mid, mc] of Object.entries(models)) {
      aliases[mid] = mc.alias || mid
      params[mid] = mc.params || {}
    }

    res.compactionMode = defs.compaction?.mode || 'auto'

    const skillAgents = {}
    for (const ag of list) {
      for (const sk of ag.skills || []) {
        if (!skillAgents[sk]) skillAgents[sk] = []
        skillAgents[sk].push(ag.id)
      }
    }
    const skillEnts = oc.skills?.entries || {}
    res.skills = Object.keys({ ...skillAgents, ...Object.fromEntries(Object.entries(skillEnts).map(([n]) => [n, true])) })
      .sort()
      .map(n => ({
        name: n,
        active: skillEnts[n] ? (typeof skillEnts[n] === 'object' ? skillEnts[n].enabled !== false : true) : true,
        agents: skillAgents[n] || [],
      }))

    res.availableModels = Object.entries(models).map(([mid, mc]) => ({
      provider: mid.includes('/') ? mid.split('/')[0].replace(/^\w/, c => c.toUpperCase()) : 'Unknown',
      name: mc.alias || mid, id: mid,
      status: mid === primary ? 'active' : 'available',
    }))

    const tg = oc.channels?.telegram || {}
    const chEnabled = Object.entries(oc.channels || {})
      .filter(([, c]) => typeof c === 'object' && c.enabled !== false).map(([k]) => k)

    const hookEnts = oc.hooks?.internal?.entries || {}
    const hooks = Object.entries(hookEnts).map(([n, v]) => ({
      name: n, enabled: typeof v === 'object' ? v.enabled !== false : true,
    }))

    const plugEnts = oc.plugins?.entries || {}
    const plugins = Object.keys(plugEnts)

    const skillsCfg = Object.entries(skillEnts).map(([n, v]) => ({
      name: n, enabled: typeof v === 'object' ? v.enabled !== false : true,
    }))

    const bindings = (oc.bindings || []).map(b => ({
      agentId: b.agentId || '', channel: b.match?.channel || '',
      kind: b.match?.peer?.kind || '', id: b.match?.peer?.id || '',
      name: groupNames[b.match?.peer?.id] || '',
    }))
    const defAgent = list.find(a => a.default)?.id || 'main'
    bindings.push({ agentId: defAgent, channel: 'all', kind: 'default', id: '', name: 'All unmatched channels' })

    const comp = defs.compaction || {}
    const web = oc.tools?.web?.search || {}
    const gw = oc.gateway || {}

    res.agentConfig = {
      primaryModel: aliases[primary] || primary,
      primaryModelId: primary,
      imageModel: aliases[imgModel] || imgModel,
      imageModelId: imgModel,
      fallbacks: fallbacks.slice(0, 3).map(f => aliases[f] || f),
      streamMode: tg.streamMode || 'off',
      telegramDmPolicy: tg.dmPolicy || '—',
      telegramGroups: Object.keys(tg.groups || {}).length,
      channels: chEnabled,
      compaction: {
        mode: comp.mode || 'auto',
        reserveTokensFloor: comp.reserveTokensFloor || 0,
        memoryFlush: comp.memoryFlush || {},
        softThresholdTokens: comp.memoryFlush?.softThresholdTokens || 0,
      },
      search: { provider: web.provider || '—', maxResults: web.maxResults || '—', cacheTtlMinutes: web.cacheTtlMinutes || '—' },
      gateway: {
        port: gw.port || '—', mode: gw.mode || '—', bind: gw.bind || '—',
        authMode: gw.auth?.mode || '—', tailscale: gw.tailscale?.mode || 'off',
      },
      hooks, plugins, skills: skillsCfg, bindings,
      tts: !!oc.talk?.apiKey,
      diagnostics: oc.diagnostics?.enabled || false,
      agents: [],
      availableModels: Object.entries(models).map(([mid, mc]) => ({
        id: mid, alias: mc.alias || mid, provider: mid.includes('/') ? mid.split('/')[0] : '—',
      })),
      subagentConfig: {
        maxConcurrent: defs.subagents?.maxConcurrent ?? '—',
        maxSpawnDepth: defs.subagents?.maxSpawnDepth ?? '—',
        maxChildrenPerAgent: defs.subagents?.maxChildrenPerAgent ?? '—',
      },
    }

    if (list.length > 0) {
      for (const ag of list) {
        const aid = ag.id || 'unknown'
        const am = ag.model || primary
        const isDef = !!ag.default
        const role = ag.role || (isDef ? 'Default' : aid.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
        const af = (ag.fallbacks || fallbacks).slice(0, 3).map(f => aliases[f] || f)
        res.agentConfig.agents.push({
          id: aid, role, model: aliases[am] || am, modelId: am,
          workspace: ag.workspace || '~/.openclaw/workspace', isDefault: isDef,
          context1m: params[am]?.context1m ?? null, fallbacks: af,
        })
      }
    } else {
      res.agentConfig.agents.push({
        id: 'default', role: 'Default', model: aliases[primary] || primary,
        modelId: primary, workspace: '~/.openclaw/workspace', isDefault: true,
        context1m: params[primary]?.context1m ?? null,
      })
    }
  } catch (e) {
    console.error('[stats] Config error:', e.message)
  }

  return res
}

// ── Daily chart data ─────────────────────────────────────────────────

function buildChart(td, now) {
  const dates = []
  for (let i = 29; i >= 0; i--) dates.push(toDate(new Date(now - i * 86400000)))

  const totals = {}
  for (const d of dates) {
    for (const [m, c] of Object.entries(td.dailyCosts[d] || {})) {
      totals[m] = (totals[m] || 0) + c
    }
  }
  const topModels = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 6)

  return dates.map(d => {
    const mc = td.dailyCosts[d] || {}
    const mt = td.dailyTokens[d] || {}
    const mk = td.dailyCalls[d] || {}
    const models = {}
    for (const m of topModels) models[m] = round2(mc[m] || 0)
    const other = Object.entries(mc).filter(([m]) => !topModels.includes(m)).reduce((s, [, c]) => s + c, 0)
    if (other > 0) models['Other'] = round2(other)

    return {
      date: d, label: d.slice(5),
      total: round2(Object.values(mc).reduce((s, c) => s + c, 0)),
      tokens: Object.values(mt).reduce((s, t) => s + t, 0),
      calls: Object.values(mk).reduce((s, c) => s + c, 0),
      subagentCost: round2(td.dailySubCosts[d] || 0),
      subagentRuns: td.dailySubCount[d] || 0,
      models,
    }
  })
}

// ── Alerts ────────────────────────────────────────────────────────────

function buildAlerts(costToday, crons, sessions, gw) {
  const alerts = []

  if (costToday > COST_HIGH)
    alerts.push({ type: 'warning', icon: '💰', message: `High daily cost: $${costToday.toFixed(2)}`, severity: 'high' })
  else if (costToday > COST_WARN)
    alerts.push({ type: 'info', icon: '💵', message: `Daily cost above $${COST_WARN}: $${costToday.toFixed(2)}`, severity: 'medium' })

  for (const c of crons) {
    if (c.lastStatus === 'error')
      alerts.push({ type: 'error', icon: '❌', message: `Cron failed: ${c.name}`, severity: 'high' })
  }

  for (const s of sessions) {
    if ((s.contextPct || 0) > CONTEXT_WARN)
      alerts.push({ type: 'warning', icon: '⚠️', message: `High context: ${s.name.slice(0, 30)} (${s.contextPct}%)`, severity: 'medium' })
  }

  if (gw.status === 'offline')
    alerts.push({ type: 'error', icon: '🔴', message: 'Gateway is offline', severity: 'critical' })

  if ((gw.rss || 0) > MEMORY_WARN_KB)
    alerts.push({ type: 'warning', icon: '🧠', message: `High memory usage: ${gw.memory}`, severity: 'medium' })

  return alerts
}

// ── Cost breakdown ───────────────────────────────────────────────────

function costBreakdown(map) {
  return Object.entries(map)
    .filter(([, b]) => b.cost > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([model, b]) => ({ model, cost: round2(b.cost) }))
}

// ── Main collector ───────────────────────────────────────────────────

async function collect() {
  const now = new Date()
  const today = toDate(now)
  const d7 = toDate(new Date(now - 7 * 86400000))
  const d30 = toDate(new Date(now - 30 * 86400000))

  const stores = readStores()

  const gw = await getGateway()
  const git = getGit()

  const cfg = parseConfig(stores.groupNames)
  const sessions = buildSessions(stores.stores, now)
  const crons = readCrons()
  const td = parseTokens(stores.knownSids, stores.sidToKey, today, d7, d30)
  const chart = buildChart(td, now)

  const costToday = sumCost(td.modelsToday)
  const costAll = sumCost(td.modelsAll)

  return {
    botName: 'OpenClaw Dashboard', botEmoji: '⚡',
    lastRefresh: now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    lastRefreshMs: now.getTime(),

    gateway: gw, version: getVersion(), compactionMode: cfg.compactionMode,

    totalCostToday: round2(costToday), totalCostAllTime: round2(costAll),
    projectedMonthly: round2(costToday * 30),
    costBreakdown: costBreakdown(td.modelsAll),
    costBreakdownToday: costBreakdown(td.modelsToday),

    sessions, sessionCount: stores.knownSids.size,
    crons,

    subagentRuns: td.subagentRuns.slice(0, 30),
    subagentRunsToday: td.subagentRuns.filter(r => r.date === today).slice(0, 20),
    subagentRuns7d: td.subagentRuns.filter(r => r.date >= d7).slice(0, 50),
    subagentRuns30d: td.subagentRuns.filter(r => r.date >= d30).slice(0, 100),
    subagentCostAllTime: round2(sumCost(td.subagentAll)),
    subagentCostToday: round2(sumCost(td.subagentToday)),
    subagentCost7d: round2(sumCost(td.subagent7d)),
    subagentCost30d: round2(sumCost(td.subagent30d)),

    tokenUsage: toList(td.modelsAll), tokenUsageToday: toList(td.modelsToday),
    tokenUsage7d: toList(td.models7d), tokenUsage30d: toList(td.models30d),
    subagentUsage: toList(td.subagentAll), subagentUsageToday: toList(td.subagentToday),
    subagentUsage7d: toList(td.subagent7d), subagentUsage30d: toList(td.subagent30d),

    dailyChart: chart,

    availableModels: cfg.availableModels, agentConfig: cfg.agentConfig, skills: cfg.skills,
    gitLog: git,
    alerts: buildAlerts(costToday, crons, sessions, gw),
  }
}
