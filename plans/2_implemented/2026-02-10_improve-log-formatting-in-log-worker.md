# Use level-appropriate console methods + hoist JSON message in log-receiver worker

## Context

Two improvements to how the log-receiver worker processes and outputs logs:

1. **Level-appropriate console methods** — Currently uses `console.log()` for all entries. Cloudflare's dashboard distinguishes between `console.error/warn/log/debug`, so using the right method will show proper severity indicators.

2. **Hoist inner JSON message** — OpenClaw now emits JSON-formatted logs, meaning `entry.message` may be a JSON string like `{"message":"actual log text",...}`. The Cloudflare dashboard displays `message` as the primary text, so we should parse the inner JSON and copy its `.message` to the outer entry for clean display.

## File to modify

`workers/log-receiver/src/index.ts`

## Changes

### 1. Add console method dispatcher (new helper)

Map detected level to the appropriate console method:

| Detected level | Console method |
|---|---|
| `error`, `fatal`, `panic` | `console.error()` |
| `warn` | `console.warn()` |
| `info` | `console.log()` |
| `debug`, `trace` | `console.debug()` |

(`console.trace()` intentionally avoided — it prints stack traces in JS)

### 2. Hoist inner JSON message (in the processing loop, before output)

After pruning fields and before JSON.stringify, check if `entry.message` is a string that looks like JSON (`starts with '{'` and `contains '"message":'`). If so:

- `JSON.parse()` it (wrapped in try/catch — skip on parse failure)
- Copy the parsed object's `.message` to `entry.message` (hoisting)
- Optionally merge other useful fields from the parsed JSON into the entry

### 3. Replace `console.log(output)` on line 144

Use the new dispatcher instead.

## Verification

- `cd workers/log-receiver && npm run build` (typecheck + bundle)
