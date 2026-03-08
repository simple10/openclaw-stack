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

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, statSync, renameSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";
import { randomUUID, randomBytes } from "crypto";
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

/** Load previous .deploy/stack.json for caching auto-generated values across builds. */
function loadPreviousDeploy() {
  const prev = join(DEPLOY_DIR, "stack.json");
  if (!existsSync(prev)) return null;
  try {
    return JSON.parse(readFileSync(prev, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Resolve an auto-generated token: explicit value > cached from previous build > new random.
 * Tokens resolved this way persist in stack.json between builds, so they remain stable
 * across `npm run pre-deploy` runs without requiring the user to set them in .env.
 */
function resolveAutoToken(value, cachePath, previousDeploy) {
  if (value) return value;
  // Walk dot-separated path into previous deploy config
  let cached = previousDeploy;
  for (const key of cachePath.split(".")) {
    cached = cached?.[key];
  }
  if (cached) return cached;
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

// ── Protected Vars ───────────────────────────────────────────────────────────
// Secrets auto-generated into .env when not already set.
// Resolution order: .env > generate.

const PROTECTED_VARS = {
  ADMINCLAW_PASSWORD: () => randomBytes(18).toString("base64"),
  OPENCLAW_PASSWORD: () => randomBytes(18).toString("base64"),
  AI_WORKER_ADMIN_AUTH_TOKEN: () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
};

const AUTO_GENERATED_HEADER = "# ── Auto-generated (managed by pre-deploy — do not edit above this line) ──";

/** Upsert auto-generated vars into .env under the auto-generated section. */
function appendToEnv(vars) {
  const envPath = join(ROOT, ".env");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  // Split into user section and auto-generated section
  const headerIdx = content.indexOf(AUTO_GENERATED_HEADER);
  let userSection = headerIdx >= 0 ? content.slice(0, headerIdx) : content;
  let autoSection = headerIdx >= 0 ? content.slice(headerIdx + AUTO_GENERATED_HEADER.length) : "";

  // Parse existing auto-generated vars
  const autoVars = autoSection ? dotenv.parse(autoSection) : {};

  // Merge new vars (new values win)
  Object.assign(autoVars, vars);

  // Rebuild auto-generated section
  const autoLines = [AUTO_GENERATED_HEADER, ""];
  for (const [key, val] of Object.entries(autoVars)) {
    autoLines.push(`${key}=${val}`);
  }

  // Ensure user section ends with a newline
  if (userSection.length > 0 && !userSection.endsWith("\n")) {
    userSection += "\n";
  }

  writeFileSync(envPath, userSection + autoLines.join("\n") + "\n");
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
  if (telegram?.enabled && !telegram?.bot_token) {
    warn(`Claw '${name}' has telegram.enabled: true but no bot_token — Telegram may not work without a token (env var fallback allowed)`);
  }

  const matrix = claw.matrix;
  if (matrix?.enabled) {
    if (!matrix.homeserver) {
      fatal(`Claw '${name}' has matrix.enabled: true but matrix.homeserver is not set`);
    }
    if (!matrix.access_token) {
      fatal(`Claw '${name}' has matrix.enabled: true but matrix.access_token is empty — set the access token env var in .env`);
    }
  }
}

// ── Step 7: Compute derived values per claw ──────────────────────────────────
// Pre-computes all values the Handlebars template needs so the template
// is a pure data projection with no inline logic.

function computeDerivedValues(claws, stack, host, previousDeploy) {
  const logUrl = stack.logging?.worker_url || "";
  const logToken = stack.logging?.worker_token || "";
  const autoTokens = {};  // env var name → value, for .env persistence

  // Stack-level derived values
  stack.vector = !!stack.logging?.vector;

  if (stack.egress_proxy) {
    const before = stack.egress_proxy.auth_token;
    stack.egress_proxy.auth_token = resolveAutoToken(
      before,
      "stack.egress_proxy.auth_token",
      previousDeploy
    );
    autoTokens.EGRESS_PROXY_AUTH_TOKEN = stack.egress_proxy.auth_token;
  }

  if (stack.sandbox_registry) {
    const sr = stack.sandbox_registry;
    const before = sr.token;
    sr.token = resolveAutoToken(before, "stack.sandbox_registry.token", previousDeploy);
    autoTokens.SANDBOX_REGISTRY_TOKEN = sr.token;
    sr.log_level = sr.log_level || "warn";
    if (sr.port && !sr.url) {
      stack.sandbox_registry_container = true;
      stack.sandbox_registry_port = sr.port;
      stack.sandbox_registry_url = "";  // Computed at runtime in entrypoint
    } else if (sr.url) {
      stack.sandbox_registry_container = false;
      stack.sandbox_registry_port = "";
      stack.sandbox_registry_url = sr.url;
    }
  }

  for (const claw of Object.values(claws)) {
    const gwUrl = claw.ai_gateway?.url || stack.ai_gateway.url;
    const gwToken = claw.ai_gateway?.token || stack.ai_gateway.token;

    // gateway_token already resolved in main() via .env
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
    // telegram_enabled / matrix_enabled are flat booleans for Handlebars — avoids
    // empty-string output when the section is absent from stack.yml.
    claw.telegram_enabled = claw.telegram?.enabled === true;
    claw.matrix_enabled = claw.matrix?.enabled === true;
  }

  return autoTokens;
}

// ── Step 8: Parse human-readable time → cron expression + IANA timezone ──────

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
  if (stack.sandbox_registry) {
    lines.push(`STACK__STACK__SANDBOX_REGISTRY__PORT=${stack.sandbox_registry_port || ""}`);
    lines.push(`STACK__STACK__SANDBOX_REGISTRY__URL=${stack.sandbox_registry_url || ""}`);
  }
  if (stack.egress_proxy) {
    lines.push(`STACK__STACK__EGRESS_PROXY__AUTH_TOKEN=${formatEnvValue(stack.egress_proxy.auth_token)}`);
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
    lines.push(`STACK__CLAWS__${envKey}__HEALTH_CHECK_CRON=${claw.health_check_cron ?? false}`);
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

  // 1b. Resolve protected vars (.env > generate)
  info("Resolving protected vars...");
  const resolvedProtected = {};
  let generated = 0;
  for (const [name, generator] of Object.entries(PROTECTED_VARS)) {
    if (env[name]) {
      resolvedProtected[name] = env[name];
    } else {
      resolvedProtected[name] = generator();
      generated++;
    }
  }
  // appendToEnv deferred to step 5a (combined with gateway tokens)
  if (generated > 0) {
    success(`Protected vars: ${generated} generated, will append to .env`);
  } else {
    success("Protected vars: all present in .env");
  }

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

  // 5a. Resolve per-claw gateway tokens (stack.yml > .env > generate)
  const gwTokenGenerator = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const gwTokenUpdates = {};
  for (const [name, claw] of Object.entries(claws)) {
    const envKey = name.replace(/-/g, "_").toUpperCase() + "_GATEWAY_TOKEN";
    if (!claw.gateway_token) {
      claw.gateway_token = env[envKey] || gwTokenGenerator();
    }
    gwTokenUpdates[envKey] = claw.gateway_token;
  }
  appendToEnv({ ...resolvedProtected, ...gwTokenUpdates });

  // 5b. Compute derived values for template
  info("Computing derived values...");
  const previousDeploy = loadPreviousDeploy();
  const autoTokens = computeDerivedValues(claws, stack, host, previousDeploy);
  if (Object.keys(autoTokens).length > 0) {
    appendToEnv(autoTokens);
  }
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
  mkdirSync(join(DEPLOY_DIR, ".tmp"), { recursive: true });

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

  // 7d-ii. Write list of env vars that are empty in the container environment.
  // sync-deploy resolves these in openclaw.json before uploading so OpenClaw's
  // native ${VAR} substitution doesn't throw MissingEnvVarError on hot-reload.
  // Map: env var name → claw property that determines its value.
  const potentiallyEmptyVars = {
    OPENCLAW_DOMAIN_PATH: "domain_path",
    VPS_HOSTNAME: "vps_hostname",
    LOG_WORKER_TOKEN: "log_worker_token",
    EVENTS_URL: "events_url",
    LLEMTRY_URL: "llemtry_url",
  };
  // Check against first claw (these vars are stack-wide, same for all claws)
  const firstClaw = Object.values(claws)[0];
  const emptyVars = Object.entries(potentiallyEmptyVars)
    .filter(([, prop]) => {
      const val = prop.split(".").reduce((o, k) => o?.[k], firstClaw);
      return !val && val !== 0 && val !== false;
    })
    .map(([envVar]) => envVar);
  // Channel vars are per-claw: only emitted in docker-compose.yml when the channel is enabled.
  // Always pre-resolve them regardless of any claw's config, so openclaw.jsonc ${VAR}
  // substitution succeeds on claws where the channel is disabled and these env vars are absent
  // from the container environment. Checking only the first claw would break multi-claw
  // stacks where claws have heterogeneous channel config.
  const alwaysResolveVars = ["ADMIN_TELEGRAM_ID", "MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"];
  writeFileSync(join(DEPLOY_DIR, "openclaw-stack", "empty-env-vars"), [...emptyVars, ...alwaysResolveVars].join("\n") + "\n");

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

  // 7g-2. Generate sandbox-registry htpasswd if running own registry
  if (stack.sandbox_registry_container) {
    const token = stack.sandbox_registry.token;  // Always set (auto-generated if needed)
    const htpasswdDir = join(DEPLOY_DIR, "sandbox-registry");
    mkdirSync(htpasswdDir, { recursive: true });
    let htpasswdLine;
    // Use spawnSync with argv array to avoid shell injection from token value
    let result = spawnSync("htpasswd", ["-nbB", "openclaw", token], { encoding: "utf8" });
    if (result.status === 0) {
      htpasswdLine = result.stdout.trim();
    } else {
      result = spawnSync("docker", ["run", "--rm", "httpd:2", "htpasswd", "-nbB", "openclaw", token], { encoding: "utf8" });
      if (result.status === 0) {
        htpasswdLine = result.stdout.trim();
      } else {
        fatal("Cannot generate htpasswd. Install apache2-utils or ensure Docker is running.");
      }
    }
    writeFileSync(join(htpasswdDir, "htpasswd"), htpasswdLine + "\n");
    success("Generated sandbox-registry/htpasswd");
  }

  // 7h. Ensure each claw has its own openclaw.jsonc (source of truth for sync-deploy).
  // If missing, copies from the default template and updates stack.yml to reference it.
  for (const [name, claw] of Object.entries(claws)) {
    const clawConfigDir = join(ROOT, "openclaw", name);
    let clawConfigPath = join(clawConfigDir, "openclaw.jsonc");

    // Normalize: rename .json → .jsonc if needed
    const jsonVariant = join(clawConfigDir, "openclaw.json");
    if (!existsSync(clawConfigPath) && existsSync(jsonVariant)) {
      renameSync(jsonVariant, clawConfigPath);
      info(`Renamed openclaw/${name}/openclaw.json → openclaw.jsonc`);
    }

    if (!existsSync(clawConfigPath)) {
      // Copy default template to per-claw location
      const templateFile = claw.openclaw_json || "openclaw/default/openclaw.jsonc";
      info(`Creating openclaw/${name}/openclaw.jsonc from ${templateFile}...`);

      const raw = readRoot(templateFile);
      parseJsoncFile(raw, templateFile);

      mkdirSync(clawConfigDir, { recursive: true });
      writeFileSync(clawConfigPath, raw);
      success(`Created openclaw/${name}/openclaw.jsonc`);

      // Update stack.yml to set per-claw openclaw_json
      const stackYmlPath = join(ROOT, "stack.yml");
      let stackYml = readFileSync(stackYmlPath, "utf-8");
      const expectedLine = `    openclaw_json: openclaw/${name}/openclaw.jsonc`;

      if (!stackYml.includes(expectedLine.trim())) {
        const clawLineRegex = new RegExp(`^(  ${name}:)(.*)$`, "m");
        const match = stackYml.match(clawLineRegex);
        if (match) {
          const clawStart = stackYml.indexOf(match[0]);
          // Find this claw's section boundary (next line at claw indentation or EOF)
          const afterClaw = stackYml.slice(clawStart + match[0].length);
          const nextClawMatch = afterClaw.match(/\n  [a-zA-Z]/);
          const sectionEnd = nextClawMatch
            ? clawStart + match[0].length + nextClawMatch.index
            : stackYml.length;
          const clawSection = stackYml.slice(clawStart, sectionEnd);

          // Replace existing openclaw_json or insert new one
          const existingLine = clawSection.match(/^    openclaw_json:.*$/m);
          if (existingLine) {
            stackYml = stackYml.replace(existingLine[0], expectedLine);
          } else {
            const insertAt = clawStart + match[0].length;
            stackYml = stackYml.slice(0, insertAt) + "\n" + expectedLine + stackYml.slice(insertAt);
          }
          writeFileSync(stackYmlPath, stackYml);
          success(`Updated stack.yml: ${name}.openclaw_json`);
        }
      }
    } else {
      const raw = readFileSync(clawConfigPath, "utf-8");
      parseJsoncFile(raw, `openclaw/${name}/openclaw.jsonc`);
      success(`Validated openclaw/${name}/openclaw.jsonc`);
    }
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
