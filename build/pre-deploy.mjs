#!/usr/bin/env node
/**
 * pre-deploy.mjs — Build pipeline for OpenClaw stack deployment
 *
 * Reads .env + stack.yml + docker-compose.yml.hbs and produces
 * a fully-resolved .deploy/ directory ready to git-push to VPS.
 *
 * Usage:
 *   npm run pre-deploy          # Full build
 *   npm run pre-deploy:dry      # Dry run (show what would be generated)
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as yaml from "js-yaml";
import * as dotenv from "dotenv";
import Handlebars from "handlebars";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

// ── Constants ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEPLOY_DIR = join(ROOT, ".deploy");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Helpers ──────────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function info(msg) {
  console.log(`\x1b[36m→ ${msg}\x1b[0m`);
}

function success(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}

/** Read a file relative to project root */
function readRoot(path) {
  const full = join(ROOT, path);
  if (!existsSync(full)) fatal(`File not found: ${path}`);
  return readFileSync(full, "utf-8");
}

// ── Step 1: Read .env ────────────────────────────────────────────────────────

function readDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) fatal(".env not found. Run: cp .env.example .env");

  const parsed = dotenv.parse(readFileSync(envPath));
  return parsed;
}

// ── Step 2: Resolve ${VAR} in stack.yml ──────────────────────────────────────

function resolveEnvRefs(text, env) {
  // Process line-by-line to skip YAML comments
  return text.split("\n").map((line) => {
    // Skip comment lines (YAML comments start with optional whitespace + #)
    if (line.trimStart().startsWith("#")) return line;

    // Match ${VAR} and ${VAR:-default}
    return line.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
      const defaultMatch = expr.match(/^([^:]+):-(.*)$/);
      if (defaultMatch) {
        const key = defaultMatch[1];
        const defaultVal = defaultMatch[2];
        return env[key] !== undefined && env[key] !== "" ? env[key] : defaultVal;
      }
      const value = env[expr];
      if (value === undefined) {
        warn(`Unresolved env var: \${${expr}} (will be empty string)`);
        return "";
      }
      return value;
    });
  }).join("\n");
}

// ── Step 3: Deep merge ───────────────────────────────────────────────────────

function isPlainObject(val) {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Deep merge source into target. Source values win at any depth. */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ── Step 4: Resolve resource percentages ─────────────────────────────────────

function spawnAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

async function queryVpsCapacity(env) {
  const ip = env.VPS_IP;
  const user = env.SSH_USER || "adminclaw";
  const port = env.SSH_PORT || "222";
  const keyPath = env.SSH_KEY || "~/.ssh/vps1_openclaw_ed25519";

  if (!ip) fatal("VPS_IP not set in .env — cannot query VPS capacity for resource % resolution");

  const expandedKey = keyPath.replace(/^~/, process.env.HOME || "");
  info(`Querying VPS capacity at ${user}@${ip}:${port}...`);

  const sshArgs = [
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
    "-i", expandedKey, "-p", port, `${user}@${ip}`,
    "nproc && grep MemTotal /proc/meminfo | awk '{print $2}'"
  ];

  const { stdout, stderr, exitCode } = await spawnAsync("ssh", sshArgs);

  if (exitCode !== 0) {
    fatal(`SSH to VPS failed (exit ${exitCode}): ${stderr.trim()}\nCannot resolve resource percentages.`);
  }

  const lines = stdout.trim().split("\n");
  const cpus = parseInt(lines[0] ?? "", 10);
  const memKb = parseInt(lines[1] ?? "", 10);
  const memMb = Math.floor(memKb / 1024);

  success(`VPS capacity: ${cpus} CPUs, ${memMb} MB memory`);
  return { cpus, memory_mb: memMb };
}

function parseMemoryValue(val) {
  const str = String(val).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(G|M|GB|MB|g|m|gb|mb)?$/i);
  if (!match) fatal(`Invalid memory value: ${val}`);
  const num = parseFloat(match[1]);
  const unit = (match[2] || "M").toUpperCase().replace("B", "");
  const mb = unit === "G" ? Math.floor(num * 1024) : Math.floor(num);
  return { mb, original: str };
}

function formatMemory(mb) {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}G`;
  return `${mb}M`;
}

async function resolveStackResources(stackResources, env) {
  const maxCpu = String(stackResources?.max_cpu || "100%");
  const maxMem = String(stackResources?.max_mem || "100%");

  const needsVps = maxCpu.includes("%") || maxMem.includes("%");
  let capacity = null;

  if (needsVps) {
    capacity = await queryVpsCapacity(env);
  }

  let resolvedCpu;
  if (maxCpu.endsWith("%")) {
    const pct = parseInt(maxCpu, 10) / 100;
    resolvedCpu = Math.floor(capacity.cpus * pct);
  } else {
    resolvedCpu = parseInt(maxCpu, 10);
  }

  let resolvedMemMb;
  if (maxMem.endsWith("%")) {
    const pct = parseInt(maxMem, 10) / 100;
    resolvedMemMb = Math.floor(capacity.memory_mb * pct);
  } else {
    resolvedMemMb = parseMemoryValue(maxMem).mb;
  }

  success(`Stack resource budget: ${resolvedCpu} CPUs, ${formatMemory(resolvedMemMb)} memory`);
  return { max_cpu: resolvedCpu, max_mem_mb: resolvedMemMb };
}

// ── Step 5: Parse JSONC (JSON with Comments) ─────────────────────────────────

function parseJsoncFile(text, filePath) {
  const errors = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const errorMsgs = errors.map(e => `  offset ${e.offset}: ${printParseErrorCode(e.error)}`).join("\n");
    fatal(`JSONC parse errors in ${filePath}:\n${errorMsgs}`);
  }
  return result;
}

// ── Step 6: Validate required fields ─────────────────────────────────────────

function validateClaw(name, claw) {
  const required = ["domain", "gateway_port", "dashboard_port"];
  for (const field of required) {
    if (claw[field] === undefined || claw[field] === "") {
      fatal(`Claw '${name}' is missing required field: ${field}`);
    }
  }

  const telegram = claw.telegram;
  if (!telegram?.bot_token) {
    warn(`Claw '${name}' has no telegram.bot_token — Telegram will be disabled`);
  }
}

// ── Step 7: Compute derived values per claw ──────────────────────────────────
// Pre-computes all values the Handlebars template needs so the template
// is a pure data projection with no inline logic.

function computeDerivedValues(claws, stack, host) {
  const logUrl = stack.logging?.worker_url || "";
  const logToken = stack.logging?.worker_token || "";

  // Stack-level derived values
  stack.vector = !!stack.logging?.vector;

  for (const claw of Object.values(claws)) {
    const gwUrl = claw.ai_gateway?.url || stack.ai_gateway.url;
    const gwToken = claw.ai_gateway?.token || stack.ai_gateway.token;

    claw.gateway_token = claw.gateway_token || randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    claw.anthropic_api_key = gwToken;
    claw.anthropic_base_url = gwUrl + "/anthropic";
    claw.openai_api_key = gwToken;
    claw.openai_base_url = gwUrl + "/openai/v1";
    claw.openai_codex_base_url = gwUrl + "/openai-codex";
    claw.allowed_origin = "https://" + claw.domain;
    claw.vps_hostname = host.hostname || "";
    claw.log_worker_url = logUrl;
    claw.log_worker_token = logToken;
    claw.events_url = logUrl ? logUrl + "/openclaw/events" : "";
    claw.llemtry_url = logUrl ? logUrl + "/llemtry" : "";
    claw.enable_events_logging = stack.logging?.events || false;
    claw.enable_llemtry_logging = stack.logging?.llemtry || false;
  }
}

// ── Step 8: Collect envsubst whitelist ────────────────────────────────────────
// These are the $VAR references used in openclaw.jsonc that entrypoint resolves at container startup.

const ENVSUBST_VARS = [
  "OPENCLAW_DOMAIN_PATH",
  "OPENCLAW_ALLOWED_ORIGIN",
  "OPENCLAW_INSTANCE_ID",
  "VPS_HOSTNAME",
  "LOG_WORKER_TOKEN",
  "EVENTS_URL",
  "LLEMTRY_URL",
  "ENABLE_EVENTS_LOGGING",
  "ENABLE_LLEMTRY_LOGGING",
  "ADMIN_TELEGRAM_ID",
];

// ── Step 8b: Parse human-readable time → cron expression + IANA timezone ─────

const TZ_ABBREVIATIONS = {
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  EST: "America/New_York", EDT: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver",
  UTC: "UTC", GMT: "Europe/London",
  CET: "Europe/Berlin", CEST: "Europe/Berlin",
};

function parseDailyReportTime(timeStr) {
  const fallback = { cronExpr: "30 9 * * *", ianaTz: "America/Los_Angeles" };
  if (!timeStr) return fallback;

  const match = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*(\w+)$/i);
  if (!match) {
    warn(`Could not parse daily_report time "${timeStr}" — using default 9:30 AM PST`);
    return fallback;
  }

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3].toUpperCase();
  const tzAbbr = match[4].toUpperCase();

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  const ianaTz = TZ_ABBREVIATIONS[tzAbbr];
  if (!ianaTz) {
    warn(`Unknown timezone abbreviation "${match[4]}" — using America/Los_Angeles`);
    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: "America/Los_Angeles" };
  }

  return { cronExpr: `${minute} ${hour} * * *`, ianaTz };
}

// ── Step 9: Generate stack.env ───────────────────────────────────────────────
// Bash-sourceable key=value file for shell scripts.
// Convention: ENV__<key> for .env vars, STACK__<path> for stack.yml vars.

function formatEnvValue(val) {
  const s = String(val ?? "");
  if (s === "") return "";
  if (/[\s'"\\$`!#&|;()<>{}]/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

function generateStackEnv(env, config, claws) {
  const lines = [
    "# Generated by pre-deploy — DO NOT EDIT",
    "# To regenerate: npm run pre-deploy",
    "",
  ];

  // Source: .env
  const envVars = [
    "VPS_IP", "SSH_KEY", "SSH_PORT", "SSH_USER",
    "HOSTALERT_TELEGRAM_BOT_TOKEN", "HOSTALERT_TELEGRAM_CHAT_ID",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN",
  ];
  lines.push("# Source: .env");
  for (const key of envVars) {
    if (env[key] !== undefined) {
      lines.push(`ENV__${key}=${formatEnvValue(env[key])}`);
    }
  }
  lines.push("");

  const stack = config.stack || {};
  const host = config.host || {};

  // Source: stack.yml → host
  lines.push("# Source: stack.yml → host");
  if (host.hostname) lines.push(`STACK__HOST__HOSTNAME=${formatEnvValue(host.hostname)}`);
  lines.push("");

  // Source: stack.yml → stack
  const installDir = String(stack.install_dir || "/home/openclaw");
  const projectName = String(stack.project_name || "openclaw-stack");
  lines.push("# Source: stack.yml → stack");
  lines.push(`STACK__STACK__INSTALL_DIR=${formatEnvValue(installDir)}`);
  lines.push(`STACK__STACK__PROJECT_NAME=${formatEnvValue(projectName)}`);
  lines.push(`STACK__STACK__LOGGING__VECTOR=${stack.logging?.vector ?? false}`);
  if (stack.openclaw?.version) {
    lines.push(`STACK__STACK__OPENCLAW__VERSION=${formatEnvValue(stack.openclaw.version)}`);
  }
  if (stack.openclaw?.source) {
    lines.push(`STACK__STACK__OPENCLAW__SOURCE=${formatEnvValue(stack.openclaw.source)}`);
  }
  if (stack.sandbox_toolkit) {
    lines.push(`STACK__STACK__SANDBOX_TOOLKIT=${formatEnvValue(stack.sandbox_toolkit)}`);
  }
  lines.push("");

  // Derived
  lines.push("# Derived");
  lines.push(`STACK__STACK__INSTANCES_DIR=${formatEnvValue(installDir + "/instances")}`);
  lines.push(`STACK__STACK__IMAGE=${formatEnvValue("openclaw-" + projectName + ":local")}`);
  lines.push(`STACK__CLAWS__IDS=${formatEnvValue(Object.keys(claws).join(","))}`);
  lines.push("");

  // Derived: host alerter schedule
  const hostAlerter = (config.host || {}).host_alerter || {};
  const schedule = parseDailyReportTime(hostAlerter.daily_report);
  lines.push("# Derived: host alerter schedule");
  lines.push(`STACK__HOST__HOSTALERT__CRON_EXPR=${formatEnvValue(schedule.cronExpr)}`);
  lines.push(`STACK__HOST__HOSTALERT__CRON_TZ=${formatEnvValue(schedule.ianaTz)}`);
  lines.push("");

  // Per-claw (merged with defaults)
  lines.push("# Per-claw (merged with defaults)");
  for (const [name, claw] of Object.entries(claws)) {
    const envKey = name.replace(/-/g, "_").toUpperCase();
    lines.push(`STACK__CLAWS__${envKey}__DOMAIN=${formatEnvValue(claw.domain || "")}`);
    lines.push(`STACK__CLAWS__${envKey}__DASHBOARD_PATH=${formatEnvValue(claw.dashboard_path || "")}`);
    lines.push(`STACK__CLAWS__${envKey}__GATEWAY_PORT=${claw.gateway_port || ""}`);
    lines.push(`STACK__CLAWS__${envKey}__DASHBOARD_PORT=${claw.dashboard_port || ""}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mOpenClaw Pre-Deploy Build\x1b[0m\n");

  // 1. Read .env
  info("Reading .env...");
  const env = readDotEnv();
  success(`.env loaded (${Object.keys(env).length} vars)`);

  // 2. Read and resolve stack.yml
  info("Reading stack.yml...");
  const stackRaw = readRoot("stack.yml");
  const stackResolved = resolveEnvRefs(stackRaw, env);
  const config = yaml.load(stackResolved);

  if (!config.stack) fatal("stack.yml missing 'stack' section");
  if (!config.claws || Object.keys(config.claws).length === 0) fatal("stack.yml has no claws defined");

  const stack = config.stack;
  const host = config.host || {};
  const defaults = config.defaults || {};
  const clawsRaw = config.claws;

  success(`stack.yml loaded: ${Object.keys(clawsRaw).length} claw(s)`);

  // 3. Deep merge defaults into each claw
  info("Merging defaults into claws...");
  const claws = {};
  for (const [name, clawConfig] of Object.entries(clawsRaw)) {
    const merged = deepMerge(defaults, clawConfig ?? {});
    claws[name] = merged;
    validateClaw(name, merged);
  }
  success("Claws merged and validated");

  // 4. Resolve resource percentages
  const resolvedResources = await resolveStackResources(stack.resources || {}, env);
  stack.resources.max_cpu = resolvedResources.max_cpu;
  stack.resources.max_mem = formatMemory(resolvedResources.max_mem_mb);

  // 5. Compute derived values for template
  info("Computing derived values...");
  computeDerivedValues(claws, stack, host);
  success("Derived values computed");

  // 6. Compile and render Handlebars template
  const templatePath = stack.compose_template || "docker-compose.yml.hbs";
  info(`Rendering compose template: ${templatePath}...`);
  const templateSrc = readRoot(templatePath);
  const template = Handlebars.compile(templateSrc, { noEscape: true });
  const composeFinal = template({ stack, host, claws, env });
  success("Compose template rendered");

  if (DRY_RUN) {
    console.log("\n\x1b[1m── Rendered docker-compose.yml ──\x1b[0m\n");
    console.log(composeFinal);
    console.log("\n\x1b[1m── Claws (merged + derived) ──\x1b[0m\n");
    console.log(yaml.dump(claws, { lineWidth: 120 }));
    console.log("\n\x1b[1m── stack.env ──\x1b[0m\n");
    console.log(generateStackEnv(env, config, claws));
    console.log("\x1b[33mDry run — no files written.\x1b[0m\n");
    return;
  }

  // 7. Create .deploy/ directory
  info("Building .deploy/ directory...");

  if (existsSync(DEPLOY_DIR)) {
    rmSync(DEPLOY_DIR, { recursive: true, force: true });
  }
  mkdirSync(DEPLOY_DIR, { recursive: true });

  // 7a. Write docker-compose.yml
  writeFileSync(join(DEPLOY_DIR, "docker-compose.yml"), composeFinal);
  success("Wrote docker-compose.yml");

  // 7b. Write resolved stack config as JSON (consumed by VPS scripts)
  writeFileSync(join(DEPLOY_DIR, "stack.json"), JSON.stringify(config, null, 2) + "\n");
  success("Wrote stack.json");

  // 7c. Write stack.env (bash-sourceable config for shell scripts)
  writeFileSync(join(DEPLOY_DIR, "stack.env"), generateStackEnv(env, config, claws));
  success("Wrote stack.env");

  // 7d. Copy deploy/ subdirectories → .deploy/ (mirrors VPS INSTALL_DIR)
  // Three tiers: openclaw-stack/ (container), host/ (cron/host scripts), setup/ (deploy-time)
  const deployDirs = ["openclaw-stack", "host", "setup"];
  for (const dir of deployDirs) {
    const src = join(ROOT, "deploy", dir);
    if (existsSync(src)) {
      cpSync(src, join(DEPLOY_DIR, dir), { recursive: true });
      success(`Copied ${dir}/`);
    } else {
      warn(`Deploy directory not found: deploy/${dir} (skipping)`);
    }
  }

  // 7d-post. Resolve {{INSTALL_DIR}} in host/ files (cron configs, logrotate)
  const installDir = String(stack.install_dir || "/home/openclaw");
  const hostDir = join(DEPLOY_DIR, "host");
  if (existsSync(hostDir)) {
    for (const file of readdirSync(hostDir)) {
      const filePath = join(hostDir, file);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      const content = readFileSync(filePath, "utf-8");
      if (content.includes("{{INSTALL_DIR}}")) {
        writeFileSync(filePath, content.replaceAll("{{INSTALL_DIR}}", installDir));
      }
    }
  }

  // 7e. Copy sandbox toolkit into openclaw-stack/ (only if configured in stack.yml)
  if (stack.sandbox_toolkit) {
    const toolkitPath = String(stack.sandbox_toolkit);
    const toolkitSrc = join(ROOT, toolkitPath);
    if (!existsSync(toolkitSrc)) fatal(`Sandbox toolkit not found: ${toolkitPath}`);
    cpSync(toolkitSrc, join(DEPLOY_DIR, "openclaw-stack", "sandbox-toolkit.yaml"));
    success(`Copied sandbox toolkit (from ${toolkitPath})`);
  } else {
    info("No sandbox_toolkit configured — sandboxes will build without extra tools");
  }

  // 7f. Copy vector config if logging enabled
  if (stack.vector) {
    const vectorSrc = join(ROOT, "deploy", "vector");
    if (existsSync(vectorSrc)) {
      cpSync(vectorSrc, join(DEPLOY_DIR, "vector"), { recursive: true });
      success("Copied vector/");
    }
  }

  // 7g. Copy egress-proxy if configured
  if (stack.egress_proxy) {
    const egressSrc = join(ROOT, "egress-proxy");
    if (existsSync(egressSrc)) {
      cpSync(egressSrc, join(DEPLOY_DIR, "egress-proxy"), { recursive: true });
      success("Copied egress-proxy/");
    } else {
      fatal("stack.egress_proxy is configured but egress-proxy/ directory not found");
    }
  }

  // 7h. Process openclaw.jsonc for each claw → .deploy/instances/<name>/.openclaw/openclaw.json
  // Output mirrors VPS layout so sync-deploy.sh can rsync directly.
  for (const [name, claw] of Object.entries(claws)) {
    const templateFile = claw.openclaw_json || "openclaw/default/openclaw.jsonc";
    info(`Processing openclaw config for ${name} (from ${templateFile})...`);

    const raw = readRoot(templateFile);
    // Parse JSONC to validate and strip comments, then re-serialize as clean JSON
    const parsed = parseJsoncFile(raw, templateFile);
    const cleanJson = JSON.stringify(parsed, null, 2);

    const outDir = join(DEPLOY_DIR, "instances", name, ".openclaw");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "openclaw.json"), cleanJson + "\n");
    success(`Wrote instances/${name}/.openclaw/openclaw.json`);
  }

  // Summary
  console.log(`\n\x1b[32m\x1b[1mBuild complete!\x1b[0m`);
  console.log(`  Output:   ${DEPLOY_DIR}`);
  console.log(`  Claws:    ${Object.keys(claws).join(", ")}`);
  console.log(`  Template: ${templatePath}`);
  console.log(`\n  Next: scripts/sync-deploy.sh [--all]\n`);
}

main().catch((e) => {
  fatal(`Unexpected error: ${e.message}`);
});
