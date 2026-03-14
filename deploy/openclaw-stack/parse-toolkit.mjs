#!/usr/bin/env node
// Parses sandbox-toolkit.yaml and outputs JSON for the entrypoint.
// No external dependencies — uses a minimal inline parser for our simple YAML subset.
//
// Usage:
//   node parse-toolkit.mjs <path-to-yaml>           # JSON output (default)
//   node parse-toolkit.mjs <path-to-yaml> --strip   # comment-stripped, normalized YAML
//   node parse-toolkit.mjs --strip                   # strip mode with default path
//
// Output (JSON):
// {
//   "packages": ["curl", "wget", ...],
//   "shims": ["jq", "curl", ...],
//   "tools": {
//     "gifgrep": { "version": "0.2.1", "install": "curl ...", "bins": ["gifgrep"] },
//     "claude-code": { "install": "npm install ...", "bins": ["claude"] },
//     "ffmpeg": { "bins": ["ffmpeg", "ffprobe"] },
//     ...
//   },
//   "allBins": ["jq", "curl", ..., "gifgrep", "claude", "ffmpeg", "ffprobe"]
// }

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stripMode = args.includes('--strip');
const yamlPath = args.find(a => a !== '--strip') || '/app/deploy/sandbox-toolkit.yaml';
const raw = readFileSync(yamlPath, 'utf8');

// --strip mode: output comment-stripped, whitespace-normalized content for config comparison.
// Removes comment lines, blank lines, and trailing whitespace. Used by rebuild-sandboxes.sh
// for config change detection and image labels.
if (stripMode) {
  const stripped = raw
    .split('\n')
    .filter(line => !/^\s*#/.test(line) && !/^\s*$/.test(line))
    .map(line => line.replace(/\s+$/, ''))
    .join('\n');
  process.stdout.write(stripped);
  process.exit(0);
}

// Keep all lines (including blanks) for folded scalar handling, strip comments
const allLines = raw.split('\n');
const result = { packages: [], shims: [], tools: {}, allBins: [] };

let section = null;       // 'packages' | 'shims' | 'tools'
let currentTool = null;   // tool name when inside a tools entry

let i = 0;
while (i < allLines.length) {
  const line = allLines[i];

  // Skip blank lines and full-line comments
  if (/^\s*$/.test(line) || /^\s*#/.test(line)) { i++; continue; }

  const indent = line.search(/\S/);

  // Top-level keys (no indent)
  if (indent === 0) {
    const m = line.match(/^(\w+):/);
    if (m) {
      section = m[1];
      currentTool = null;
    }
    i++;
    continue;
  }

  if (section === 'packages') {
    const m = line.match(/^\s+-\s+(.+)/);
    if (m) result.packages.push(m[1].trim());
    i++;
    continue;
  }

  if (section === 'shims') {
    const m = line.match(/^\s+-\s+(.+)/);
    if (m) result.shims.push(m[1].trim());
    i++;
    continue;
  }

  if (section === 'tools') {
    // Tool name (indent 2): "  gifgrep:"
    if (indent === 2) {
      const m = line.match(/^\s+(\S+):/);
      if (m) {
        currentTool = m[1];
        result.tools[currentTool] = {};
      }
      i++;
      continue;
    }

    // Tool properties (indent 4+)
    if (indent >= 4 && currentTool) {
      const m = line.match(/^\s+(\w+):\s*(.*)/);
      if (!m) { i++; continue; }
      const [, key, val] = m;

      if (key === 'bins') {
        const flowMatch = val.match(/\[([^\]]*)\]/);
        if (flowMatch) {
          result.tools[currentTool].bins = flowMatch[1]
            .split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        }
      } else if (key === 'install') {
        // Handle YAML >- folded scalar: value is on subsequent indented lines
        if (val.trim() === '>-' || val.trim() === '>') {
          const parts = [];
          i++;
          while (i < allLines.length) {
            const nextLine = allLines[i];
            // Stop at blank lines, comments, or lines with less/equal indent (new key)
            if (/^\s*$/.test(nextLine) || /^\s*#/.test(nextLine)) { break; }
            const nextIndent = nextLine.search(/\S/);
            if (nextIndent <= 4) break;
            parts.push(nextLine.trim());
            i++;
          }
          // >- folds newlines into spaces
          result.tools[currentTool].install = parts.join(' ');
          continue;  // skip the i++ at the bottom
        } else {
          result.tools[currentTool].install = val.replace(/^["']|["']$/g, '');
        }
      } else if (key === 'version') {
        result.tools[currentTool].version = val.replace(/^["']|["']$/g, '');
      } else if (key === 'apt') {
        result.tools[currentTool].apt = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  i++;
}

// Compute allBins: shims from packages + bins from tools
result.allBins.push(...result.shims);
for (const [name, tool] of Object.entries(result.tools)) {
  const bins = tool.bins || [name];
  tool.bins = bins;
  result.allBins.push(...bins);
}

console.log(JSON.stringify(result));
