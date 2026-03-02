#!/usr/bin/env node
// merge-config.mjs — Merges staged openclaw.json template into live config.
//
// Template-controlled fields (containing $VAR references like $ANTHROPIC_BASE_URL)
// always come from staged. User-modified fields (no $VAR) are preserved from live.
// New template keys are added; removed template keys are kept if present in live.
//
// Usage: node merge-config.mjs --staged <file> --live <file> --output <file>

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const stagedPath = flag('--staged');
const livePath = flag('--live');
const outputPath = flag('--output');

if (!stagedPath || !livePath || !outputPath) {
  console.error('Usage: merge-config.mjs --staged <file> --live <file> --output <file>');
  process.exit(1);
}

// Matches $VAR references like $ANTHROPIC_BASE_URL, $ADMIN_TELEGRAM_ID
const VAR_RE = /\$[A-Z_]{2,}/;

function hasVarRef(value) {
  if (typeof value === 'string') return VAR_RE.test(value);
  if (Array.isArray(value)) return value.some((item) => hasVarRef(item));
  return false;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(staged, live) {
  // $VAR references mark template-controlled fields — always use staged
  if (hasVarRef(staged)) return staged;

  // Both are objects — recurse keys
  if (isPlainObject(staged) && isPlainObject(live)) {
    const result = { ...live };
    for (const key of Object.keys(staged)) {
      if (key in live) {
        result[key] = merge(staged[key], live[key]);
      } else {
        // New key from template — add it
        result[key] = staged[key];
      }
    }
    return result;
  }

  // Scalar or array without $VAR — preserve live (potentially user-modified)
  return live;
}

const staged = JSON.parse(readFileSync(stagedPath, 'utf8'));
const live = JSON.parse(readFileSync(livePath, 'utf8'));
const merged = merge(staged, live);

writeFileSync(outputPath, JSON.stringify(merged, null, 2) + '\n');
console.log('[merge-config] Merged staged config into live config');
