#!/usr/bin/env node
// resolve-config-vars.mjs — Resolve ${VAR} references in an openclaw.jsonc file
// using env vars from the generated docker-compose.yml for a specific claw.
//
// Usage: node resolve-config-vars.mjs <config-file> <claw-name>
// Output: resolved config to stdout (preserves JSONC comments)
//
// This ensures the uploaded config has concrete values matching the container's
// runtime environment, eliminating false drift when OpenClaw's control UI
// rewrites the config with resolved values.

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import yaml from "js-yaml";

const [configFile, clawName] = process.argv.slice(2);
if (!configFile || !clawName) {
  process.stderr.write("Usage: resolve-config-vars.mjs <config-file> <claw-name>\n");
  process.exit(1);
}

// Find .deploy/docker-compose.yml by walking up from the config file.
// Works for files anywhere in the repo tree, including .deploy/.tmp/<claw>/.
let repoRoot = dirname(configFile);
while (repoRoot !== "/" && !existsSync(join(repoRoot, ".deploy"))) {
  repoRoot = dirname(repoRoot);
}

const composePath = join(repoRoot, ".deploy", "docker-compose.yml");
if (!existsSync(composePath)) {
  // No compose file — pass through unchanged
  process.stdout.write(readFileSync(configFile, "utf-8"));
  process.exit(0);
}

// Extract env vars for the claw's service
const compose = yaml.load(readFileSync(composePath, "utf-8"));
const services = compose?.services || {};
const suffix = `openclaw-${clawName}`;
const service = Object.entries(services).find(([name]) => name.endsWith(suffix));

if (!service) {
  process.stderr.write(`resolve-config-vars: service for '${clawName}' not found in compose\n`);
  process.stdout.write(readFileSync(configFile, "utf-8"));
  process.exit(0);
}

const env = {};
for (const entry of service[1]?.environment || []) {
  const eq = entry.indexOf("=");
  if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
}

// Resolve ${VAR} and ${VAR:-default} in the raw text (preserves comments, formatting)
let content = readFileSync(configFile, "utf-8");
content = content.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
  const defaultMatch = expr.match(/^([^:]+):-(.*)$/);
  if (defaultMatch) {
    const key = defaultMatch[1];
    const defaultVal = defaultMatch[2];
    return (key in env && env[key] !== "") ? env[key] : defaultVal;
  }
  return (expr in env) ? env[expr] : "";
});

process.stdout.write(content);
