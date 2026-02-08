export interface Config {
  VPS1_IP: string
  SSH_KEY_PATH: string
  SSH_USER: string
  SSH_PORT: string
  OPENCLAW_DOMAIN: string
  // Optional fields accessed via get()
  [key: string]: string
}

export type VpsTarget = 'vps1'

export interface CheckResult {
  name: string
  target: VpsTarget
  ok: boolean
  detail: string
}

export interface SshResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}
