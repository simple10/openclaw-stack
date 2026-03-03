#!/usr/bin/env node
// config-diff.mjs — Compare two openclaw.json(c) files and classify changes.
//
// Reports which top-level keys changed and whether a container restart is
// required.  Keys in the HOT_RELOAD_KEYS set are picked up by the running
// gateway automatically; everything else needs a restart.
//
// Usage: node config-diff.mjs <old-file> <new-file>
// Output (JSON to stdout):
//   { "changed": [...], "restartRequired": true, "restartKeys": [...], "hotReloadKeys": [...] }
//
// Exit codes:
//   0 — success (even if no changes)
//   1 — usage / parse error

import { readFileSync } from "fs";

// ── Hot-reload allow-set ────────────────────────────────────────────────────
// These top-level keys are watched by the gateway's config-reloader and
// applied without a restart.  Everything else requires a restart.
// (From openclaw.jsonc template comments.)
const HOT_RELOAD_KEYS = new Set([
  "hooks",
  "cron",
  "browser",
  "channels",
  "telegram",   // legacy top-level alias for channels.telegram
  "whatsapp",   // legacy top-level alias for channels.whatsapp
]);

// ── JSONC parser (same approach as config-hash.mjs) ─────────────────────────
let parseJsonc;
try {
  const { parse } = await import("jsonc-parser");
  parseJsonc = (raw) => {
    const errors = [];
    const result = parse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error("JSONC parse error");
    return result;
  };
} catch {
  parseJsonc = (raw) => {
    let result = "";
    let i = 0;
    let inString = false;
    while (i < raw.length) {
      if (inString) {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          result += raw[i] + raw[i + 1];
          i += 2;
          continue;
        }
        if (raw[i] === '"') inString = false;
        result += raw[i++];
        continue;
      }
      if (raw[i] === '"') {
        inString = true;
        result += raw[i++];
        continue;
      }
      if (raw[i] === "/" && raw[i + 1] === "/") {
        i += 2;
        while (i < raw.length && raw[i] !== "\n") i++;
        continue;
      }
      if (raw[i] === "/" && raw[i + 1] === "*") {
        i += 2;
        while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      result += raw[i++];
    }
    return JSON.parse(result);
  };
}

// ── Deep-sort for deterministic comparison ──────────────────────────────────
function sortKeys(val) {
  if (Array.isArray(val)) return val.map(sortKeys);
  if (val && typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
    return out;
  }
  return val;
}

// ── Main ────────────────────────────────────────────────────────────────────
const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  process.stderr.write("Usage: config-diff.mjs <old-file> <new-file>\n");
  process.exit(1);
}

function loadConfig(file) {
  const raw = readFileSync(file, "utf-8");
  const parsed = parseJsonc(raw);
  delete parsed.meta; // volatile bookkeeping — not meaningful config
  return parsed;
}

let oldConfig, newConfig;
try {
  oldConfig = loadConfig(oldFile);
} catch (e) {
  process.stderr.write(`config-diff: parse error in ${oldFile}: ${e.message}\n`);
  process.exit(1);
}
try {
  newConfig = loadConfig(newFile);
} catch (e) {
  process.stderr.write(`config-diff: parse error in ${newFile}: ${e.message}\n`);
  process.exit(1);
}

// Collect all top-level keys from both configs
const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

const changed = [];
const restartKeys = [];
const hotReloadKeys = [];

for (const key of allKeys) {
  const oldVal = JSON.stringify(sortKeys(oldConfig[key]));
  const newVal = JSON.stringify(sortKeys(newConfig[key]));
  if (oldVal !== newVal) {
    changed.push(key);
    if (HOT_RELOAD_KEYS.has(key)) {
      hotReloadKeys.push(key);
    } else {
      restartKeys.push(key);
    }
  }
}

const result = {
  changed,
  restartRequired: restartKeys.length > 0,
  restartKeys,
  hotReloadKeys,
};

process.stdout.write(JSON.stringify(result) + "\n");
