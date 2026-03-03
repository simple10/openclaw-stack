#!/usr/bin/env node
// config-hash.mjs — Compute normalized SHA256 of an openclaw.json(c) file.
//
// Normalization pipeline:
//   1. Strip JSONC comments (// and /* */)
//   2. Delete `meta` key (volatile OpenClaw bookkeeping: lastTouchedAt, etc.)
//   3. Deep-sort all object keys (OpenClaw rearranges keys at runtime)
//   4. Compact JSON.stringify → SHA256
//
// Comment edits, formatting changes, key reordering, and meta updates
// don't affect the hash — only actual config value changes do.
//
// Used by sync-deploy.sh (local) and entrypoint.sh (container).
//
// Usage: node config-hash.mjs <file>
// Output: hex SHA256 hash on stdout

import { readFileSync } from "fs";
import { createHash } from "crypto";

const file = process.argv[2];
if (!file) {
  process.stderr.write("Usage: config-hash.mjs <file>\n");
  process.exit(1);
}

// Try jsonc-parser (available locally in vps-muxxibot), fall back to inline
// stripper (container environment where openclaw-stack/ is bind-mounted and
// jsonc-parser isn't in /app/node_modules/).
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
  // Inline JSONC comment stripper — handles // and /* */ while preserving
  // // inside quoted strings (e.g. URLs). Falls back to JSON.parse after.
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

const raw = readFileSync(file, "utf-8");

let parsed;
try {
  parsed = parseJsonc(raw);
} catch (e) {
  process.stderr.write(`config-hash: parse error in ${file}: ${e.message}\n`);
  process.exit(1);
}

// Strip `meta` — volatile OpenClaw bookkeeping (lastTouchedAt, lastTouchedVersion).
// Changes every startup; never represents meaningful config drift.
delete parsed.meta;

// Deep-sort all object keys for deterministic output.
// OpenClaw rearranges keys at all levels at runtime.
function sortKeys(val) {
  if (Array.isArray(val)) return val.map(sortKeys);
  if (val && typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
    return out;
  }
  return val;
}
const normalized = JSON.stringify(sortKeys(parsed));
const hash = createHash("sha256").update(normalized).digest("hex");
process.stdout.write(hash + "\n");
