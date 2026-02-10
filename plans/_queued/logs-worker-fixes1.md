# Plan: Log Filtering for Log-Receiver Worker

## Context

The log-receiver Cloudflare Worker currently `console.log()`s every log entry received from Vector. Vector sends up to 256KB batches, which exceeds Cloudflare's 256KB per-request console output limit (shared across all console.log statements + request metadata + headers). This causes log truncation and silent data loss.

## Changes

### 1. Worker: Filter `handleLogs` in `workers/log-receiver/src/index.ts`

Replace the current loop that logs every entry with:

- **Level detection**: Check each entry's `.level` field (set by Vector, see #2). Fallback: parse the `.message` text for keywords (`error`, `warn`, `panic`, `fatal`, `debug`, `trace`) and check `.stream === "stderr"`.
- **Only console.log `warn` and `error` entries** — skip `info` and `debug`.
- **Field pruning**: Strip `container_id`, `source_type`, `label`, `image` from logged entries to save space.
- **Byte budget**: Track cumulative console output size, cap at 128KB (half Cloudflare's limit, leaving headroom for request metadata).
- **Summary line**: Always emit one final `console.log` with `{_summary: true, total, logged, filtered, droppedByBudget, levels: {info: N, warn: N, error: N, ...}}` so filtered counts are visible.

### 2. Vector: Add `tag_level` transform in `vector.yaml`

Add a `remap` transform between `enrich` and the sink that:

- Parses `.message` (downcased) for level keywords
- Sets `.level` to `"error"`, `"warn"`, `"debug"`, or `"info"` (default)
- Promotes `stderr` entries without a keyword match to `"warn"`
- Update sink `inputs` from `enrich` to `tag_level`

This makes level detection cheap on the worker side (simple field read vs. regex).

### 3. Deployment order

Worker first (has fallback detection), then Vector config (SCP + `docker compose restart vector`).

## Verification

1. `cd workers/log-receiver && npm run dev` — send a mixed test batch with curl, confirm only warn/error entries appear in console + summary line
2. Deploy worker, check Cloudflare Dashboard logs — no more truncation warnings, only important entries visible
3. SCP updated `vector.yaml` to VPS, restart Vector, confirm logs still flow with `.level` field present

## Files to modify

- `workers/log-receiver/src/index.ts` — replace `handleLogs`, add `detectLevel`, constants
- `vector.yaml` — add `tag_level` transform, update sink input
