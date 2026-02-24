#!/usr/bin/env bun
/**
 * Interactive TUI for OpenClaw session debug & analytics.
 * Run: bun scripts/lib/logs-explorer/main.ts
 */

import {
  enterAltScreen, exitAltScreen, termSize, renderFrame, parseKey,
  st, pad, stripAnsi, withBg,
  RESET, BOLD, DIM, INVERT, RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA, GRAY, BG_HIGHLIGHT,
  type Key,
} from "./terminal"
import {
  loadConfig, listInstances, withInstance, uploadScript, fetchSessions, fetchLlmCalls, runCommand,
  type SessionInfo, type LlmCallInfo, type Config,
} from "./remote"

// ─── Constants ───────────────────────────────────────────────────────────────

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("")

const MENU_ITEMS: [string, string][] = [
  ["Sessions", "Browse and explore session transcripts"],
  ["Agent Summary", "Aggregate stats across agents"],
  ["LLM Calls", "Browse LLM API call logs"],
  ["LLM Summary", "Aggregate LLM stats by agent/model"],
]

const ACTIONS: [cmd: string, label: string, desc: string][] = [
  ["trace", "Trace", "Step-by-step execution trace"],
  ["metrics", "Metrics", "Token/cost breakdown and charts"],
  ["errors", "Errors", "Extract and categorize errors"],
  ["llm-trace", "LLM Calls", "LLM API calls for this session"],
]

const LLM_ACTIONS: [cmd: string, label: string, desc: string][] = [
  ["llm-trace", "LLM Trace", "Full LLM call details for parent session"],
]

type Sort = "date" | "cost" | "errors" | "size" | "turns"
const SORTS: Sort[] = ["date", "cost", "errors", "size", "turns"]

type LlmSort = "date" | "cost" | "duration" | "tokens"
const LLM_SORTS: LlmSort[] = ["date", "cost", "duration", "tokens"]

type Screen = "instances" | "menu" | "sessions" | "actions" | "output" | "agents"
  | "llm-calls" | "llm-actions" | "models"

// ─── State ───────────────────────────────────────────────────────────────────

let cfg: Config
let screen: Screen = "menu"
let cursor = 0
let scroll = 0
let instanceList: string[] = []
let sessions: SessionInfo[] = []
let filtered: SessionInfo[] = []
let agents: string[] = []
let agentFilter: string | null = null
let sortKey: Sort = "date"
let outputLines: string[] = []
let outputScroll = 0
let outputTitle = ""
let screenStack: Screen[] = []
let loadingMsg = ""
let errorMsg = ""
let spinFrame = 0
let spinTimer: ReturnType<typeof setInterval> | null = null
let busy = false
let selected: SessionInfo | null = null
let llmCalls: LlmCallInfo[] = []
let filteredLlmCalls: LlmCallInfo[] = []
let modelFilter: string | null = null
let llmSortKey: LlmSort = "date"
let selectedLlmCall: LlmCallInfo | null = null
let llmModels: string[] = []

// ─── State helpers ───────────────────────────────────────────────────────────

function push(next: Screen) {
  screenStack.push(screen)
  screen = next
  cursor = 0
  scroll = 0
}

function pop() {
  if (screenStack.length) {
    screen = screenStack.pop()!
    // Don't reset cursor/scroll — preserve position when going back
  }
}

function applyFilter() {
  let list = agentFilter
    ? sessions.filter((s) => s.agent === agentFilter)
    : [...sessions]
  list.sort((a, b) => {
    switch (sortKey) {
      case "date": return (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
      case "cost": return b.cost - a.cost
      case "errors": return b.errors - a.errors
      case "size": return b.size - a.size
      case "turns": return b.turns - a.turns
    }
  })
  filtered = list
  cursor = Math.min(cursor, Math.max(0, list.length - 1))
}

function applyLlmFilter() {
  let list = llmCalls
  if (agentFilter) list = list.filter((c) => c.agentId === agentFilter)
  if (modelFilter) list = list.filter((c) => c.model.toLowerCase().includes(modelFilter!.toLowerCase()))
  list = [...list].sort((a, b) => {
    switch (llmSortKey) {
      case "date": return (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
      case "cost": return (b.cost ?? 0) - (a.cost ?? 0)
      case "duration": return (b.durationMs ?? 0) - (a.durationMs ?? 0)
      case "tokens": return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
    }
  })
  filteredLlmCalls = list
  cursor = Math.min(cursor, Math.max(0, list.length - 1))
}

function startSpinner(msg: string) {
  loadingMsg = msg
  busy = true
  spinTimer = setInterval(() => { spinFrame = (spinFrame + 1) % SPINNER.length; render() }, 80)
  render()
}

function stopSpinner() {
  busy = false
  loadingMsg = ""
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null }
}

function clamp(v: number, max: number) { return Math.max(0, Math.min(max, v)) }

// ─── Formatting ──────────────────────────────────────────────────────────────

function humanSize(b: number): string {
  for (const u of ["B", "K", "M", "G"]) {
    if (Math.abs(b) < 1024) return u === "B" ? `${b}B` : `${b.toFixed(1)}${u}`
    b /= 1024
  }
  return `${b.toFixed(1)}T`
}

function fmtCost(c: number): string {
  return c === 0 ? "$0.00" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return ""
  return `${(ms / 1000).toFixed(1)}s`
}

function hbar(text: string, w: number) { return st(pad(` ${text}`, w), BOLD, INVERT) }
function fbar(text: string, w: number) { return st(pad(` ${text}`, w), DIM, INVERT) }

function statusLine(): string {
  if (loadingMsg) return `  ${st(SPINNER[spinFrame], GREEN)} ${st(loadingMsg, YELLOW)}`
  if (errorMsg) return st(`  ${errorMsg}`, RED)
  return ""
}

// ─── Screen renderers ────────────────────────────────────────────────────────

function render() {
  const [cols, rows] = termSize()
  let lines: string[]
  switch (screen) {
    case "instances":   lines = rInstances(cols, rows); break
    case "menu":        lines = rMenu(cols, rows); break
    case "sessions":    lines = rSessions(cols, rows); break
    case "actions":     lines = rActions(cols, rows); break
    case "output":      lines = rOutput(cols, rows); break
    case "agents":      lines = rAgents(cols, rows); break
    case "llm-calls":   lines = rLlmCalls(cols, rows); break
    case "llm-actions": lines = rLlmActions(cols, rows); break
    case "models":      lines = rModels(cols, rows); break
  }
  renderFrame(lines, cols, rows)
}

function rInstances(w: number, h: number): string[] {
  const L: string[] = []
  L.push(hbar("Select Claw Instance", w))
  L.push(statusLine())
  L.push(st(`  VPS: ${cfg.host}  ${st(`${instanceList.length} instances found`, DIM)}`, DIM))
  L.push("")

  for (let i = 0; i < instanceList.length; i++) {
    const sel = i === cursor
    const name = instanceList[i]
    L.push(sel
      ? `  ${st("\u25b8", CYAN, BOLD)} ${st(name, BOLD, CYAN)}`
      : `    ${name}`,
    )
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  q Quit", w))
  return L
}

function rMenu(w: number, h: number): string[] {
  const L: string[] = []
  L.push(hbar("OpenClaw Session Debug", w))
  L.push(statusLine())
  L.push(st(`  VPS: ${cfg.host}${cfg.instance ? `  Claw: ${cfg.instance}` : ""}`, DIM))
  L.push("")

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const [label, desc] = MENU_ITEMS[i]
    const sel = i === cursor
    L.push(sel ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}` : `    ${label}`)
    L.push(`      ${st(desc, DIM)}`)
    L.push("")
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  q Quit", w))
  return L
}

function rSessions(w: number, h: number): string[] {
  const L: string[] = []
  const af = agentFilter ?? "all"
  const rightInfo = `Agent: ${af} [A]  Sort: ${sortKey} [S]`
  const leftInfo = `Sessions (${filtered.length})`
  const gap = Math.max(2, w - leftInfo.length - rightInfo.length - 4)
  L.push(hbar(`${leftInfo}${" ".repeat(gap)}${rightInfo}`, w))
  L.push(statusLine())

  L.push(st(
    `   ${"AGENT".padEnd(12)} ${"SESSION".padEnd(10)} ${"DATE".padEnd(17)} ` +
    `${"SIZE".padStart(6)} ${"TURNS".padStart(5)} ${"ERRS".padStart(4)} ` +
    `${"COST".padStart(8)}  ${"STOP".padEnd(8)}`, DIM,
  ))
  L.push(st("  " + "\u2500".repeat(Math.min(w - 4, 88)), DIM))

  const headerH = L.length
  const footerH = 1
  const contentH = h - headerH - footerH

  if (cursor < scroll) scroll = cursor
  if (cursor >= scroll + contentH) scroll = cursor - contentH + 1

  if (filtered.length === 0) {
    L.push("")
    L.push(st("  No sessions found.", DIM))
  } else {
    for (let i = scroll; i < Math.min(filtered.length, scroll + contentH); i++) {
      L.push(sessionRow(filtered[i], i === cursor, w))
    }
  }

  while (L.length < h - footerH) L.push("")
  L.push(fbar("\u2191\u2193/jk Navigate  Enter Select  A Agent  S Sort  Esc Back  q Quit", w))
  return L
}

function sessionRow(si: SessionInfo, sel: boolean, w: number): string {
  const pfx = sel ? st("\u25b8 ", CYAN, BOLD) : "  "
  const agent = si.agent.padEnd(12)
  const sid = si.session_id.slice(0, 8).padEnd(10)
  const dt = si.timestamp
    ? new Date(si.timestamp).toISOString().slice(5, 16).replace("T", " ")
    : "?"
  const date = dt.padEnd(17)
  const size = humanSize(si.size).padStart(6)
  const turns = String(si.turns).padStart(5)

  // Pre-pad then color to maintain alignment
  const errs = si.errors > 0
    ? st(String(si.errors).padStart(4), RED)
    : String(si.errors).padStart(4)
  const cost = si.cost > 10
    ? st(fmtCost(si.cost).padStart(8), RED, BOLD)
    : si.cost > 1 ? st(fmtCost(si.cost).padStart(8), YELLOW)
    : fmtCost(si.cost).padStart(8)
  const stop = (si.stop_reason ?? "?").padEnd(8)
  const stopC = si.stop_reason === "stop" || si.stop_reason === "end_turn"
    ? st(stop, GREEN) : st(stop, RED)
  const mark = si.status === "deleted" ? st(" \u2717", RED)
    : si.status === "reset" ? st(" \u21ba", YELLOW) : ""

  const row = `${pfx}${agent} ${sid} ${date} ${size} ${turns} ${errs} ${cost}  ${stopC}${mark}`
  return sel ? withBg(pad(row, w), BG_HIGHLIGHT) : row
}

function rActions(w: number, h: number): string[] {
  const L: string[] = []
  const si = selected!
  L.push(hbar(
    `${si.agent}/${si.session_id.slice(0, 8)}  \u2502  ` +
    `${si.turns} turns  \u2502  ${si.errors} errors  \u2502  ${fmtCost(si.cost)}`, w,
  ))
  L.push(statusLine())
  L.push("")

  for (let i = 0; i < ACTIONS.length; i++) {
    const [, label, desc] = ACTIONS[i]
    const sel = i === cursor
    L.push(sel ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}` : `    ${label}`)
    L.push(`      ${st(desc, DIM)}`)
    L.push("")
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  Esc Back  q Quit", w))
  return L
}

function rOutput(w: number, h: number): string[] {
  const L: string[] = []
  const total = outputLines.length
  const pos = total > 0 ? `Line ${outputScroll + 1}\u2013${Math.min(outputScroll + h - 2, total)}/${total}` : ""
  L.push(hbar(`${outputTitle}${" ".repeat(Math.max(2, w - outputTitle.length - pos.length - 4))}${pos}`, w))
  L.push(statusLine())

  const contentH = h - 3 // header + status + footer
  for (let i = outputScroll; i < Math.min(total, outputScroll + contentH); i++) {
    L.push(outputLines[i])
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193/jk Scroll  PgUp/PgDn  g/G Top/Bottom  Esc Back  q Quit", w))
  return L
}

function rAgents(w: number, h: number): string[] {
  const L: string[] = []
  L.push(hbar("Filter by Agent", w))
  L.push(statusLine())
  L.push("")

  const items = ["All agents", ...agents]
  for (let i = 0; i < items.length; i++) {
    const sel = i === cursor
    const label = items[i]
    const current = (i === 0 && !agentFilter) || (agentFilter === label) ? st(" \u2713", GREEN) : ""
    L.push(sel
      ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}${current}`
      : `    ${label}${current}`,
    )
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  Esc Back", w))
  return L
}

function rLlmCalls(w: number, h: number): string[] {
  const L: string[] = []
  const af = agentFilter ?? "all"
  const mf = modelFilter ?? "all"
  const rightInfo = `Agent: ${af} [A]  Model: ${mf} [M]  Sort: ${llmSortKey} [S]`
  const leftInfo = `LLM Calls (${filteredLlmCalls.length})`
  const gap = Math.max(2, w - leftInfo.length - rightInfo.length - 4)
  L.push(hbar(`${leftInfo}${" ".repeat(gap)}${rightInfo}`, w))
  L.push(statusLine())

  L.push(st(
    `   ${"AGENT".padEnd(12)} ${"MODEL".padEnd(22)} ${"DATE".padEnd(17)} ` +
    `${"DUR".padStart(6)} ${"IN_TOK".padStart(7)} ${"OUT_TOK".padStart(7)} ` +
    `${"CACHE_R".padStart(7)} ${"CACHE_W".padStart(7)} ${"COST".padStart(8)}  ${"STOP".padEnd(8)}`, DIM,
  ))
  L.push(st("  " + "\u2500".repeat(Math.min(w - 4, 116)), DIM))

  const headerH = L.length
  const footerH = 1
  const contentH = h - headerH - footerH

  if (cursor < scroll) scroll = cursor
  if (cursor >= scroll + contentH) scroll = cursor - contentH + 1

  if (filteredLlmCalls.length === 0) {
    L.push("")
    L.push(st("  No LLM calls found.", DIM))
  } else {
    for (let i = scroll; i < Math.min(filteredLlmCalls.length, scroll + contentH); i++) {
      L.push(llmCallRow(filteredLlmCalls[i], i === cursor, w))
    }
  }

  while (L.length < h - footerH) L.push("")
  L.push(fbar("\u2191\u2193/jk Navigate  Enter Select  A Agent  M Model  S Sort  Esc Back  q Quit", w))
  return L
}

function llmCallRow(ci: LlmCallInfo, sel: boolean, w: number): string {
  const pfx = sel ? st("\u25b8 ", CYAN, BOLD) : "  "
  const agent = (ci.agentId || "?").slice(0, 12).padEnd(12)
  const model = (ci.model || "?").slice(0, 22).padEnd(22)
  const dt = ci.timestamp
    ? new Date(ci.timestamp).toISOString().slice(5, 16).replace("T", " ")
    : "?"
  const date = dt.padEnd(17)
  const dur = fmtDuration(ci.durationMs).padStart(6)
  const inTok = humanTokens(ci.inputTokens).padStart(7)
  const outTok = humanTokens(ci.outputTokens).padStart(7)
  const cacheR = humanTokens(ci.cacheReadTokens).padStart(7)
  const cacheW = humanTokens(ci.cacheWriteTokens).padStart(7)

  const costVal = ci.cost ?? 0
  const costStr = fmtCost(costVal).padStart(8)
  const costC = costVal > 1 ? st(costStr, RED, BOLD)
    : costVal > 0.1 ? st(costStr, YELLOW)
    : costStr

  const stop = (ci.stopReason || "?").slice(0, 8).padEnd(8)
  const stopC = ci.stopReason === "stop" || ci.stopReason === "end_turn"
    ? st(stop, GREEN) : st(stop, RED)

  const row = `${pfx}${agent} ${model} ${date} ${dur} ${inTok} ${outTok} ${cacheR} ${cacheW} ${costC}  ${stopC}`
  return sel ? withBg(pad(row, w), BG_HIGHLIGHT) : row
}

function rLlmActions(w: number, h: number): string[] {
  const L: string[] = []
  const ci = selectedLlmCall!
  const costStr = ci.cost != null ? fmtCost(ci.cost) : "?"
  const dur = ci.durationMs != null ? `${(ci.durationMs / 1000).toFixed(1)}s` : "?"
  L.push(hbar(
    `${ci.agentId}  ${ci.model}  \u2502  ${dur}  \u2502  ` +
    `in:${humanTokens(ci.inputTokens)} out:${humanTokens(ci.outputTokens)}  \u2502  ${costStr}`, w,
  ))
  L.push(statusLine())
  L.push("")

  const actions = [...LLM_ACTIONS]
  // Add "Jump to Session" if we have a sessionId
  if (ci.sessionId) {
    actions.push(["session-jump", "Session", "Jump to parent session transcript"])
  }

  for (let i = 0; i < actions.length; i++) {
    const [, label, desc] = actions[i]
    const sel = i === cursor
    L.push(sel ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}` : `    ${label}`)
    L.push(`      ${st(desc, DIM)}`)
    L.push("")
  }

  // Details
  L.push(st("  Details:", BOLD))
  L.push(`    Agent: ${ci.agentId}`)
  L.push(`    Model: ${ci.model}`)
  L.push(`    Provider: ${ci.provider}`)
  if (ci.sessionId) L.push(`    Session: ${ci.sessionId.slice(0, 12)}...`)
  L.push(`    Tokens: in=${humanTokens(ci.inputTokens)} out=${humanTokens(ci.outputTokens)} cache_r=${humanTokens(ci.cacheReadTokens)} cache_w=${humanTokens(ci.cacheWriteTokens)}`)
  if (ci.toolNames.length > 0) L.push(`    Tools: ${ci.toolNames.join(", ")}`)
  L.push(`    Stop: ${ci.stopReason || "?"}`)

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  Esc Back  q Quit", w))
  return L
}

function rModels(w: number, h: number): string[] {
  const L: string[] = []
  L.push(hbar("Filter by Model", w))
  L.push(statusLine())
  L.push("")

  const items = ["All models", ...llmModels]
  for (let i = 0; i < items.length; i++) {
    const sel = i === cursor
    const label = items[i]
    const current = (i === 0 && !modelFilter) || (modelFilter === label) ? st(" \u2713", GREEN) : ""
    L.push(sel
      ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}${current}`
      : `    ${label}${current}`,
    )
  }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  Esc Back", w))
  return L
}

// ─── Key handlers ────────────────────────────────────────────────────────────

function onKey(key: Key) {
  if (key.name === "ctrl" && key.ch === "c") return cleanup()
  if (busy) {
    // Only allow escape to cancel during loading
    if (key.name === "escape") { stopSpinner(); errorMsg = "Cancelled"; pop(); render() }
    return
  }

  errorMsg = ""

  switch (screen) {
    case "instances":   return onInstancesKey(key)
    case "menu":        return onMenuKey(key)
    case "sessions":    return onSessionsKey(key)
    case "actions":     return onActionsKey(key)
    case "output":      return onOutputKey(key)
    case "agents":      return onAgentsKey(key)
    case "llm-calls":   return onLlmCallsKey(key)
    case "llm-actions": return onLlmActionsKey(key)
    case "models":      return onModelsKey(key)
  }
}

async function onInstancesKey(key: Key) {
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, instanceList.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, instanceList.length - 1)
  else if (key.name === "enter" && instanceList.length > 0) {
    cfg = withInstance(cfg, instanceList[cursor])
    startSpinner("Uploading debug script...")
    try {
      await uploadScript(cfg)
      stopSpinner()
      screen = "menu"
      cursor = 0
    } catch (e: any) {
      stopSpinner()
      errorMsg = `Upload failed: ${e.message}`
    }
  }
  else if (key.name === "escape" || (key.name === "char" && key.ch === "q")) return cleanup()
  render()
}

function onMenuKey(key: Key) {
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, MENU_ITEMS.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, MENU_ITEMS.length - 1)
  else if (key.name === "enter") {
    if (cursor === 0) doLoadSessions()
    else if (cursor === 1) doRunGlobal("summary")
    else if (cursor === 2) doLoadLlmCalls()
    else if (cursor === 3) doRunGlobal("llm-summary")
  }
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onSessionsKey(key: Key) {
  const len = filtered.length
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, len - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, len - 1)
  else if (key.name === "pageup") cursor = clamp(cursor - 10, len - 1)
  else if (key.name === "pagedown") cursor = clamp(cursor + 10, len - 1)
  else if (key.name === "home") cursor = 0
  else if (key.name === "end") cursor = Math.max(0, len - 1)
  else if (key.name === "enter" && len > 0) {
    selected = filtered[cursor]
    push("actions")
  }
  else if (key.name === "char" && key.ch.toLowerCase() === "a") push("agents")
  else if (key.name === "char" && key.ch.toLowerCase() === "s") {
    const idx = (SORTS.indexOf(sortKey) + 1) % SORTS.length
    sortKey = SORTS[idx]
    applyFilter()
  }
  else if (key.name === "char" && key.ch.toLowerCase() === "r") doLoadSessions()
  else if (key.name === "escape") pop()
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onActionsKey(key: Key) {
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, ACTIONS.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, ACTIONS.length - 1)
  else if (key.name === "enter") {
    const [cmd, label] = ACTIONS[cursor]
    doRunSession(cmd, label)
  }
  else if (key.name === "escape") pop()
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onLlmCallsKey(key: Key) {
  const len = filteredLlmCalls.length
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, len - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, len - 1)
  else if (key.name === "pageup") cursor = clamp(cursor - 10, len - 1)
  else if (key.name === "pagedown") cursor = clamp(cursor + 10, len - 1)
  else if (key.name === "home") cursor = 0
  else if (key.name === "end") cursor = Math.max(0, len - 1)
  else if (key.name === "enter" && len > 0) {
    selectedLlmCall = filteredLlmCalls[cursor]
    push("llm-actions")
  }
  else if (key.name === "char" && key.ch.toLowerCase() === "a") push("agents")
  else if (key.name === "char" && key.ch.toLowerCase() === "m") push("models")
  else if (key.name === "char" && key.ch.toLowerCase() === "s") {
    const idx = (LLM_SORTS.indexOf(llmSortKey) + 1) % LLM_SORTS.length
    llmSortKey = LLM_SORTS[idx]
    applyLlmFilter()
  }
  else if (key.name === "char" && key.ch.toLowerCase() === "r") doLoadLlmCalls()
  else if (key.name === "escape") pop()
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onLlmActionsKey(key: Key) {
  const ci = selectedLlmCall!
  const actions = [...LLM_ACTIONS]
  if (ci.sessionId) actions.push(["session-jump", "Session", "Jump to parent session transcript"])

  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, actions.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, actions.length - 1)
  else if (key.name === "enter") {
    const [cmd] = actions[cursor]
    if (cmd === "llm-trace" && ci.sessionId) {
      doRunLlmTrace(ci.sessionId, ci.agentId)
    } else if (cmd === "session-jump" && ci.sessionId) {
      doJumpToSession(ci.sessionId, ci.agentId)
    }
  }
  else if (key.name === "escape") pop()
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onModelsKey(key: Key) {
  const items = ["All models", ...llmModels]
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, items.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, items.length - 1)
  else if (key.name === "enter") {
    modelFilter = cursor === 0 ? null : items[cursor]
    applyLlmFilter()
    pop()
  }
  else if (key.name === "escape") pop()
  render()
}

function onOutputKey(key: Key) {
  const [, rows] = termSize()
  const pageSize = Math.max(1, rows - 3)
  const maxScroll = Math.max(0, outputLines.length - (rows - 3))
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    outputScroll = clamp(outputScroll - 3, maxScroll)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    outputScroll = clamp(outputScroll + 3, maxScroll)
  else if (key.name === "pageup") outputScroll = clamp(outputScroll - pageSize, maxScroll)
  else if (key.name === "pagedown") outputScroll = clamp(outputScroll + pageSize, maxScroll)
  else if (key.name === "home" || (key.name === "char" && key.ch === "g"))
    outputScroll = 0
  else if (key.name === "end" || (key.name === "char" && key.ch === "G"))
    outputScroll = maxScroll
  else if (key.name === "escape") pop()
  else if (key.name === "char" && key.ch === "q") return cleanup()
  render()
}

function onAgentsKey(key: Key) {
  const items = ["All agents", ...agents]
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, items.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, items.length - 1)
  else if (key.name === "enter") {
    agentFilter = cursor === 0 ? null : items[cursor]
    // Apply to whichever list the parent screen uses
    const parent = screenStack[screenStack.length - 1]
    if (parent === "llm-calls") applyLlmFilter()
    else applyFilter()
    pop()
  }
  else if (key.name === "escape") pop()
  render()
}

// ─── Async operations ────────────────────────────────────────────────────────

async function doLoadSessions() {
  startSpinner("Fetching sessions from VPS...")
  try {
    sessions = await fetchSessions(cfg)
    agents = [...new Set(sessions.map((s) => s.agent))].sort()
    applyFilter()
    stopSpinner()
    if (screen === "menu") push("sessions")
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = e.message
    render()
  }
}

async function doRunGlobal(subcmd: string) {
  startSpinner(`Running ${subcmd}...`)
  try {
    const out = await runCommand(cfg, subcmd)
    stopSpinner()
    outputLines = out.split("\n")
    outputScroll = 0
    outputTitle = subcmd.charAt(0).toUpperCase() + subcmd.slice(1)
    push("output")
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = e.message
    render()
  }
}

async function doRunSession(subcmd: string, label: string) {
  if (!selected) return
  startSpinner(`Running ${label} for ${selected.session_id.slice(0, 8)}...`)
  try {
    const out = await runCommand(cfg, subcmd, selected.session_id, selected.agent)
    stopSpinner()
    outputLines = out.split("\n")
    outputScroll = 0
    outputTitle = `${label}: ${selected.agent}/${selected.session_id.slice(0, 8)}`
    push("output")
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = e.message
    render()
  }
}

async function doLoadLlmCalls() {
  startSpinner("Fetching LLM calls from VPS...")
  try {
    llmCalls = await fetchLlmCalls(cfg)
    llmModels = [...new Set(llmCalls.map((c) => c.model).filter(Boolean))].sort()
    // Also populate agents list if not loaded yet
    const llmAgents = [...new Set(llmCalls.map((c) => c.agentId).filter(Boolean))].sort()
    if (agents.length === 0) agents = llmAgents
    applyLlmFilter()
    stopSpinner()
    if (screen === "menu") push("llm-calls")
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = e.message
    render()
  }
}

async function doRunLlmTrace(sessionId: string, agent?: string) {
  startSpinner(`Running LLM trace for ${sessionId.slice(0, 8)}...`)
  try {
    const out = await runCommand(cfg, "llm-trace", sessionId, agent || undefined)
    stopSpinner()
    outputLines = out.split("\n")
    outputScroll = 0
    outputTitle = `LLM Trace: ${sessionId.slice(0, 12)}`
    push("output")
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = e.message
    render()
  }
}

async function doJumpToSession(sessionId: string, agent: string) {
  // Find the session in our loaded sessions list, or load sessions first
  if (sessions.length === 0) {
    startSpinner("Loading sessions...")
    try {
      sessions = await fetchSessions(cfg)
      agents = [...new Set(sessions.map((s) => s.agent))].sort()
    } catch (e: any) {
      stopSpinner()
      errorMsg = e.message
      render()
      return
    }
    stopSpinner()
  }

  const match = sessions.find((s) => s.session_id.startsWith(sessionId.slice(0, 8)))
  if (match) {
    selected = match
    push("actions")
    render()
  } else {
    errorMsg = `Session ${sessionId.slice(0, 8)} not found`
    render()
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function cleanup() {
  stopSpinner()
  exitAltScreen()
  process.exit(0)
}

async function main() {
  // Load config
  try {
    cfg = loadConfig()
  } catch (e: any) {
    console.error(`Failed to load config: ${e.message}`)
    console.error("Ensure openclaw-config.env exists in the project root.")
    process.exit(1)
  }

  // Enter TUI
  enterAltScreen()

  // Handle resize
  process.stdout.on("resize", () => render())

  // Handle input
  process.stdin.on("data", (buf: Buffer) => onKey(parseKey(buf)))

  // Handle uncaught errors — always restore terminal
  process.on("uncaughtException", (e) => {
    exitAltScreen()
    console.error(e)
    process.exit(1)
  })

  // Initial render
  render()

  // Resolve instance: auto-select if pre-configured or single, otherwise show picker
  startSpinner("Connecting to VPS...")
  try {
    if (cfg.instance) {
      // Instance set via env/flag — go straight to menu
      cfg = withInstance(cfg, cfg.instance)
      await uploadScript(cfg)
      stopSpinner()
    } else {
      const found = await listInstances(cfg)
      if (found.length === 1) {
        cfg = withInstance(cfg, found[0])
        await uploadScript(cfg)
        stopSpinner()
      } else if (found.length === 0) {
        stopSpinner()
        errorMsg = `No claw instances found in ${cfg.installDir}/instances/`
      } else {
        // Multiple instances — show picker
        stopSpinner()
        instanceList = found
        screen = "instances"
        cursor = 0
      }
    }
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = `VPS connection failed: ${e.message}`
    render()
  }
}

main()
