#!/usr/bin/env bun
/**
 * pre-deploy.ts — Build pipeline for OpenClaw stack deployment
 *
 * Reads .env + stack.yml + docker-compose.yml.hbs and produces
 * a fully-resolved .deploy/ directory ready to git-push to VPS.
 *
 * Usage:
 *   bun run pre-deploy          # Full build
 *   bun run pre-deploy:dry      # Dry run (show what would be generated)
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import * as yaml from "js-yaml";
import * as dotenv from "dotenv";
import Handlebars from "handlebars";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");
const DEPLOY_DIR = join(ROOT, ".deploy");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Helpers ──────────────────────────────────────────────────────────────────

function fatal(msg: string): never {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function info(msg: string) {
  console.log(`\x1b[36m→ ${msg}\x1b[0m`);
}

function success(msg: string) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
}

function warn(msg: string) {
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}

/** Read a file relative to project root */
function readRoot(path: string): string {
  const full = join(ROOT, path);
  if (!existsSync(full)) fatal(`File not found: ${path}`);
  return readFileSync(full, "utf-8");
}

// ── Step 1: Read .env ────────────────────────────────────────────────────────

function readDotEnv(): Record<string, string> {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) fatal(".env not found. Run: cp .env.example .env");

  const parsed = dotenv.parse(readFileSync(envPath));
  return parsed as Record<string, string>;
}

// ── Step 2: Resolve ${VAR} in stack.yml ──────────────────────────────────────

function resolveEnvRefs(text: string, env: Record<string, string>): string {
  // Process line-by-line to skip YAML comments
  return text.split("\n").map((line) => {
    // Skip comment lines (YAML comments start with optional whitespace + #)
    if (line.trimStart().startsWith("#")) return line;

    // Match ${VAR} and ${VAR:-default}
    return line.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const defaultMatch = expr.match(/^([^:]+):-(.*)$/);
      if (defaultMatch) {
        const key = defaultMatch[1]!;
        const defaultVal = defaultMatch[2]!;
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

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Deep merge source into target. Source values win at any depth. */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (result as Record<string, unknown>)[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      (result as Record<string, unknown>)[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

// ── Step 4: Resolve resource percentages ─────────────────────────────────────

interface VpsCapacity {
  cpus: number;
  memory_mb: number;
}

async function queryVpsCapacity(env: Record<string, string>): Promise<VpsCapacity> {
  const ip = env.VPS_IP;
  const user = env.SSH_USER || "adminclaw";
  const port = env.SSH_PORT || "222";
  const keyPath = env.SSH_KEY || "~/.ssh/vps1_openclaw_ed25519";

  if (!ip) fatal("VPS_IP not set in .env — cannot query VPS capacity for resource % resolution");

  const expandedKey = keyPath.replace(/^~/, process.env.HOME || "");
  info(`Querying VPS capacity at ${user}@${ip}:${port}...`);

  const sshCmd = [
    "ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10",
    "-i", expandedKey, "-p", port, `${user}@${ip}`,
    "nproc && grep MemTotal /proc/meminfo | awk '{print $2}'"
  ];

  const proc = Bun.spawn(sshCmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

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

function parseMemoryValue(val: string): { mb: number; original: string } {
  const str = String(val).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(G|M|GB|MB|g|m|gb|mb)?$/i);
  if (!match) fatal(`Invalid memory value: ${val}`);
  const num = parseFloat(match[1]!);
  const unit = (match[2] || "M").toUpperCase().replace("B", "");
  const mb = unit === "G" ? Math.floor(num * 1024) : Math.floor(num);
  return { mb, original: str };
}

function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}G`;
  return `${mb}M`;
}

interface ResolvedResources {
  max_cpu: number;
  max_mem_mb: number;
}

async function resolveStackResources(
  stackResources: { max_cpu?: string; max_mem?: string },
  env: Record<string, string>
): Promise<ResolvedResources> {
  const maxCpu = String(stackResources?.max_cpu || "100%");
  const maxMem = String(stackResources?.max_mem || "100%");

  const needsVps = maxCpu.includes("%") || maxMem.includes("%");
  let capacity: VpsCapacity | null = null;

  if (needsVps) {
    capacity = await queryVpsCapacity(env);
  }

  let resolvedCpu: number;
  if (maxCpu.endsWith("%")) {
    const pct = parseInt(maxCpu, 10) / 100;
    resolvedCpu = Math.floor(capacity!.cpus * pct);
  } else {
    resolvedCpu = parseInt(maxCpu, 10);
  }

  let resolvedMemMb: number;
  if (maxMem.endsWith("%")) {
    const pct = parseInt(maxMem, 10) / 100;
    resolvedMemMb = Math.floor(capacity!.memory_mb * pct);
  } else {
    resolvedMemMb = parseMemoryValue(maxMem).mb;
  }

  success(`Stack resource budget: ${resolvedCpu} CPUs, ${formatMemory(resolvedMemMb)} memory`);
  return { max_cpu: resolvedCpu, max_mem_mb: resolvedMemMb };
}

// ── Step 5: Parse JSONC (JSON with Comments) ─────────────────────────────────

function parseJsoncFile(text: string, filePath: string): unknown {
  const errors: import("jsonc-parser").ParseError[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const errorMsgs = errors.map(e => `  offset ${e.offset}: ${printParseErrorCode(e.error)}`).join("\n");
    fatal(`JSONC parse errors in ${filePath}:\n${errorMsgs}`);
  }
  return result;
}

// ── Step 6: Validate required fields ─────────────────────────────────────────

function validateClaw(name: string, claw: Record<string, unknown>) {
  const required = ["domain", "gateway_port", "dashboard_port"];
  for (const field of required) {
    if (claw[field] === undefined || claw[field] === "") {
      fatal(`Claw '${name}' is missing required field: ${field}`);
    }
  }

  const telegram = claw.telegram as Record<string, unknown> | undefined;
  if (!telegram?.bot_token) {
    warn(`Claw '${name}' has no telegram.bot_token — Telegram will be disabled`);
  }
}

// ── Step 7: Compute derived values per claw ──────────────────────────────────
// Pre-computes all values the Handlebars template needs so the template
// is a pure data projection with no inline logic.

function computeDerivedValues(
  claws: Record<string, Record<string, any>>,
  stack: Record<string, any>,
  host: Record<string, any>,
) {
  const logUrl = stack.logging?.worker_url || "";
  const logToken = stack.logging?.worker_token || "";

  // Stack-level derived values
  stack.vector = !!stack.logging?.vector;

  for (const claw of Object.values(claws)) {
    const gwUrl = claw.ai_gateway?.url || stack.ai_gateway.url;
    const gwToken = claw.ai_gateway?.token || stack.ai_gateway.token;

    claw.gateway_token = claw.gateway_token || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    claw.anthropic_api_key = gwToken;
    claw.anthropic_base_url = gwUrl + "/anthropic";
    claw.openai_api_key = gwToken;
    claw.openai_base_url = gwUrl + "/openai/v1";
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

// ── Step 9: Generate stack.env ───────────────────────────────────────────────
// Bash-sourceable key=value file for shell scripts.
// Convention: ENV__<key> for .env vars, STACK__<path> for stack.yml vars.

function formatEnvValue(val: unknown): string {
  const s = String(val ?? "");
  if (s === "") return "";
  if (/[\s'"\\$`!#&|;()<>{}]/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

function generateStackEnv(
  env: Record<string, string>,
  config: Record<string, any>,
  claws: Record<string, Record<string, any>>,
): string {
  const lines: string[] = [
    "# Generated by pre-deploy.ts — DO NOT EDIT",
    "# To regenerate: bun run pre-deploy",
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
  lines.push("");

  // Derived
  lines.push("# Derived");
  lines.push(`STACK__STACK__INSTANCES_DIR=${formatEnvValue(installDir + "/instances")}`);
  lines.push(`STACK__STACK__IMAGE=${formatEnvValue("openclaw-" + projectName + ":local")}`);
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
  const config = yaml.load(stackResolved) as Record<string, any>;

  if (!config.stack) fatal("stack.yml missing 'stack' section");
  if (!config.claws || Object.keys(config.claws).length === 0) fatal("stack.yml has no claws defined");

  const stack = config.stack;
  const host = config.host || {};
  const defaults = config.defaults || {};
  const clawsRaw = config.claws as Record<string, Record<string, unknown>>;

  success(`stack.yml loaded: ${Object.keys(clawsRaw).length} claw(s)`);

  // 3. Deep merge defaults into each claw
  info("Merging defaults into claws...");
  const claws: Record<string, Record<string, any>> = {};
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

  // Preserve .git if it exists (deploy repo)
  const deployGitDir = join(DEPLOY_DIR, ".git");
  const hadGit = existsSync(deployGitDir);

  // Clean .deploy/ but preserve .git
  if (existsSync(DEPLOY_DIR)) {
    for (const entry of new Bun.Glob("*").scanSync({ cwd: DEPLOY_DIR, dot: false })) {
      const full = join(DEPLOY_DIR, entry);
      rmSync(full, { recursive: true, force: true });
    }
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

  // 7d. Copy source-config.sh (config resolver for shell scripts)
  cpSync(join(ROOT, "deploy", "scripts", "source-config.sh"), join(DEPLOY_DIR, "source-config.sh"));
  success("Copied source-config.sh");

  // 7e. Process openclaw.jsonc for each claw → .deploy/openclaw/<name>/openclaw.json
  for (const [name, claw] of Object.entries(claws)) {
    const templateFile = (claw.openclaw_json as string) || "openclaw/default/openclaw.jsonc";
    info(`Processing openclaw config for ${name} (from ${templateFile})...`);

    const raw = readRoot(templateFile);
    // Parse JSONC to validate and strip comments, then re-serialize as clean JSON
    const parsed = parseJsoncFile(raw, templateFile);
    const cleanJson = JSON.stringify(parsed, null, 2);

    const outDir = join(DEPLOY_DIR, "openclaw", name);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "openclaw.json"), cleanJson + "\n");
    success(`Wrote openclaw/${name}/openclaw.json`);
  }

  // 7f. Copy entrypoint-gateway.sh
  cpSync(join(ROOT, "deploy", "entrypoint-gateway.sh"), join(DEPLOY_DIR, "entrypoint-gateway.sh"));
  success("Copied entrypoint-gateway.sh");

  // 7g. Copy deploy artifacts (plugins, dashboard, scripts, etc.)
  const deployArtifacts = [
    "plugins",
    "dashboard",
    "sandbox-toolkit.yaml",
    "parse-toolkit.mjs",
    "rebuild-sandboxes.sh",
    "build-openclaw.sh",
    "openclaw-crons.jsonc",
    "session-prune.sh",
    "backup.sh",
    "host-alert.sh",
    "host-maintenance-check.sh",
    "logrotate-openclaw",
    "system-hardening.sh",
  ];

  for (const artifact of deployArtifacts) {
    const src = join(ROOT, "deploy", artifact);
    if (!existsSync(src)) {
      warn(`Deploy artifact not found: deploy/${artifact} (skipping)`);
      continue;
    }
    cpSync(src, join(DEPLOY_DIR, "deploy", artifact), { recursive: true });
  }
  success("Copied deploy artifacts");

  // 7h. Copy vector config if logging enabled
  if (stack.vector) {
    const vectorSrc = join(ROOT, "deploy", "vector");
    if (existsSync(vectorSrc)) {
      mkdirSync(join(DEPLOY_DIR, "vector"), { recursive: true });
      cpSync(join(vectorSrc, "vector.yaml"), join(DEPLOY_DIR, "vector", "vector.yaml"));
      success("Copied vector config");
    }
  }

  // Summary
  console.log(`\n\x1b[32m\x1b[1mBuild complete!\x1b[0m`);
  console.log(`  Output:   ${DEPLOY_DIR}`);
  console.log(`  Claws:    ${Object.keys(claws).join(", ")}`);
  console.log(`  Template: ${templatePath}`);
  if (hadGit) {
    console.log(`  Deploy repo: .git preserved — run 'cd .deploy && git diff' to review`);
  }
  console.log(`\n  Next: cd .deploy && git add -A && git commit && git push\n`);
}

main().catch((e) => {
  fatal(`Unexpected error: ${e.message}`);
});
