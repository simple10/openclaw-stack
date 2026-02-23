# Session Debug & Analytics Script

## Context

During multi-agent debugging (browser screenshot sandbox issue), we repeatedly needed to SSH into the VPS and write ad-hoc Python scripts to parse session JSONL files. This took dozens of turns and subagent spawns. A reusable debugging tool would save significant time for future investigations.

Existing `scripts/logs-session.sh` provides basic message rendering but no analytics, metrics, error extraction, or cross-session analysis.

## Design

Single Python 3 script at `scripts/debug-sessions.py` — no dependencies beyond stdlib. Runs directly on VPS or locally via SSH pipe. Uses ANSI colors and aligned columns for readability.

### Subcommands

#### `list [--agent <id>]`

List all sessions across all agents (or filtered). Shows:

- Agent ID, session ID (short), timestamp, duration, file size
- LLM turns, tool calls, total cost (from `usage.cost`)
- Stop reason (end_turn, error, context overflow)
- One-line summary of first user message

```
AGENT      SESSION   TIMESTAMP             SIZE    TURNS  TOOLS  COST     STOP
personal   5b43d1e2  2026-02-18 01:54 UTC   1.7K      1      0  $0.07   error (401)
personal   ea58ff77  2026-02-18 02:22 UTC    56K      4      3  $1.23   end_turn
personal   4e29832a  2026-02-18 02:23 UTC   1.4M     53     52  $89.42  error (prompt too long)
...
```

#### `trace <session-id> [--agent <id>]`

Full annotated trace — the same output format we built manually during debugging:

- Step number, tool name, command/path/action
- Result text (truncated, configurable with `--full`)
- LLM reasoning between steps (truncated)
- Color-coded: green=success, red=error, yellow=reasoning, dim=metadata
- Shows token count growth per turn

#### `metrics <session-id> [--agent <id>]`

Deep metrics for a single session:

- Total input/output/cache tokens and cost
- Token growth chart (text sparkline or bar per turn)
- Tool usage histogram (tool name → count, success, error)
- Duration (first→last timestamp)
- Context overflow detection

```
Session: 4e29832a | Agent: personal | Duration: 12m 34s

TOKENS                          COST
  Input:     616,839            Input:    $9.25
  Output:      7,723            Output:   $0.58
  Cache R:   145,000            Cache R:  $0.00
  Cache W:    89,000            Cache W:  $5.56
  Total:     858,562            Total:   $15.39

TOOL USAGE
  exec          22  ████████████████████  (18 ok, 4 error)
  browser       26  ████████████████████████  (22 ok, 4 error)
  read           2  ██  (1 ok, 1 error)
  write          1  █  (0 ok, 1 error)

CONTEXT GROWTH
  Turn  1: ████░░░░░░  52K
  Turn 20: ██████░░░░  120K
  Turn 40: ████████░░  280K
  Turn 53: ██████████  616K ← OVERFLOW
```

#### `errors <session-id> [--agent <id>]`

Extract only errors — tool call + error result pairs:

- Step number, tool name, command
- Full error text (untruncated)
- Categorizes: sandbox escape, network, filesystem, auth, context overflow

#### `summary [--agent <id>]`

Agent-level aggregate across all sessions:

- Total sessions, total cost, total tokens
- Most used tools, error rate per tool
- Average session duration, turns per session
- Recent activity timeline

### Session file discovery

Auto-discover from standard paths:

1. `/home/node/.openclaw/agents/` (inside gateway container)
2. `/home/openclaw/.openclaw/agents/` (on host via Sysbox mapping)
3. Accept `--base-dir` override

Handle both `.jsonl` and `.jsonl.deleted.*` / `.jsonl.reset.*` files (include archived sessions, mark them).

### Output formatting

- ANSI 256-color: red for errors, green for success, yellow for reasoning, cyan for headers, dim for metadata
- Aligned columns using string formatting
- Box-drawing characters for tables (consistent with existing `logs-session.sh`)
- `--no-color` flag for piping
- `--json` flag for machine-readable output

## File

- **Create:** `scripts/debug-sessions.py` — single self-contained Python 3 script, no external dependencies

## Verification

1. Copy to VPS: `scp -P 222 scripts/debug-sessions.py adminclaw@15.204.238.118:/tmp/`
2. Run on VPS: `ssh ... "sudo python3 /tmp/debug-sessions.py list --base-dir /home/openclaw/.openclaw/agents"`
3. Test each subcommand against the known personal agent sessions
4. Verify cost totals match the `usage.cost` data in session transcripts
