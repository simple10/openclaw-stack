#!/usr/bin/env bun
/**
 * Interactive TUI for OpenClaw session debug & analytics.
 * Run: bun scripts/debug-sessions/main.ts
 */

import {
  enterAltScreen, exitAltScreen, termSize, renderFrame, parseKey,
  st, pad, stripAnsi,
  RESET, BOLD, DIM, INVERT, RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA, GRAY,
  type Key,
} from "./terminal"
import {
  loadConfig, uploadScript, fetchSessions, runCommand,
  type SessionInfo, type Config,
} from "./remote"

// ─── Constants ───────────────────────────────────────────────────────────────

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("")

const MENU_ITEMS: [string, string][] = [
  ["Sessions", "Browse and explore session transcripts"],
  ["Agent Summary", "Aggregate stats across agents"],
]

const ACTIONS: [cmd: string, label: string, desc: string][] = [
  ["trace", "Trace", "Step-by-step execution trace"],
  ["metrics", "Metrics", "Token/cost breakdown and charts"],
  ["errors", "Errors", "Extract and categorize errors"],
]

type Sort = "date" | "cost" | "errors" | "size" | "turns"
const SORTS: Sort[] = ["date", "cost", "errors", "size", "turns"]

type Screen = "menu" | "sessions" | "actions" | "output" | "agents"

// ─── State ───────────────────────────────────────────────────────────────────

let cfg: Config
let screen: Screen = "menu"
let cursor = 0
let scroll = 0
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

function hbar(text: string, w: number) { return st(pad(` ${text}`, w), BOLD, INVERT) }
function fbar(text: string, w: number) { return st(pad(` ${text}`, w), DIM, INVERT) }

// ─── Screen renderers ────────────────────────────────────────────────────────

function render() {
  const [cols, rows] = termSize()
  let lines: string[]
  switch (screen) {
    case "menu":     lines = rMenu(cols, rows); break
    case "sessions": lines = rSessions(cols, rows); break
    case "actions":  lines = rActions(cols, rows); break
    case "output":   lines = rOutput(cols, rows); break
    case "agents":   lines = rAgents(cols, rows); break
  }
  renderFrame(lines, cols, rows)
}

function rMenu(w: number, h: number): string[] {
  const L: string[] = []
  L.push(hbar("OpenClaw Session Debug", w))
  L.push(st(`  VPS: ${cfg.host}`, DIM))
  L.push("")

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const [label, desc] = MENU_ITEMS[i]
    const sel = i === cursor
    L.push(sel ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}` : `    ${label}`)
    L.push(`      ${st(desc, DIM)}`)
    L.push("")
  }

  if (loadingMsg) L.push(`  ${st(SPINNER[spinFrame], CYAN)} ${loadingMsg}`)
  if (errorMsg) { L.push(""); L.push(st(`  ${errorMsg}`, RED)) }

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
      L.push(sessionRow(filtered[i], i === cursor))
    }
  }

  if (loadingMsg) L.push(`  ${st(SPINNER[spinFrame], CYAN)} ${loadingMsg}`)

  while (L.length < h - footerH) L.push("")
  L.push(fbar("\u2191\u2193/jk Navigate  Enter Select  A Agent  S Sort  Esc Back  q Quit", w))
  return L
}

function sessionRow(si: SessionInfo, sel: boolean): string {
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

  return `${pfx}${agent} ${sid} ${date} ${size} ${turns} ${errs} ${cost}  ${stopC}${mark}`
}

function rActions(w: number, h: number): string[] {
  const L: string[] = []
  const si = selected!
  L.push(hbar(
    `${si.agent}/${si.session_id.slice(0, 8)}  \u2502  ` +
    `${si.turns} turns  \u2502  ${si.errors} errors  \u2502  ${fmtCost(si.cost)}`, w,
  ))
  L.push("")

  for (let i = 0; i < ACTIONS.length; i++) {
    const [, label, desc] = ACTIONS[i]
    const sel = i === cursor
    L.push(sel ? `  ${st("\u25b8", CYAN, BOLD)} ${st(label, BOLD, CYAN)}` : `    ${label}`)
    L.push(`      ${st(desc, DIM)}`)
    L.push("")
  }

  if (loadingMsg) L.push(`  ${st(SPINNER[spinFrame], CYAN)} ${loadingMsg}`)
  if (errorMsg) { L.push(""); L.push(st(`  ${errorMsg}`, RED)) }

  while (L.length < h - 1) L.push("")
  L.push(fbar("\u2191\u2193 Navigate  Enter Select  Esc Back  q Quit", w))
  return L
}

function rOutput(w: number, h: number): string[] {
  const L: string[] = []
  const total = outputLines.length
  const pos = total > 0 ? `Line ${outputScroll + 1}\u2013${Math.min(outputScroll + h - 2, total)}/${total}` : ""
  L.push(hbar(`${outputTitle}${" ".repeat(Math.max(2, w - outputTitle.length - pos.length - 4))}${pos}`, w))

  const contentH = h - 2 // header + footer
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
    case "menu":     return onMenuKey(key)
    case "sessions": return onSessionsKey(key)
    case "actions":  return onActionsKey(key)
    case "output":   return onOutputKey(key)
    case "agents":   return onAgentsKey(key)
  }
}

function onMenuKey(key: Key) {
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    cursor = clamp(cursor - 1, MENU_ITEMS.length - 1)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    cursor = clamp(cursor + 1, MENU_ITEMS.length - 1)
  else if (key.name === "enter") {
    if (cursor === 0) doLoadSessions()
    else if (cursor === 1) doRunGlobal("summary")
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

function onOutputKey(key: Key) {
  const maxScroll = Math.max(0, outputLines.length - (termSize()[1] - 2))
  if (key.name === "up" || (key.name === "char" && key.ch === "k"))
    outputScroll = clamp(outputScroll - 1, maxScroll)
  else if (key.name === "down" || (key.name === "char" && key.ch === "j"))
    outputScroll = clamp(outputScroll + 1, maxScroll)
  else if (key.name === "pageup") outputScroll = clamp(outputScroll - 20, maxScroll)
  else if (key.name === "pagedown") outputScroll = clamp(outputScroll + 20, maxScroll)
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
    applyFilter()
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

  // Upload Python script in background, then show menu
  startSpinner("Connecting to VPS...")
  try {
    await uploadScript(cfg)
    stopSpinner()
    render()
  } catch (e: any) {
    stopSpinner()
    errorMsg = `VPS connection failed: ${e.message}`
    render()
  }
}

main()
