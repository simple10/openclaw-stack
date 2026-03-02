#!/usr/bin/env node
/**
 * update-env.mjs — Set or rotate environment variables in the correct file.
 *
 * Usage:
 *   node build/update-env.mjs VAR_NAME value         # Set explicit value
 *   node build/update-env.mjs VAR_NAME --generate     # Auto-generate new value
 *
 * Protected vars (ADMINCLAW_PASSWORD, OPENCLAW_PASSWORD, AI_WORKER_ADMIN_AUTH_TOKEN)
 * are written to .env.local. All others are written to .env.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID, randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Must match the registry in pre-deploy.mjs
const PROTECTED_VARS = {
  ADMINCLAW_PASSWORD: () => randomBytes(18).toString("base64"),
  OPENCLAW_PASSWORD: () => randomBytes(18).toString("base64"),
  AI_WORKER_ADMIN_AUTH_TOKEN: () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
};

function fatal(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

/** Update or append a key=value in a dotenv file. */
function upsertEnvVar(filePath, key, value) {
  let content = "";
  if (existsSync(filePath)) {
    content = readFileSync(filePath, "utf-8");
  }

  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    // Append, ensuring newline before
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += `${key}=${value}\n`;
  }

  writeFileSync(filePath, content);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: node build/update-env.mjs VAR_NAME value");
    console.log("       node build/update-env.mjs VAR_NAME --generate");
    process.exit(1);
  }

  const varName = args[0];
  const isGenerate = args[1] === "--generate";
  const isProtected = varName in PROTECTED_VARS;

  let value;
  if (isGenerate) {
    if (isProtected) {
      value = PROTECTED_VARS[varName]();
    } else {
      // Default generator for non-protected vars: 64 hex chars
      value = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    }
  } else {
    value = args[1];
  }

  const targetFile = isProtected ? ".env.local" : ".env";
  const targetPath = join(ROOT, targetFile);

  upsertEnvVar(targetPath, varName, value);

  console.log(`\x1b[32m✓\x1b[0m ${varName}=${value}`);
  console.log(`  → ${targetFile}`);
}

main();
