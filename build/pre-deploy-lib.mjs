/**
 * pre-deploy-lib.mjs — Pure functions extracted from pre-deploy.mjs for testability.
 *
 * All functions are side-effect-free: they throw on fatal errors (instead of
 * calling process.exit) and accept an `onWarn` callback (instead of printing
 * directly). The caller in pre-deploy.mjs wires these to fatal()/warn().
 */

import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

// ── Env Refs ─────────────────────────────────────────────────────────────────

/**
 * Resolve ${VAR} and ${VAR:-default} references in text, skipping YAML comment lines.
 * @param {string} text - Input text with ${VAR} references
 * @param {Record<string, string>} env - Environment variables
 * @param {(msg: string) => void} [onWarn] - Warning callback for unresolved vars
 * @returns {string} Resolved text
 */
export function resolveEnvRefs(text, env, onWarn) {
  return text.split("\n").map((line) => {
    if (line.trimStart().startsWith("#")) return line;

    return line.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
      const defaultMatch = expr.match(/^([^:]+):-(.*)$/);
      if (defaultMatch) {
        const key = defaultMatch[1];
        const defaultVal = defaultMatch[2];
        return env[key] !== undefined && env[key] !== "" ? env[key] : defaultVal;
      }
      const value = env[expr];
      if (value === undefined) {
        if (onWarn) onWarn(`Unresolved env var: \${${expr}} (will be empty string)`);
        return "";
      }
      return value;
    });
  }).join("\n");
}

// ── Deep Merge ───────────────────────────────────────────────────────────────

export function isPlainObject(val) {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Deep merge source into target. Source values win at any depth. */
export function deepMerge(target, source) {
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

// ── Memory Parsing ───────────────────────────────────────────────────────────

export function parseMemoryValue(val) {
  const str = String(val).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(G|M|GB|MB|g|m|gb|mb)?$/i);
  if (!match) throw new Error(`Invalid memory value: ${val}`);
  const num = parseFloat(match[1]);
  const unit = (match[2] || "M").toUpperCase().replace("B", "");
  const mb = unit === "G" ? Math.floor(num * 1024) : Math.floor(num);
  return { mb, original: str };
}

export function formatMemory(mb) {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}G`;
  return `${mb}M`;
}

// ── JSONC Parsing ────────────────────────────────────────────────────────────

export function parseJsoncFile(text, filePath) {
  const errors = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const errorMsgs = errors.map(e => `  offset ${e.offset}: ${printParseErrorCode(e.error)}`).join("\n");
    throw new Error(`JSONC parse errors in ${filePath}:\n${errorMsgs}`);
  }
  return result;
}

// ── Claw Validation ──────────────────────────────────────────────────────────

export function validateClaw(name, claw, onWarn) {
  const required = ["domain", "gateway_port", "dashboard_port"];
  for (const field of required) {
    if (claw[field] === undefined || claw[field] === "") {
      throw new Error(`Claw '${name}' is missing required field: ${field}`);
    }
  }

  const telegram = claw.telegram;
  if (!telegram?.bot_token) {
    if (onWarn) onWarn(`Claw '${name}' has no telegram.bot_token — Telegram will be disabled`);
  }
}

// ── Daily Report Time ────────────────────────────────────────────────────────

export const TZ_ABBREVIATIONS = {
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  EST: "America/New_York", EDT: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver",
  UTC: "UTC", GMT: "Europe/London",
  CET: "Europe/Berlin", CEST: "Europe/Berlin",
};

export function parseDailyReportTime(timeStr, onWarn) {
  const fallback = { cronExpr: "30 9 * * *", ianaTz: "America/Los_Angeles" };
  if (!timeStr) return fallback;

  const match = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*(\w+)$/i);
  if (!match) {
    if (onWarn) onWarn(`Could not parse daily_report time "${timeStr}" — using default 9:30 AM PST`);
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
    if (onWarn) onWarn(`Unknown timezone abbreviation "${match[4]}" — using America/Los_Angeles`);
    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: "America/Los_Angeles" };
  }

  return { cronExpr: `${minute} ${hour} * * *`, ianaTz };
}

// ── Env Value Formatting ─────────────────────────────────────────────────────

export function formatEnvValue(val) {
  const s = String(val ?? "");
  if (s === "") return "";
  if (/[\s'"\\$`!#&|;()<>{}]/.test(s)) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

// ── Stack Env Generation ─────────────────────────────────────────────────────

export function generateStackEnv(env, config, claws) {
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

// ── Auto Token Resolution ────────────────────────────────────────────────────

/**
 * Resolve an auto-generated token: explicit value > cached from previous build > new random.
 * @param {string} value - Explicit value (if set)
 * @param {string} cachePath - Dot-separated path into previousDeploy
 * @param {object|null} previousDeploy - Previous deploy config
 * @param {() => string} generateFn - Token generator function
 * @returns {string} Resolved token
 */
export function resolveAutoToken(value, cachePath, previousDeploy, generateFn) {
  if (value) return value;
  let cached = previousDeploy;
  for (const key of cachePath.split(".")) {
    cached = cached?.[key];
  }
  if (cached) return cached;
  return generateFn();
}
