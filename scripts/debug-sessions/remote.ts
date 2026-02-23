/**
 * SSH command execution and data layer.
 * Loads config from openclaw-config.env, runs commands on VPS via SSH.
 */

import { readFileSync } from "fs"
import { resolve, dirname } from "path"

export interface SessionInfo {
  agent: string
  session_id: string
  status: string
  size: number
  timestamp: string | null
  turns: number
  tool_calls: number
  errors: number
  cost: number
  stop_reason: string | null
  first_message: string
}

export interface LlmCallInfo {
  timestamp: string | null
  agentId: string
  sessionId: string
  sessionKey: string
  runId: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number | null
  durationMs: number | null
  stopReason: string
  toolNames: string[]
  toolCount: number | null
}

export interface Config {
  host: string
  port: string
  user: string
  keyPath: string
  pythonScript: string
  baseDir: string
  llmLogPath: string
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${process.env.HOME}${p.slice(1)}` : p
}

export function loadConfig(): Config {
  const scriptDir = dirname(Bun.main)
  const envPath = resolve(scriptDir, "../../openclaw-config.env")
  const content = readFileSync(envPath, "utf-8")
  const env: Record<string, string> = {}

  for (const line of content.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 0) continue
    let v = t.slice(eq + 1)
    if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))
      v = v.slice(1, -1)
    else {
      // Strip inline comments (only for unquoted values)
      const hashIdx = v.indexOf("#")
      if (hashIdx >= 0) v = v.slice(0, hashIdx)
      v = v.trim()
    }
    env[t.slice(0, eq)] = v
  }

  return {
    host: env.VPS1_IP ?? "",
    port: env.SSH_PORT ?? "222",
    user: env.SSH_USER ?? "adminclaw",
    keyPath: expandHome(env.SSH_KEY_PATH ?? "~/.ssh/vps1_openclaw_ed25519"),
    pythonScript: resolve(scriptDir, "debug-sessions.py"),
    baseDir: "/home/openclaw/.openclaw/agents",
    llmLogPath: "/home/openclaw/.openclaw/logs/llm.log",
  }
}

function sshBaseArgs(cfg: Config): string[] {
  return [
    "ssh", "-i", cfg.keyPath, "-p", cfg.port,
    "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
    `${cfg.user}@${cfg.host}`,
  ]
}

export async function sshExec(cfg: Config, cmd: string): Promise<string> {
  const proc = Bun.spawn([...sshBaseArgs(cfg), cmd], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) throw new Error(err.trim() || `SSH exit ${code}`)
  return out
}

export async function uploadScript(cfg: Config): Promise<void> {
  const proc = Bun.spawn([
    "scp", "-q", "-i", cfg.keyPath, "-P", cfg.port,
    "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
    cfg.pythonScript, `${cfg.user}@${cfg.host}:/tmp/debug-sessions.py`,
  ], { stdout: "pipe", stderr: "pipe" })
  const err = await new Response(proc.stderr).text()
  if (await proc.exited !== 0) throw new Error(err.trim() || "SCP upload failed")
}

function pyCmd(cfg: Config, subcmd: string, opts: string = ""): string {
  let extra = `--base-dir ${cfg.baseDir}`
  if (subcmd.startsWith("llm-")) extra += ` --llm-log ${cfg.llmLogPath}`
  return `sudo python3 /tmp/debug-sessions.py ${subcmd} ${opts} ${extra}`
}

export async function fetchSessions(cfg: Config): Promise<SessionInfo[]> {
  const out = await sshExec(cfg, pyCmd(cfg, "list", "--json"))
  return JSON.parse(out)
}

export async function fetchLlmCalls(cfg: Config): Promise<LlmCallInfo[]> {
  const out = await sshExec(cfg, pyCmd(cfg, "llm-list", "--json"))
  return JSON.parse(out)
}

export async function runCommand(
  cfg: Config,
  subcmd: string,
  sessionId?: string,
  agent?: string,
): Promise<string> {
  let opts = "--force-color"
  if (sessionId) opts = `${sessionId} ${opts}`
  if (agent) opts += ` --agent ${agent}`
  return sshExec(cfg, pyCmd(cfg, subcmd, opts))
}
