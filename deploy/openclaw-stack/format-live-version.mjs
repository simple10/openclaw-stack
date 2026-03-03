#!/usr/bin/env node
// format-live-version.mjs — Format a live openclaw.json for human review.
//
// Produces an annotated JSONC file with:
//   - Top-level keys sorted to match the local file's order
//   - Inline // DRIFT comments above keys that differ from local
//   - Deep comparison summaries showing what specifically changed
//
// Usage: node format-live-version.mjs <local-file> <live-file>
// Output: annotated JSONC to stdout

import { readFileSync } from "fs";

// ── JSONC parser (same approach as config-diff.mjs) ─────────────────────────
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

// ── Deep comparison ─────────────────────────────────────────────────────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

// Describe differences between two values at a given path depth.
// Returns an array of human-readable diff strings.
function describeDiffs(local, live, prefix, maxDepth) {
  const diffs = [];
  if (maxDepth <= 0) {
    diffs.push(`${prefix}: values differ`);
    return diffs;
  }

  if (local == null && live != null) {
    diffs.push(`${prefix}: exists only in live`);
    return diffs;
  }
  if (local != null && live == null) {
    diffs.push(`${prefix}: exists only in local`);
    return diffs;
  }
  if (typeof local !== typeof live) {
    diffs.push(`${prefix}: type changed (${typeof local} → ${typeof live})`);
    return diffs;
  }
  if (Array.isArray(local) && Array.isArray(live)) {
    if (local.length !== live.length) {
      diffs.push(`${prefix}: array length ${local.length} → ${live.length}`);
    } else if (!deepEqual(local, live)) {
      diffs.push(`${prefix}: array contents differ`);
    }
    return diffs;
  }
  if (typeof local === "object" && local !== null) {
    const allKeys = new Set([...Object.keys(local), ...Object.keys(live)]);
    for (const k of allKeys) {
      const childPrefix = prefix ? `${prefix}.${k}` : k;
      if (!(k in local)) {
        diffs.push(`${childPrefix}: only in live`);
      } else if (!(k in live)) {
        diffs.push(`${childPrefix}: only in local`);
      } else if (!deepEqual(local[k], live[k])) {
        if (typeof local[k] === "object" && typeof live[k] === "object" && !Array.isArray(local[k])) {
          diffs.push(...describeDiffs(local[k], live[k], childPrefix, maxDepth - 1));
        } else {
          // Scalar or array — show values if short enough
          const lStr = JSON.stringify(local[k]);
          const rStr = JSON.stringify(live[k]);
          if (lStr.length + rStr.length < 120) {
            diffs.push(`${childPrefix}: ${lStr} → ${rStr}`);
          } else {
            diffs.push(`${childPrefix}: value changed`);
          }
        }
      }
    }
    return diffs;
  }

  // Scalars
  const lStr = JSON.stringify(local);
  const rStr = JSON.stringify(live);
  if (lStr.length + rStr.length < 120) {
    diffs.push(`${prefix}: ${lStr} → ${rStr}`);
  } else {
    diffs.push(`${prefix}: value changed`);
  }
  return diffs;
}

// ── Main ────────────────────────────────────────────────────────────────────

const [localFile, liveFile] = process.argv.slice(2);
if (!localFile || !liveFile) {
  process.stderr.write("Usage: format-live-version.mjs <local-file> <live-file>\n");
  process.exit(1);
}

let localConfig, liveConfig;
try {
  localConfig = parseJsonc(readFileSync(localFile, "utf-8"));
} catch (e) {
  process.stderr.write(`format-live-version: parse error in ${localFile}: ${e.message}\n`);
  process.exit(1);
}
try {
  liveConfig = parseJsonc(readFileSync(liveFile, "utf-8"));
} catch (e) {
  process.stderr.write(`format-live-version: parse error in ${liveFile}: ${e.message}\n`);
  process.exit(1);
}

// Remove volatile bookkeeping key
delete localConfig.meta;
delete liveConfig.meta;

// Build ordered key list: local order first, then any live-only keys
const localKeys = Object.keys(localConfig);
const liveKeys = Object.keys(liveConfig);
const localKeySet = new Set(localKeys);
const liveKeySet = new Set(liveKeys);

const orderedKeys = [...localKeys];
for (const k of liveKeys) {
  if (!localKeySet.has(k)) orderedKeys.push(k);
}

// Build annotated output
const lines = [];
lines.push(`// Live config from VPS`);
lines.push(`// Downloaded: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);

// Summary
const changedKeys = [];
const liveOnlyKeys = [];
const localOnlyKeys = [];
for (const k of orderedKeys) {
  if (!liveKeySet.has(k)) {
    localOnlyKeys.push(k);
  } else if (!localKeySet.has(k)) {
    liveOnlyKeys.push(k);
  } else if (!deepEqual(localConfig[k], liveConfig[k])) {
    changedKeys.push(k);
  }
}

if (changedKeys.length === 0 && liveOnlyKeys.length === 0 && localOnlyKeys.length === 0) {
  lines.push(`// Status: no drift — live matches local`);
} else {
  const parts = [];
  if (changedKeys.length) parts.push(`${changedKeys.length} changed`);
  if (liveOnlyKeys.length) parts.push(`${liveOnlyKeys.length} only in live`);
  if (localOnlyKeys.length) parts.push(`${localOnlyKeys.length} only in local`);
  lines.push(`// Drift: ${parts.join(", ")}`);
}
lines.push(`//`);

// Reorder an object's keys to match a reference object's key order.
// depth=0 means no reordering, depth=1 means top-level only, etc.
function reorderKeys(live, reference, depth) {
  if (depth <= 0 || !live || !reference) return live;
  if (typeof live !== "object" || typeof reference !== "object") return live;
  if (Array.isArray(live)) return live;

  const refKeys = Object.keys(reference);
  const liveKeySet = new Set(Object.keys(live));
  const ordered = {};

  // First: keys in reference order (that exist in live)
  for (const k of refKeys) {
    if (liveKeySet.has(k)) {
      ordered[k] = reorderKeys(live[k], reference[k], depth - 1);
    }
  }
  // Then: keys only in live (preserve their original order)
  for (const k of Object.keys(live)) {
    if (!(k in ordered)) {
      ordered[k] = live[k];
    }
  }
  return ordered;
}

// Build the reordered live config object (2 levels deep)
const reordered = {};
for (const k of orderedKeys) {
  if (liveKeySet.has(k)) {
    reordered[k] = reorderKeys(liveConfig[k], localConfig[k], 2);
  }
}

// Serialize with 2-space indent, then inject comments above drifted keys
const jsonStr = JSON.stringify(reordered, null, 2);
const jsonLines = jsonStr.split("\n");

// Find top-level key positions in the JSON output (lines like `  "key": ...`)
// and inject drift comments before them
const output = [];
for (const jline of jsonLines) {
  const keyMatch = jline.match(/^  "([^"]+)":/);
  if (keyMatch) {
    const key = keyMatch[1];

    if (!localKeySet.has(key)) {
      // Key exists only in live
      output.push(`  // DRIFT: only in live (not in local openclaw.jsonc)`);
    } else if (!liveKeySet.has(key)) {
      // Shouldn't happen (we only serialize live keys), but guard anyway
    } else if (!deepEqual(localConfig[key], liveConfig[key])) {
      // Deep diff
      const diffs = describeDiffs(localConfig[key], liveConfig[key], key, 3);
      for (const d of diffs) {
        output.push(`  // DRIFT: ${d}`);
      }
    }

    // Check for local-only keys that should appear before this key
    // (keys that exist in local between the previous key and this one)
  }

  output.push(jline);
}

// Append comments for local-only keys at the end
if (localOnlyKeys.length > 0) {
  // Insert before the closing brace
  const closingIdx = output.lastIndexOf("}");
  if (closingIdx >= 0) {
    const insertions = [];
    for (const k of localOnlyKeys) {
      insertions.push(`  // DRIFT: "${k}": only in local (missing from live)`);
    }
    output.splice(closingIdx, 0, ...insertions);
  }
}

// Combine header + body
lines.push("");
lines.push(...output);

process.stdout.write(lines.join("\n") + "\n");
