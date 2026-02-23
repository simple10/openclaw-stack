// data/logs.mjs — Session & LLM log parsing for the OpenClaw dashboard logs explorer.
// Reads JSONL session transcripts and LLM log files directly from the filesystem.
// Ported from scripts/debug-sessions/debug-sessions.py. Zero dependencies.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const OPENCLAW_PATH = '/home/node/.openclaw'
const AGENTS_BASE = join(OPENCLAW_PATH, 'agents')
const LLM_LOG = join(OPENCLAW_PATH, 'logs/llm.log')

// Per-million-token pricing (input, output, cache_read, cache_write)
const MODEL_PRICING = {
  'claude-opus-4': [15.0, 75.0, 1.50, 18.75],
  'claude-sonnet-4': [3.0, 15.0, 0.30, 3.75],
  'claude-haiku-4': [0.80, 4.0, 0.08, 1.00],
  'claude-3-5-sonnet': [3.0, 15.0, 0.30, 3.75],
  'claude-3-5-haiku': [0.80, 4.0, 0.08, 1.00],
  'claude-3-opus': [15.0, 75.0, 1.50, 18.75],
}

// Sorted by key length descending for prefix matching
const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)

// ── Debounce caches ─────────────────────────────────────────────────

let sessionsCache = null
let sessionsCacheAt = 0
let sessionsPending = null

let llmCache = null
let llmCacheAt = 0
let llmPending = null

const CACHE_MS = 30_000

// ── Formatting helpers ──────────────────────────────────────────────

function humanTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}

function humanSize(bytes) {
  for (const unit of ['B', 'K', 'M', 'G']) {
    if (Math.abs(bytes) < 1024) return unit === 'B' ? `${bytes}B` : `${bytes.toFixed(1)}${unit}`
    bytes /= 1024
  }
  return `${bytes.toFixed(1)}T`
}

function fmtCost(cost) {
  if (cost == null || cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = seconds / 60
  if (m < 60) return `${Math.floor(m)}m ${Math.round(seconds % 60)}s`
  const h = m / 60
  return `${Math.floor(h)}h ${Math.floor(m) % 60}m`
}

function truncate(text, max = 120) {
  if (!text) return ''
  text = text.replace(/\n/g, ' ').replace(/\r/g, '')
  return text.length <= max ? text : text.slice(0, max - 3) + '...'
}

function parseTimestamp(ts) {
  if (ts == null) return null
  if (typeof ts === 'number') return new Date(ts)
  if (typeof ts === 'string') {
    const d = new Date(ts)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

// ── Text extraction ─────────────────────────────────────────────────

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => typeof b === 'object' && b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
  }
  return ''
}

function isErrorResult(msg) {
  if (msg.isError) return true
  const details = msg.details
  if (details && typeof details === 'object' && (details.status === 'error' || details.status === 'forbidden')) return true
  const text = extractText(msg.content || '')
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.status === 'error') return true
  } catch { /* not JSON */ }
  if (text.includes("Can't reach") && text.toLowerCase().includes('browser')) return true
  return false
}

function categorizeError(text) {
  const t = text.toLowerCase()
  if (t.includes('escapes sandbox') || t.includes('sandbox root')) return 'sandbox'
  if (t.includes("can't reach") && t.includes('browser')) return 'browser'
  if (['network', 'dns', 'econnrefused', 'etimedout'].some(w => t.includes(w))) return 'network'
  if (['permission', 'eacces', 'forbidden'].some(w => t.includes(w))) return 'permission'
  if (['not found', 'enoent', 'no such file'].some(w => t.includes(w))) return 'filesystem'
  if (['401', '403', 'unauthorized'].some(w => t.includes(w))) return 'auth'
  if (['too long', 'overflow', 'context'].some(w => t.includes(w))) return 'context'
  return 'other'
}

function toolCallSummary(name, args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return args }
  }
  if (!args || typeof args !== 'object') return String(args || '')
  if (name === 'exec') return args.command || args.cmd || ''
  if (name === 'read' || name === 'write') return args.path || args.file || ''
  if (name === 'browser') return `${args.action || ''} ${args.url || ''}`.trim()
  if (name === 'sessions_spawn' || name === 'sessions_send') return `-> ${args.agent || args.agentId || ''}`
  if (name === 'gateway') return args.action || ''
  if (name === 'image') return 'screenshot'
  return JSON.stringify(args)
}

// ── Agent directory listing ─────────────────────────────────────────

function agentDirs() {
  try {
    return readdirSync(AGENTS_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { return [] }
}

// ── Session discovery ───────────────────────────────────────────────

function discoverSessions(agentFilter) {
  const sessions = []
  const dirs = agentFilter ? [agentFilter] : agentDirs()

  for (const agentId of dirs) {
    const sessDir = join(AGENTS_BASE, agentId, 'sessions')
    let entries
    try { entries = readdirSync(sessDir) } catch { continue }

    for (const fname of entries) {
      if (!fname.includes('.jsonl') || fname === 'sessions.json') continue
      const filepath = join(sessDir, fname)
      let stat
      try { stat = statSync(filepath); if (!stat.isFile()) continue } catch { continue }

      const parts = fname.split('.jsonl')
      const sessionId = parts[0]
      const suffix = parts[1] || ''

      let status = 'active'
      if (suffix.includes('.deleted')) status = 'deleted'
      else if (suffix.includes('.reset')) status = 'reset'

      sessions.push({
        agent: agentId,
        sessionId,
        filepath,
        status,
        mtime: stat.mtimeMs,
        size: stat.size,
      })
    }
  }

  sessions.sort((a, b) => a.mtime - b.mtime)
  return sessions
}

// ── Parse session file ──────────────────────────────────────────────

function parseSessionFile(filepath) {
  const records = []
  let content
  try { content = readFileSync(filepath, 'utf8') } catch { return records }
  for (const line of content.split('\n')) {
    if (!line) continue
    try { records.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return records
}

// ── Analyze session ─────────────────────────────────────────────────

function analyzeSession(records) {
  const result = {
    firstTs: null,
    lastTs: null,
    model: null,
    provider: null,
    assistantTurns: 0,
    userTurns: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    totalCost: 0,
    costBreakdown: {},
    tokens: {},
    stopReason: null,
    firstUserMsg: '',
    tools: {},
    turns: [],
    errors: [],
  }

  const pendingCalls = {}
  let step = 0

  for (const record of records) {
    const rtype = record.type

    if (rtype === 'session') {
      const ts = parseTimestamp(record.timestamp)
      if (ts && !result.firstTs) result.firstTs = ts
    } else if (rtype === 'model_change') {
      result.model = record.modelId
      result.provider = record.provider
    } else if (rtype === 'message') {
      const msg = record.message || {}
      const role = msg.role
      const ts = parseTimestamp(msg.timestamp || record.timestamp)

      if (ts) {
        if (!result.firstTs) result.firstTs = ts
        result.lastTs = ts
      }

      if (role === 'user') {
        result.userTurns++
        const text = extractText(msg.content || '')
        if (!result.firstUserMsg && text) result.firstUserMsg = text
      } else if (role === 'assistant') {
        result.assistantTurns++
        const usage = msg.usage || {}
        const stop = msg.stopReason
        if (stop) result.stopReason = stop

        // Token tracking
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
          result.tokens[key] = (result.tokens[key] || 0) + (usage[key] || 0)
        }

        // Cost tracking
        const cost = usage.cost
        if (cost && typeof cost === 'object') {
          for (const key of ['total', 'input', 'output', 'cacheRead', 'cacheWrite']) {
            result.costBreakdown[key] = (result.costBreakdown[key] || 0) + (cost[key] || 0)
          }
          result.totalCost += cost.total || 0
        } else if (typeof cost === 'number') {
          result.totalCost += cost
          result.costBreakdown.total = (result.costBreakdown.total || 0) + cost
        }

        // Per-turn data
        let turnCost = 0
        const costObj = usage.cost
        if (costObj && typeof costObj === 'object') turnCost = costObj.total || 0
        else if (typeof costObj === 'number') turnCost = costObj

        result.turns.push({
          step: result.assistantTurns,
          inputTokens: usage.input || 0,
          outputTokens: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
          totalTokens: usage.totalTokens || 0,
          cost: turnCost,
          stopReason: stop,
          timestamp: ts,
        })

        // Count tool calls
        const content = msg.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'toolCall') {
              step++
              result.toolCalls++
              const toolName = block.name || '?'
              if (!result.tools[toolName]) result.tools[toolName] = { count: 0, errors: 0 }
              result.tools[toolName].count++
              const callId = block.id || ''
              const args = block.arguments || {}

              let summary = ''
              if (typeof args === 'object' && args !== null) {
                summary = truncate(toolCallSummary(toolName, args), 120)
              } else if (typeof args === 'string') {
                summary = truncate(args, 120)
              }

              pendingCalls[callId] = { name: toolName, summary, step, args }
            }
          }
        }
      } else if (role === 'toolResult') {
        result.toolResults++
        const toolName = msg.toolName || '?'
        const callId = msg.toolCallId || ''
        const isErr = isErrorResult(msg)

        if (isErr) {
          result.toolErrors++
          if (!result.tools[toolName]) result.tools[toolName] = { count: 0, errors: 0 }
          result.tools[toolName].errors++
          const callInfo = pendingCalls[callId] || {}
          const errorText = extractText(msg.content || '')
          result.errors.push({
            step: callInfo.step || '?',
            tool: toolName,
            command: callInfo.summary || '',
            error: errorText,
            category: categorizeError(errorText),
          })
        }
      }
    }
  }

  return result
}

// ── Find session ────────────────────────────────────────────────────

function findSession(sessionId, agentFilter) {
  const all = discoverSessions(agentFilter)
  // Exact match
  const exact = all.filter(s => s.sessionId === sessionId)
  if (exact.length) return exact[exact.length - 1]
  // Prefix match
  const prefix = all.filter(s => s.sessionId.startsWith(sessionId))
  if (prefix.length === 1) return prefix[0]
  return null
}

// ── LLM log parsing ────────────────────────────────────────────────

function matchModelPricing(model) {
  if (!model) return null
  const m = model.toLowerCase()
  if (MODEL_PRICING[m]) return MODEL_PRICING[m]
  for (const prefix of PRICING_KEYS) {
    if (m.startsWith(prefix)) return MODEL_PRICING[prefix]
  }
  return null
}

function estimateCost(model, inputTok, outputTok, cacheRead = 0, cacheWrite = 0) {
  const pricing = matchModelPricing(model)
  if (!pricing) return null
  const [pIn, pOut, pCr, pCw] = pricing
  return inputTok * pIn / 1e6 + outputTok * pOut / 1e6 + cacheRead * pCr / 1e6 + cacheWrite * pCw / 1e6
}

function parseLlmLog() {
  let content
  try { content = readFileSync(LLM_LOG, 'utf8') } catch { return [] }

  const pendingInputs = {}
  const calls = []

  for (const line of content.split('\n')) {
    if (!line) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }

    const event = entry.event
    if (event !== 'llm_input' && event !== 'llm_output') continue

    const runId = entry.runId
    const pairKey = runId || entry.sessionKey || entry.sessionId || '_default'

    if (event === 'llm_input') {
      pendingInputs[pairKey] = entry
    } else {
      const inp = pendingInputs[pairKey] || {}
      delete pendingInputs[pairKey]

      const usage = entry.usage || {}
      const inputTok = usage.inputTokens || usage.input || entry.inputTokens || 0
      const outputTok = usage.outputTokens || usage.output || entry.outputTokens || 0
      const cacheRead = usage.cacheReadTokens || usage.cacheRead || entry.cacheReadTokens || 0
      const cacheWrite = usage.cacheWriteTokens || usage.cacheWrite || entry.cacheWriteTokens || 0

      const model = entry.model || inp.model || ''
      const cost = estimateCost(model, inputTok, outputTok, cacheRead, cacheWrite)

      const toolCalls = entry.toolCalls || []
      const toolNames = toolCalls.filter(tc => tc && typeof tc === 'object').map(tc => tc.name || '?')

      calls.push({
        timestamp: entry.timestamp || inp.timestamp,
        agentId: entry.agentId || inp.agentId || '',
        sessionId: entry.sessionId || inp.sessionId || '',
        sessionKey: entry.sessionKey || inp.sessionKey || '',
        runId: runId || '',
        provider: entry.provider || inp.provider || '',
        model,
        inputTokens: inputTok,
        outputTokens: outputTok,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cost,
        durationMs: entry.durationMs ?? null,
        stopReason: entry.stopReason || '',
        toolNames,
        toolCount: inp.toolCount ?? null,
      })
    }
  }

  return calls
}

// ── Exported API ────────────────────────────────────────────────────

export async function getSessions(agentFilter) {
  if (sessionsCache && Date.now() - sessionsCacheAt < CACHE_MS && !agentFilter) return sessionsCache
  if (sessionsPending && !agentFilter) return sessionsPending

  const work = async () => {
    const sessions = discoverSessions(agentFilter)
    const results = []

    for (const s of sessions) {
      const records = parseSessionFile(s.filepath)
      const a = analyzeSession(records)

      results.push({
        agent: s.agent,
        sessionId: s.sessionId,
        status: s.status,
        size: s.size,
        sizeHuman: humanSize(s.size),
        timestamp: a.firstTs ? a.firstTs.toISOString() : null,
        lastActivity: a.lastTs ? a.lastTs.toISOString() : null,
        turns: a.assistantTurns,
        toolCalls: a.toolCalls,
        errors: a.toolErrors,
        cost: Math.round(a.totalCost * 10000) / 10000,
        costDisplay: fmtCost(a.totalCost),
        stopReason: a.stopReason,
        firstMessage: truncate(a.firstUserMsg, 200),
        model: a.model || '',
        durationSeconds: a.firstTs && a.lastTs
          ? Math.round((a.lastTs - a.firstTs) / 1000)
          : null,
        durationDisplay: a.firstTs && a.lastTs
          ? fmtDuration((a.lastTs - a.firstTs) / 1000)
          : '',
        totalTokens: a.tokens.totalTokens || 0,
        totalTokensDisplay: humanTokens(a.tokens.totalTokens || 0),
      })
    }

    results.sort((a, b) => {
      const ta = a.lastActivity || a.timestamp || ''
      const tb = b.lastActivity || b.timestamp || ''
      return tb.localeCompare(ta)
    })

    return results
  }

  if (agentFilter) return work()

  sessionsPending = work()
    .then(d => { sessionsCache = d; sessionsCacheAt = Date.now(); return d })
    .finally(() => { sessionsPending = null })
  return sessionsPending
}

export async function getLlmCalls(agentFilter, modelFilter, sessionFilter) {
  const getCalls = () => {
    if (llmCache && Date.now() - llmCacheAt < CACHE_MS) return llmCache
    if (llmPending) return null // signal to use pending
    const calls = parseLlmLog()
    llmCache = calls
    llmCacheAt = Date.now()
    return calls
  }

  let calls = getCalls()
  if (!calls) {
    // Wait for pending — shouldn't happen often
    calls = parseLlmLog()
    llmCache = calls
    llmCacheAt = Date.now()
  }

  if (agentFilter) calls = calls.filter(c => c.agentId === agentFilter)
  if (modelFilter) {
    const mf = modelFilter.toLowerCase()
    calls = calls.filter(c => (c.model || '').toLowerCase().includes(mf))
  }
  if (sessionFilter) calls = calls.filter(c => c.sessionId === sessionFilter)

  return calls.map(c => ({
    ...c,
    costDisplay: c.cost != null ? fmtCost(c.cost) : '?',
    inputTokensDisplay: humanTokens(c.inputTokens),
    outputTokensDisplay: humanTokens(c.outputTokens),
    cacheReadDisplay: humanTokens(c.cacheReadTokens),
    cacheWriteDisplay: humanTokens(c.cacheWriteTokens),
    durationDisplay: c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : '',
  }))
}

export async function getSummary() {
  const sessions = await getSessions()
  const llmCalls = await getLlmCalls()

  const totalSessions = sessions.length
  const totalCost = sessions.reduce((s, x) => s + x.cost, 0)
  const totalTokens = sessions.reduce((s, x) => s + x.totalTokens, 0)
  const totalErrors = sessions.reduce((s, x) => s + x.errors, 0)
  const totalLlmCalls = llmCalls.length
  const llmCost = llmCalls.reduce((s, x) => s + (x.cost || 0), 0)

  // Agent breakdown
  const byAgent = {}
  for (const s of sessions) {
    if (!byAgent[s.agent]) byAgent[s.agent] = { sessions: 0, cost: 0, tokens: 0, errors: 0 }
    byAgent[s.agent].sessions++
    byAgent[s.agent].cost += s.cost
    byAgent[s.agent].tokens += s.totalTokens
    byAgent[s.agent].errors += s.errors
  }

  // Model breakdown from LLM calls
  const byModel = {}
  for (const c of llmCalls) {
    const m = c.model || 'unknown'
    if (!byModel[m]) byModel[m] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 }
    byModel[m].calls++
    byModel[m].cost += c.cost || 0
    byModel[m].inputTokens += c.inputTokens
    byModel[m].outputTokens += c.outputTokens
  }

  // Unique agents list
  const agents = [...new Set(sessions.map(s => s.agent))].sort()

  // Unique models list
  const models = [...new Set(llmCalls.map(c => c.model).filter(Boolean))].sort()

  return {
    totalSessions,
    totalCost: Math.round(totalCost * 100) / 100,
    totalCostDisplay: fmtCost(totalCost),
    totalTokens,
    totalTokensDisplay: humanTokens(totalTokens),
    totalErrors,
    totalLlmCalls,
    llmCost: Math.round(llmCost * 100) / 100,
    llmCostDisplay: fmtCost(llmCost),
    agents,
    models,
    byAgent,
    byModel,
  }
}

export async function getSessionMetrics(sessionId, agent) {
  const session = findSession(sessionId, agent)
  if (!session) return null

  const records = parseSessionFile(session.filepath)
  const a = analyzeSession(records)

  return {
    agent: session.agent,
    sessionId: session.sessionId,
    status: session.status,
    size: session.size,
    sizeHuman: humanSize(session.size),
    durationSeconds: a.firstTs && a.lastTs ? Math.round((a.lastTs - a.firstTs) / 1000) : null,
    durationDisplay: a.firstTs && a.lastTs ? fmtDuration((a.lastTs - a.firstTs) / 1000) : '',
    model: a.model,
    provider: a.provider,
    tokens: a.tokens,
    tokensDisplay: {
      input: humanTokens(a.tokens.input || 0),
      output: humanTokens(a.tokens.output || 0),
      cacheRead: humanTokens(a.tokens.cacheRead || 0),
      cacheWrite: humanTokens(a.tokens.cacheWrite || 0),
      totalTokens: humanTokens(a.tokens.totalTokens || 0),
    },
    cost: a.costBreakdown,
    costDisplay: {
      input: fmtCost(a.costBreakdown.input || 0),
      output: fmtCost(a.costBreakdown.output || 0),
      cacheRead: fmtCost(a.costBreakdown.cacheRead || 0),
      cacheWrite: fmtCost(a.costBreakdown.cacheWrite || 0),
      total: fmtCost(a.totalCost),
    },
    totalCost: a.totalCost,
    assistantTurns: a.assistantTurns,
    userTurns: a.userTurns,
    toolCalls: a.toolCalls,
    toolErrors: a.toolErrors,
    stopReason: a.stopReason,
    tools: a.tools,
    errors: a.errors,
    turns: a.turns.map(t => ({
      ...t,
      inputTokensDisplay: humanTokens(t.inputTokens),
      outputTokensDisplay: humanTokens(t.outputTokens),
      cacheReadDisplay: humanTokens(t.cacheRead),
      totalTokensDisplay: humanTokens(t.totalTokens),
      costDisplay: fmtCost(t.cost),
      timestamp: t.timestamp ? t.timestamp.toISOString() : null,
    })),
  }
}

export async function getSessionTrace(sessionId, agent) {
  const session = findSession(sessionId, agent)
  if (!session) return null

  const records = parseSessionFile(session.filepath)
  const entries = []
  const pendingCalls = {}
  let step = 0
  let cumulativeTokens = 0

  for (const record of records) {
    const rtype = record.type

    if (rtype === 'session') {
      const ts = parseTimestamp(record.timestamp)
      if (ts) entries.push({ type: 'session_start', text: ts.toISOString() })
    } else if (rtype === 'model_change') {
      entries.push({ type: 'model_change', text: `${record.provider || '?'}:${record.modelId || '?'}` })
    } else if (rtype === 'message') {
      const msg = record.message || {}
      const role = msg.role

      if (role === 'user') {
        const text = extractText(msg.content || '')
        if (text) entries.push({ type: 'user', text: truncate(text, 500) })
      } else if (role === 'assistant') {
        const usage = msg.usage || {}
        const totalTok = usage.totalTokens || 0
        cumulativeTokens += totalTok
        const costObj = usage.cost
        let turnCost = 0
        if (costObj && typeof costObj === 'object') turnCost = costObj.total || 0
        else if (typeof costObj === 'number') turnCost = costObj
        const stop = msg.stopReason || ''

        const content = msg.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const btype = block.type

            if (btype === 'thinking') {
              const text = block.thinking || ''
              if (text) entries.push({ type: 'assistant_thinking', text: truncate(text, 300) })
            } else if (btype === 'text') {
              const text = block.text || ''
              if (text) entries.push({ type: 'assistant_text', text: truncate(text, 500) })
            } else if (btype === 'toolCall') {
              step++
              const name = block.name || '?'
              const callId = block.id || ''
              const args = block.arguments || {}
              const summary = truncate(toolCallSummary(name, args), 120)
              pendingCalls[callId] = { name, step }
              entries.push({ type: 'tool_call', step, name, summary })
            }
          }
        }

        // Turn metadata
        const parts = []
        if (totalTok > 0) parts.push(`tokens: ${totalTok.toLocaleString()}`)
        parts.push(`cumul: ${humanTokens(cumulativeTokens)}`)
        if (turnCost > 0) parts.push(`cost: ${fmtCost(turnCost)}`)
        if (stop && stop !== 'stop' && stop !== 'end_turn') parts.push(`stop: ${stop}`)
        entries.push({ type: 'turn_meta', parts })
      } else if (role === 'toolResult') {
        const toolName = msg.toolName || '?'
        const callId = msg.toolCallId || ''
        const isErr = isErrorResult(msg)
        const text = extractText(msg.content || '')
        const callInfo = pendingCalls[callId] || {}

        entries.push({
          type: 'tool_result',
          step: callInfo.step || 0,
          toolName,
          isError: isErr,
          text: truncate(text, 300),
        })
      }
    }
  }

  return { agent: session.agent, sessionId: session.sessionId, status: session.status, entries }
}

console.log('[dashboard:logs] Logs data module loaded')
