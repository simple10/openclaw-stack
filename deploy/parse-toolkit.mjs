#!/usr/bin/env node
// Parses deploy/sandbox-toolkit.yaml and outputs JSON for the entrypoint.
// No external dependencies — uses a minimal inline parser for our simple YAML subset.
//
// Usage:
//   node parse-toolkit.mjs <path-to-yaml>
//   node parse-toolkit.mjs                  # defaults to /app/deploy/sandbox-toolkit.yaml
//
// Output (JSON):
// {
//   "packages": ["curl", "wget", ...],
//   "tools": {
//     "gifgrep": { "version": "0.2.1", "install": "curl ...", "bins": ["gifgrep"] },
//     "claude-code": { "install": "npm install ...", "bins": ["claude"] },
//     "ffmpeg": { "bins": ["ffmpeg", "ffprobe"] },
//     ...
//   },
//   "allBins": ["gifgrep", "claude", "ffmpeg", "ffprobe", "convert", "identify", "mogrify"]
// }

import { readFileSync } from 'node:fs';

const yamlPath = process.argv[2] || '/app/deploy/sandbox-toolkit.yaml';
const raw = readFileSync(yamlPath, 'utf8');

// Keep all lines (including blanks) for folded scalar handling, strip comments
const allLines = raw.split('\n');
const result = { packages: [], tools: {}, allBins: [] };

let section = null;       // 'packages' | 'tools'
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
      }
    }
  }

  i++;
}

// Compute allBins: for each tool, use bins if specified, otherwise [toolName]
for (const [name, tool] of Object.entries(result.tools)) {
  const bins = tool.bins || [name];
  tool.bins = bins;
  result.allBins.push(...bins);
}

console.log(JSON.stringify(result));
