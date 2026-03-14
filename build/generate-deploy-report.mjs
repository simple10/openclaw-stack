#!/usr/bin/env node
// generate-deploy-report.mjs — Render the deployment report from stack.json + .env
//
// Usage:
//   node build/generate-deploy-report.mjs                  # Print to stdout
//   node build/generate-deploy-report.mjs --save           # Save to .deploy/report.md
//   node build/generate-deploy-report.mjs --save --print   # Both
//
// Reads: .deploy/stack.json, .env, build/templates/deploy-report.md.hbs
// Requires: VPS SSH access for gateway tokens (falls back to "see container env" if unavailable)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import Handlebars from 'handlebars'
import dotenv from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
const SAVE = args.includes('--save')
const PRINT = args.includes('--print') || !SAVE // default to print if not saving

// ── Load inputs ──────────────────────────────────────────────────────────────

function readJson(path) {
  const full = join(ROOT, path)
  if (!existsSync(full)) {
    console.error(`Error: ${path} not found. Run "npm run pre-deploy" first.`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(full, 'utf-8'))
}

// Load .env (quiet — suppress "injecting env" log)
dotenv.config({ path: join(ROOT, '.env'), quiet: true })
const env = process.env

// Load stack.json (built by pre-deploy)
const deploy = readJson('.deploy/stack.json')
const { host, stack, claws } = deploy

// ── Resolve gateway tokens from VPS ──────────────────────────────────────────

function getGatewayTokens() {
  const sshKey = env.SSH_KEY || '~/.ssh/vps1_openclaw_ed25519'
  const sshPort = env.SSH_PORT || '222'
  const sshUser = env.SSH_USER || 'adminclaw'
  const vpsIp = env.VPS_IP

  if (!vpsIp) return {}

  const tokens = {}
  for (const name of Object.keys(claws)) {
    const containerName = `${stack.project_name}-openclaw-${name}`
    try {
      const token = execSync(
        `ssh -i ${sshKey} -p ${sshPort} -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshUser}@${vpsIp} "sudo docker exec --user node ${containerName} printenv OPENCLAW_GATEWAY_TOKEN 2>/dev/null"`,
        { encoding: 'utf-8', timeout: 15000 }
      ).trim()
      if (token) tokens[name] = token
    } catch {
      // Container might not be running
    }
  }
  return tokens
}

let gatewayTokens = {}
try {
  gatewayTokens = getGatewayTokens()
} catch {
  // SSH unavailable — tokens will show placeholder
}

// ── Build template context ───────────────────────────────────────────────────

const alerterActive = !!(env.HOSTALERT_TELEGRAM_BOT_TOKEN && env.HOSTALERT_TELEGRAM_CHAT_ID)
const autoUpdateEnabled = stack.openclaw?.auto_update === true

const clawList = Object.entries(claws).map(([name, claw]) => ({
  name,
  domain: claw.domain || '',
  domain_path: claw.domain_path || '',
  dashboard_path: claw.dashboard_path || '/dashboard',
  gateway_token: gatewayTokens[name] || '<run report with VPS access to retrieve>',
}))

const context = {
  date: new Date().toISOString().split('T')[0],
  vps_ip: env.VPS_IP || '<VPS_IP>',
  hostname: host?.hostname || '<hostname>',
  ssh_key: env.SSH_KEY || '~/.ssh/vps1_openclaw_ed25519',
  ssh_port: env.SSH_PORT || '222',
  adminclaw_password: env.ADMINCLAW_PASSWORD || '<not set>',
  openclaw_password: env.OPENCLAW_PASSWORD || '<not set>',
  claws: clawList,
  ai_gateway_url: stack.ai_gateway?.url || '<not configured>',
  ai_gateway_token: stack.ai_gateway?.token || env.AI_WORKER_ADMIN_AUTH_TOKEN || '<not set>',
  log_worker_url: stack.logging?.worker_url || '<not configured>',
  log_worker_token: stack.logging?.worker_token || '<not set>',
  logging_llmetry: stack.logging?.llmetry ?? false,
  egress_proxy_url: stack.egress_proxy?.port ? `https://proxy.${host?.hostname || 'openclaw'}.com` : '',
  egress_proxy_token: stack.egress_proxy?.auth_token || '<not set>',
  ai_proxy_configured: false, // Can't detect from config alone — always show as unconfigured
  alerter_active: alerterActive,
  alerter_status: alerterActive ? 'Active' : 'Not configured',
  daily_report_time: host?.host_alerter?.daily_report || '9:30 AM PST',
  auto_update_time: stack.openclaw?.auto_update_time || '3:00 AM PST',
  auto_update_status: autoUpdateEnabled ? 'Active' : 'Disabled',
}

// ── Render template ──────────────────────────────────────────────────────────

const templatePath = join(__dirname, 'templates', 'deploy-report.md.hbs')
const templateSrc = readFileSync(templatePath, 'utf-8')
const template = Handlebars.compile(templateSrc, { noEscape: true })
const report = template(context)

// ── Output ───────────────────────────────────────────────────────────────────

if (PRINT) {
  process.stdout.write(report)
}

if (SAVE) {
  const reportPath = join(ROOT, '.deploy', 'report.md')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, report)
  console.error(`\nDeployment report saved to: .deploy/report.md`)
}
