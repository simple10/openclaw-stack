/**
 * SSH command execution and data layer.
 * Loads config from .deploy/stack.json + .deploy/stack.env, runs commands on VPS via SSH.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'

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
  installDir: string
  instance: string
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? `${process.env.HOME}${p.slice(1)}` : p
}

function findRepoRoot(): string {
  let dir = dirname(Bun.main)
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.env')) && existsSync(resolve(dir, '.deploy'))) {
      return dir
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error('Could not find repo root (looking for .env + .deploy/)')
}

export function loadConfig(): Config {
  const scriptDir = dirname(Bun.main)
  const repoRoot = findRepoRoot()
  const stackJsonPath = resolve(repoRoot, '.deploy/stack.json')

  if (!existsSync(stackJsonPath)) {
    throw new Error(`stack.json not found at ${stackJsonPath}. Run 'npm run pre-deploy' first.`)
  }

  const stackConfig = JSON.parse(readFileSync(stackJsonPath, 'utf-8'))
  const stack = stackConfig.stack || {}
  const installDir = String(stack.install_dir || '/home/openclaw')

  // Read SSH config from stack.env (parsed by dotenv-style reading)
  const stackEnvPath = resolve(repoRoot, '.deploy/stack.env')
  const envVars: Record<string, string> = {}
  if (existsSync(stackEnvPath)) {
    for (const line of readFileSync(stackEnvPath, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      let v = t.slice(eq + 1)
      if ((v[0] === "'" && v.at(-1) === "'")) v = v.slice(1, -1)
      else if ((v[0] === '"' && v.at(-1) === '"')) v = v.slice(1, -1)
      envVars[t.slice(0, eq)] = v
    }
  }

  return {
    host: envVars.ENV__VPS_IP ?? '',
    port: envVars.ENV__SSH_PORT ?? '222',
    user: envVars.ENV__SSH_USER ?? 'adminclaw',
    keyPath: envVars.ENV__SSH_KEY ? expandHome(envVars.ENV__SSH_KEY) : '',
    identityAgent: envVars.ENV__SSH_IDENTITY_AGENT ? expandHome(envVars.ENV__SSH_IDENTITY_AGENT) : '',
    pythonScript: resolve(scriptDir, 'debug-sessions.py'),
    baseDir: '', // resolved by resolveInstance()
    llmLogPath: '', // resolved by resolveInstance()
    installDir,
    instance: process.env.OPENCLAW_INSTANCE || '',
  }
}

/** List instance directories on VPS without throwing on multiple results. */
export async function listInstances(cfg: Config): Promise<string[]> {
  // sudo: adminclaw can't traverse /home/openclaw (750 owned by openclaw)
  // grep -v '^\\.': exclude .shared-backups and other dotdirs
  const out = await sshExec(cfg, `sudo ls -1 ${cfg.installDir}/instances/ | grep -v '^\\.'`)
  return out.trim().split('\n').filter(Boolean)
}

/** Return a new config with instance paths set for the given claw name. */
export function withInstance(cfg: Config, instance: string): Config {
  const dir = `${cfg.installDir}/instances/${instance}/.openclaw`
  return { ...cfg, instance, baseDir: `${dir}/agents`, llmLogPath: `${dir}/logs/telemetry.log` }
}

export async function resolveInstance(cfg: Config): Promise<Config> {
  if (cfg.instance) return withInstance(cfg, cfg.instance)

  const instances = await listInstances(cfg)

  if (instances.length === 1) {
    return withInstance(cfg, instances[0])
  } else if (instances.length === 0) {
    throw new Error(`No claw instances found in ${cfg.installDir}/instances/`)
  } else {
    throw new Error(
      `Multiple claw instances found: ${instances.join(', ')}. ` +
        `Set OPENCLAW_INSTANCE or use --instance.`
    )
  }
}

function sshBaseArgs(cfg: Config): string[] {
  const args = [
    'ssh',
    '-p',
    cfg.port,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
  ]
  if (cfg.keyPath) args.push('-i', cfg.keyPath)
  if (cfg.identityAgent) args.push('-o', `IdentityAgent=${cfg.identityAgent}`)
  args.push(`${cfg.user}@${cfg.host}`)
  return args
}

export async function sshExec(cfg: Config, cmd: string): Promise<string> {
  const proc = Bun.spawn([...sshBaseArgs(cfg), cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
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
  const proc = Bun.spawn(
    [
      'scp',
      '-q',
      '-P',
      cfg.port,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      ...(cfg.keyPath ? ['-i', cfg.keyPath] : []),
      ...(cfg.identityAgent ? ['-o', `IdentityAgent=${cfg.identityAgent}`] : []),
      cfg.pythonScript,
      `${cfg.user}@${cfg.host}:/tmp/debug-sessions.py`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(err.trim() || 'SCP upload failed')
}

function pyCmd(cfg: Config, subcmd: string, opts: string = ''): string {
  let extra = `--base-dir ${cfg.baseDir}`
  if (subcmd.startsWith('llm-')) extra += ` --llm-log ${cfg.llmLogPath}`
  return `sudo python3 /tmp/debug-sessions.py ${subcmd} ${opts} ${extra}`
}

export async function fetchSessions(cfg: Config): Promise<SessionInfo[]> {
  const out = await sshExec(cfg, pyCmd(cfg, 'list', '--json'))
  return JSON.parse(out)
}

export async function fetchLlmCalls(cfg: Config): Promise<LlmCallInfo[]> {
  const out = await sshExec(cfg, pyCmd(cfg, 'llm-list', '--json'))
  return JSON.parse(out)
}

export async function runCommand(
  cfg: Config,
  subcmd: string,
  sessionId?: string,
  agent?: string
): Promise<string> {
  let opts = '--force-color'
  if (sessionId) opts = `${sessionId} ${opts}`
  if (agent) opts += ` --agent ${agent}`
  return sshExec(cfg, pyCmd(cfg, subcmd, opts))
}
