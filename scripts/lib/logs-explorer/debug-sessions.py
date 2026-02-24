#!/usr/bin/env python3
"""
OpenClaw session JSONL debug & analytics tool.

Usage:
  debug-sessions.py list [--agent <id>]
  debug-sessions.py trace <session-id> [--agent <id>] [--full]
  debug-sessions.py metrics <session-id> [--agent <id>]
  debug-sessions.py errors <session-id> [--agent <id>]
  debug-sessions.py summary [--agent <id>]
  debug-sessions.py llm-list [--agent <id>] [--model <model>] [--session <id>]
  debug-sessions.py llm-trace <session-id> [--agent <id>]
  debug-sessions.py llm-summary [--agent <id>]

Global options:
  --base-dir <path>   Override agents directory (default: auto-detect)
  --llm-log <path>    Override LLM log file path (default: auto-detect)
  --no-color          Disable ANSI colors
  --json              Machine-readable JSON output

Session JSONL schema (OpenClaw):
  Entry types: session, model_change, thinking_level_change, custom, message
  Message roles: user, assistant, toolResult
  Assistant content blocks: text, thinking, toolCall (arguments field, not input)
  Error detection: isError is always false — check details.status and content text

Telemetry log schema (telemetry.log):
  Each entry is wrapped in an envelope: { type, category, timestamp, agentId,
  sessionId, sessionKey, data: {...} }. LLM round-trips produce two entries:
  - type=llm_input: data.{runId, provider, model, toolCount, toolNames, ...}
  - type=llm_output: data.{runId, provider, model, inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens, stopReason, durationMs, toolCalls}
  The parser also handles legacy flat-format entries (event field instead of type).
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone


# ─── Colors ───────────────────────────────────────────────────────────────────


class C:
    """ANSI color codes."""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    LIGHT_BLUE = "\033[94m"

    @classmethod
    def disable(cls):
        for attr in list(vars(cls)):
            if attr.isupper() and isinstance(getattr(cls, attr), str):
                setattr(cls, attr, "")


def c(color, text):
    """Wrap text in ANSI color."""
    return f"{color}{text}{C.RESET}" if color else str(text)


# ─── Formatting Utilities ────────────────────────────────────────────────────


def human_size(size_bytes):
    for unit in ["B", "K", "M", "G"]:
        if abs(size_bytes) < 1024:
            return f"{size_bytes}{unit}" if unit == "B" else f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f}T"


def human_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K"
    return str(n)


def fmt_tokens(n):
    return f"{n:,}"


def fmt_cost(cost):
    if cost is None or cost == 0:
        return "$0.00"
    if cost < 0.01:
        return f"${cost:.4f}"
    return f"${cost:.2f}"


def fmt_duration(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 60:
        return f"{int(minutes)}m {int(seconds % 60)}s"
    hours = minutes / 60
    return f"{int(hours)}h {int(minutes) % 60}m"


def parse_timestamp(ts):
    """Parse timestamp — handles both ISO strings and Unix ms integers."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def truncate(text, max_len=120):
    if not text:
        return ""
    text = text.replace("\n", " ").replace("\r", "")
    return text if len(text) <= max_len else text[: max_len - 3] + "..."


def bar_chart(value, max_value, width=20):
    if max_value == 0:
        return "\u2591" * width
    filled = int(value / max_value * width)
    return "\u2588" * filled + "\u2591" * (width - filled)


# ─── JSONL Parsing ────────────────────────────────────────────────────────────


def parse_session_file(filepath):
    """Parse a session JSONL file into a list of records."""
    records = []
    with open(filepath, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records


def extract_text(content):
    """Extract plain text from a content array or string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def is_error_result(msg):
    """Detect if a toolResult represents an error.

    OpenClaw sets isError=false even on failures. Must check:
    - details.status == "error" or "forbidden"
    - Content text contains {"status":"error",...}
    - Content contains browser control error message
    """
    if msg.get("isError"):
        return True

    details = msg.get("details") or {}
    if isinstance(details, dict) and details.get("status") in ("error", "forbidden"):
        return True

    text = extract_text(msg.get("content", ""))
    if not text:
        return False

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and parsed.get("status") == "error":
            return True
    except (json.JSONDecodeError, TypeError):
        pass

    if "Can't reach" in text and "browser" in text.lower():
        return True

    return False


def categorize_error(text):
    """Categorize an error by type."""
    t = text.lower()
    if "escapes sandbox" in t or "sandbox root" in t:
        return "sandbox"
    if "can't reach" in t and "browser" in t:
        return "browser"
    if any(w in t for w in ("network", "dns", "econnrefused", "etimedout")):
        return "network"
    if any(w in t for w in ("permission", "eacces", "forbidden")):
        return "permission"
    if any(w in t for w in ("not found", "enoent", "no such file")):
        return "filesystem"
    if any(w in t for w in ("401", "403", "unauthorized")):
        return "auth"
    if any(w in t for w in ("too long", "overflow", "context")):
        return "context"
    return "other"


# ─── Session Discovery ───────────────────────────────────────────────────────


_install_dir = os.environ.get("INSTALL_DIR", "/home/openclaw")

DEFAULT_PATHS = [
    "/home/node/.openclaw/agents",  # Inside gateway container
    f"{_install_dir}/.openclaw/agents",  # On host via Sysbox mapping
]


def find_base_dir(override=None):
    if override:
        if os.path.isdir(override):
            return override
        print(c(C.RED, f"Error: directory not found: {override}"), file=sys.stderr)
        sys.exit(1)
    for path in DEFAULT_PATHS:
        if os.path.isdir(path):
            return path
    print(
        c(C.RED, "Error: no agents directory found. Use --base-dir."), file=sys.stderr
    )
    sys.exit(1)


def discover_sessions(base_dir, agent_filter=None):
    """Discover all session files.

    Returns list of dicts: agent, session_id, filepath, status, mtime, size
    """
    sessions = []

    if agent_filter:
        agent_dirs = [os.path.join(base_dir, agent_filter)]
    else:
        try:
            agent_dirs = sorted(
                os.path.join(base_dir, d)
                for d in os.listdir(base_dir)
                if os.path.isdir(os.path.join(base_dir, d))
            )
        except PermissionError:
            print(c(C.RED, f"Error: permission denied: {base_dir}"), file=sys.stderr)
            sys.exit(1)

    for agent_dir in agent_dirs:
        agent_id = os.path.basename(agent_dir)
        sessions_dir = os.path.join(agent_dir, "sessions")
        if not os.path.isdir(sessions_dir):
            continue

        try:
            entries = os.listdir(sessions_dir)
        except PermissionError:
            continue

        for fname in entries:
            # Match: {uuid}.jsonl, {uuid}.jsonl.deleted.{ts}, {uuid}.jsonl.reset.{ts}
            if ".jsonl" not in fname or fname == "sessions.json":
                continue

            filepath = os.path.join(sessions_dir, fname)
            if not os.path.isfile(filepath):
                continue

            parts = fname.split(".jsonl")
            session_id = parts[0]
            suffix = parts[1] if len(parts) > 1 else ""

            if ".deleted" in suffix:
                status = "deleted"
            elif ".reset" in suffix:
                status = "reset"
            else:
                status = "active"

            try:
                stat = os.stat(filepath)
                sessions.append(
                    {
                        "agent": agent_id,
                        "session_id": session_id,
                        "filepath": filepath,
                        "status": status,
                        "mtime": stat.st_mtime,
                        "size": stat.st_size,
                    }
                )
            except OSError:
                pass

    return sorted(sessions, key=lambda s: s["mtime"])


def find_session(base_dir, session_id, agent_filter=None):
    """Find a specific session by ID (supports prefix match)."""
    all_sessions = discover_sessions(base_dir, agent_filter)

    # Exact match
    matches = [s for s in all_sessions if s["session_id"] == session_id]
    if matches:
        return matches[-1]

    # Prefix match
    matches = [s for s in all_sessions if s["session_id"].startswith(session_id)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(
            c(C.YELLOW, f"Ambiguous session ID '{session_id}' matches:"),
            file=sys.stderr,
        )
        for m in matches:
            print(f"  {m['agent']}/{m['session_id'][:12]}...", file=sys.stderr)
        sys.exit(1)

    print(c(C.RED, f"Error: session not found: {session_id}"), file=sys.stderr)
    sys.exit(1)


# ─── Session Analysis ────────────────────────────────────────────────────────


def analyze_session(records):
    """Analyze parsed session records into a summary dict."""
    result = {
        "first_ts": None,
        "last_ts": None,
        "model": None,
        "provider": None,
        "assistant_turns": 0,
        "user_turns": 0,
        "tool_calls": 0,
        "tool_results": 0,
        "tool_errors": 0,
        "total_cost": 0.0,
        "cost_breakdown": defaultdict(float),
        "tokens": defaultdict(int),
        "stop_reason": None,
        "first_user_msg": "",
        "tools": defaultdict(lambda: {"count": 0, "errors": 0}),
        "turns": [],
        "errors": [],
    }

    pending_calls = {}  # toolCallId -> {name, summary, step, args}
    step = 0

    for record in records:
        rtype = record.get("type")

        if rtype == "session":
            ts = parse_timestamp(record.get("timestamp"))
            if ts and not result["first_ts"]:
                result["first_ts"] = ts

        elif rtype == "model_change":
            result["model"] = record.get("modelId")
            result["provider"] = record.get("provider")

        elif rtype == "message":
            msg = record.get("message", {})
            role = msg.get("role")
            ts = parse_timestamp(msg.get("timestamp") or record.get("timestamp"))

            if ts:
                if not result["first_ts"]:
                    result["first_ts"] = ts
                result["last_ts"] = ts

            if role == "user":
                result["user_turns"] += 1
                text = extract_text(msg.get("content", ""))
                if not result["first_user_msg"] and text:
                    result["first_user_msg"] = text

            elif role == "assistant":
                result["assistant_turns"] += 1
                usage = msg.get("usage", {})
                stop = msg.get("stopReason")
                if stop:
                    result["stop_reason"] = stop

                # Token tracking
                if usage:
                    for key in (
                        "input",
                        "output",
                        "cacheRead",
                        "cacheWrite",
                        "totalTokens",
                    ):
                        result["tokens"][key] += usage.get(key, 0) or 0

                    cost = usage.get("cost", {})
                    if isinstance(cost, dict):
                        for key in (
                            "total",
                            "input",
                            "output",
                            "cacheRead",
                            "cacheWrite",
                        ):
                            result["cost_breakdown"][key] += cost.get(key, 0) or 0
                        result["total_cost"] += cost.get("total", 0) or 0
                    elif isinstance(cost, (int, float)):
                        result["total_cost"] += cost
                        result["cost_breakdown"]["total"] += cost

                # Per-turn data
                turn_cost = 0
                cost = usage.get("cost", {}) if usage else {}
                if isinstance(cost, dict):
                    turn_cost = cost.get("total", 0) or 0
                elif isinstance(cost, (int, float)):
                    turn_cost = cost

                result["turns"].append(
                    {
                        "step": result["assistant_turns"],
                        "input_tokens": (usage or {}).get("input", 0) or 0,
                        "output_tokens": (usage or {}).get("output", 0) or 0,
                        "cache_read": (usage or {}).get("cacheRead", 0) or 0,
                        "cache_write": (usage or {}).get("cacheWrite", 0) or 0,
                        "total_tokens": (usage or {}).get("totalTokens", 0) or 0,
                        "cost": turn_cost,
                        "stop_reason": stop,
                        "timestamp": ts,
                    }
                )

                # Count tool calls
                content = msg.get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "toolCall"
                        ):
                            step += 1
                            result["tool_calls"] += 1
                            tool_name = block.get("name", "?")
                            result["tools"][tool_name]["count"] += 1
                            call_id = block.get("id", "")
                            args = block.get("arguments", {})

                            summary = ""
                            if isinstance(args, dict):
                                if tool_name == "exec":
                                    summary = truncate(
                                        args.get("command", ""), 120
                                    )
                                elif tool_name in ("read", "write"):
                                    summary = args.get(
                                        "path", args.get("file", "")
                                    )
                                else:
                                    summary = truncate(json.dumps(args), 120)
                            elif isinstance(args, str):
                                summary = truncate(args, 120)

                            pending_calls[call_id] = {
                                "name": tool_name,
                                "summary": summary,
                                "step": step,
                                "args": args,
                            }

            elif role == "toolResult":
                result["tool_results"] += 1
                tool_name = msg.get("toolName", "?")
                call_id = msg.get("toolCallId", "")
                is_err = is_error_result(msg)

                if is_err:
                    result["tool_errors"] += 1
                    result["tools"][tool_name]["errors"] += 1
                    call_info = pending_calls.get(call_id, {})
                    error_text = extract_text(msg.get("content", ""))
                    result["errors"].append(
                        {
                            "step": call_info.get("step", "?"),
                            "tool": tool_name,
                            "command": call_info.get("summary", ""),
                            "error": error_text,
                            "category": categorize_error(error_text),
                            "args": call_info.get("args", {}),
                        }
                    )

    return result


# ─── LLM Log Parsing ────────────────────────────────────────────────────────

# Per-million-token pricing (input, output, cache_read, cache_write)
# cache_write is 25% more than base input price per Anthropic pricing
MODEL_PRICING = {
    "claude-opus-4": (15.0, 75.0, 1.50, 18.75),
    "claude-sonnet-4": (3.0, 15.0, 0.30, 3.75),
    "claude-haiku-4": (0.80, 4.0, 0.08, 1.00),
    "claude-3-5-sonnet": (3.0, 15.0, 0.30, 3.75),
    "claude-3-5-haiku": (0.80, 4.0, 0.08, 1.00),
    "claude-3-opus": (15.0, 75.0, 1.50, 18.75),
}

DEFAULT_LLM_LOG_PATHS = [
    "/home/node/.openclaw/logs/telemetry.log",
    f"{_install_dir}/.openclaw/logs/telemetry.log",
    "/home/node/.openclaw/logs/llm.log",        # legacy fallback
    f"{_install_dir}/.openclaw/logs/llm.log",     # legacy fallback
]


def find_llm_log(override=None):
    if override:
        if os.path.isfile(override):
            return override
        print(c(C.RED, f"Error: LLM log not found: {override}"), file=sys.stderr)
        print(c(C.DIM, "Enable the telemetry plugin in openclaw.json"), file=sys.stderr)
        sys.exit(1)
    for path in DEFAULT_LLM_LOG_PATHS:
        if os.path.isfile(path):
            return path
    print(c(C.RED, "Error: LLM log not found."), file=sys.stderr)
    print(c(C.DIM, "Enable the telemetry plugin in openclaw.json"), file=sys.stderr)
    print(c(C.DIM, "Then restart the gateway."), file=sys.stderr)
    sys.exit(1)


def match_model_pricing(model):
    """Match model name to pricing table using prefix matching (strip date suffixes)."""
    if not model:
        return None
    m = model.lower()
    # Try exact match first
    if m in MODEL_PRICING:
        return MODEL_PRICING[m]
    # Strip date suffix (e.g. "-20250929") and try again
    for prefix in sorted(MODEL_PRICING.keys(), key=len, reverse=True):
        if m.startswith(prefix):
            return MODEL_PRICING[prefix]
    return None


def estimate_cost(model, input_tok, output_tok, cache_read=0, cache_write=0):
    """Estimate cost from token counts and model pricing."""
    pricing = match_model_pricing(model)
    if not pricing:
        return None
    p_in, p_out, p_cr, p_cw = pricing
    return (
        input_tok * p_in / 1_000_000
        + output_tok * p_out / 1_000_000
        + cache_read * p_cr / 1_000_000
        + cache_write * p_cw / 1_000_000
    )


def _flatten_entry(raw):
    """Normalize a telemetry log entry to a flat dict.

    The telemetry plugin (v2) wraps data in an envelope:
      { type, category, timestamp, agentId, sessionId, sessionKey, data: {...} }
    The old llmetry plugin wrote flat entries:
      { event, agentId, model, ... }
    This function merges both formats into a flat dict with an "event" key.
    """
    data = raw.get("data")
    if data and isinstance(data, dict):
        # Telemetry v2 envelope — merge top-level envelope fields with nested data
        flat = {**data}
        flat["event"] = raw.get("type")
        for k in ("timestamp", "agentId", "sessionId", "sessionKey"):
            if raw.get(k) and not flat.get(k):
                flat[k] = raw[k]
        return flat
    # Legacy flat format (or unknown) — use as-is
    raw.setdefault("event", raw.get("type"))
    return raw


def parse_llm_log(filepath):
    """Parse LLM log JSONL, pair input/output into call records.

    Pairing strategy:
    - If entries have runId: pair by runId (future-proof)
    - Otherwise: pair sequentially by sessionKey (last input matches next output)

    Returns list of dicts with merged fields from both input and output entries.
    Processes line-by-line to handle large files efficiently.
    """
    pending_inputs = {}  # runId or sessionKey -> entry
    calls = []

    with open(filepath, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue

            entry = _flatten_entry(raw)

            event = entry.get("event")
            if event not in ("llm_input", "llm_output"):
                continue

            # Use runId if available, otherwise fall back to sessionKey
            run_id = entry.get("runId")
            pair_key = run_id or entry.get("sessionKey") or entry.get("sessionId") or "_default"

            if event == "llm_input":
                pending_inputs[pair_key] = entry
            elif event == "llm_output":
                inp = pending_inputs.pop(pair_key, {})

                # Normalize token usage — check usage object (both naming conventions) and top-level fields
                usage = entry.get("usage") or {}
                input_tok = usage.get("inputTokens") or usage.get("input") or entry.get("inputTokens") or 0
                output_tok = usage.get("outputTokens") or usage.get("output") or entry.get("outputTokens") or 0
                cache_read = usage.get("cacheReadTokens") or usage.get("cacheRead") or entry.get("cacheReadTokens") or 0
                cache_write = usage.get("cacheWriteTokens") or usage.get("cacheWrite") or entry.get("cacheWriteTokens") or 0

                model = entry.get("model") or inp.get("model") or ""
                cost = estimate_cost(model, input_tok, output_tok, cache_read, cache_write)

                # Tool calls from output
                tool_calls = entry.get("toolCalls") or []
                tool_names = [tc.get("name", "?") for tc in tool_calls if isinstance(tc, dict)]

                calls.append({
                    "timestamp": entry.get("timestamp") or inp.get("timestamp"),
                    "agentId": entry.get("agentId") or inp.get("agentId") or "",
                    "sessionId": entry.get("sessionId") or inp.get("sessionId") or "",
                    "sessionKey": entry.get("sessionKey") or inp.get("sessionKey") or "",
                    "runId": run_id or "",
                    "provider": entry.get("provider") or inp.get("provider") or "",
                    "model": model,
                    "inputTokens": input_tok,
                    "outputTokens": output_tok,
                    "cacheReadTokens": cache_read,
                    "cacheWriteTokens": cache_write,
                    "cost": cost,
                    "durationMs": entry.get("durationMs"),
                    "stopReason": entry.get("stopReason") or "",
                    "toolNames": tool_names,
                    "toolCount": inp.get("toolCount"),
                })

    return calls


# ─── Commands ─────────────────────────────────────────────────────────────────


def cmd_list(args):
    """List all sessions across agents."""
    base_dir = find_base_dir(args.base_dir)
    sessions = discover_sessions(base_dir, args.agent)

    if not sessions:
        print("No sessions found.")
        return

    if args.json_output:
        results = []
        for s in sessions:
            records = parse_session_file(s["filepath"])
            a = analyze_session(records)
            results.append(
                {
                    "agent": s["agent"],
                    "session_id": s["session_id"],
                    "status": s["status"],
                    "size": s["size"],
                    "timestamp": a["first_ts"].isoformat()
                    if a["first_ts"]
                    else None,
                    "turns": a["assistant_turns"],
                    "tool_calls": a["tool_calls"],
                    "errors": a["tool_errors"],
                    "cost": a["total_cost"],
                    "stop_reason": a["stop_reason"],
                    "first_message": truncate(a["first_user_msg"], 200),
                }
            )
        json.dump(results, sys.stdout, indent=2)
        print()
        return

    # Column widths: AGENT(12) SESSION(10) TIMESTAMP(21) SIZE(6) TURNS(5) TOOLS(5) ERRS(4) COST(8) STOP(12) MSG
    hdr = (
        f"{'AGENT':12s} {'SESSION':10s} {'TIMESTAMP':21s} {'SIZE':>6s} "
        f"{'TURNS':>5s} {'TOOLS':>5s} {'ERRS':>4s} {'COST':>8s} {'STOP':12s} {'MESSAGE'}"
    )
    print(c(C.BOLD + C.CYAN, hdr))
    print(c(C.DIM, "\u2500" * 120))

    for s in sessions:
        records = parse_session_file(s["filepath"])
        a = analyze_session(records)

        ts_str = (
            a["first_ts"].strftime("%Y-%m-%d %H:%M UTC") if a["first_ts"] else "?"
        )

        # Status suffix
        status_mark = ""
        if s["status"] == "deleted":
            status_mark = c(C.RED, " \u2717")
        elif s["status"] == "reset":
            status_mark = c(C.YELLOW, " \u21ba")

        # Pad plain text, then apply color for columns that may be colored
        errs_plain = f"{a['tool_errors']:>4d}"
        errs_col = c(C.RED, errs_plain) if a["tool_errors"] > 0 else errs_plain

        cost_plain = f"{fmt_cost(a['total_cost']):>8s}"
        if a["total_cost"] > 10:
            cost_col = c(C.RED + C.BOLD, cost_plain)
        elif a["total_cost"] > 1:
            cost_col = c(C.YELLOW, cost_plain)
        else:
            cost_col = cost_plain

        stop = a["stop_reason"] or "?"
        stop_plain = f"{stop:12s}"
        if stop in ("stop", "end_turn"):
            stop_col = c(C.GREEN, stop_plain)
        elif "error" in str(stop).lower():
            stop_col = c(C.RED, stop_plain)
        else:
            stop_col = stop_plain

        msg_preview = truncate(a["first_user_msg"], 40)

        print(
            f"{s['agent']:12s} {s['session_id'][:8]:10s} {ts_str:21s} "
            f"{human_size(s['size']):>6s} {a['assistant_turns']:>5d} "
            f"{a['tool_calls']:>5d} {errs_col} {cost_col} "
            f"{stop_col} {c(C.DIM, msg_preview)}{status_mark}"
        )


def cmd_trace(args):
    """Full annotated trace of a session."""
    base_dir = find_base_dir(args.base_dir)
    session = find_session(base_dir, args.session_id, args.agent)
    records = parse_session_file(session["filepath"])

    max_text = 0 if args.full else 200

    # Header
    print(c(C.BOLD + C.CYAN, "\u2550" * 80))
    hdr = f" TRACE: {session['agent']}/{session['session_id'][:12]}"
    if session["status"] != "active":
        hdr += f"  ({session['status']})"
    print(c(C.BOLD + C.CYAN, hdr))
    print(c(C.BOLD + C.CYAN, "\u2550" * 80))
    print()

    step = 0
    cumulative_tokens = 0
    pending_calls = {}

    for record in records:
        rtype = record.get("type")

        if rtype == "session":
            ts = parse_timestamp(record.get("timestamp"))
            if ts:
                print(c(C.DIM, f"  Started: {ts.strftime('%Y-%m-%d %H:%M:%S UTC')}"))

        elif rtype == "model_change":
            model = record.get("modelId", "?")
            provider = record.get("provider", "?")
            print(c(C.DIM, f"  Model: {provider}:{model}"))
            print()

        elif rtype == "message":
            msg = record.get("message", {})
            role = msg.get("role")

            if role == "user":
                text = extract_text(msg.get("content", ""))
                if text:
                    display = text if max_text == 0 else truncate(text, max_text)
                    print(c(C.BOLD + C.CYAN, "\u250c\u2500 USER"))
                    for line in display.split("\n"):
                        print(c(C.CYAN, f"\u2502 {line}"))
                    print(c(C.CYAN, "\u2514" + "\u2500" * 79))
                    print()

            elif role == "assistant":
                usage = msg.get("usage", {})
                total_tok = (usage or {}).get("totalTokens", 0) or 0
                cumulative_tokens += total_tok
                cost = (usage or {}).get("cost", {})
                turn_cost = 0
                if isinstance(cost, dict):
                    turn_cost = cost.get("total", 0) or 0
                elif isinstance(cost, (int, float)):
                    turn_cost = cost
                stop = msg.get("stopReason", "")

                content = msg.get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type")

                        if btype == "thinking":
                            text = block.get("thinking", "")
                            if text:
                                display = (
                                    text
                                    if max_text == 0
                                    else truncate(text, max_text)
                                )
                                print(c(C.DIM, f"  \U0001f4ad {display}"))

                        elif btype == "text":
                            text = block.get("text", "")
                            if text:
                                display = (
                                    text
                                    if max_text == 0
                                    else truncate(text, 300)
                                )
                                print(c(C.WHITE, f"  \U0001f4ac {display}"))

                        elif btype == "toolCall":
                            step += 1
                            name = block.get("name", "?")
                            call_id = block.get("id", "")
                            args = block.get("arguments", {})

                            summary = _tool_call_summary(name, args)
                            if max_text > 0:
                                summary = truncate(summary, 120)

                            pending_calls[call_id] = {
                                "name": name,
                                "step": step,
                            }
                            print(
                                c(C.WHITE, f"  [{step:3d}]")
                                + c(C.YELLOW + C.BOLD, f" {name}")
                                + c(C.DIM, f"  {summary}")
                            )

                # Turn metadata line
                meta = []
                if total_tok > 0:
                    meta.append(f"tokens: {fmt_tokens(total_tok)}")
                meta.append(f"cumul: {human_tokens(cumulative_tokens)}")
                if turn_cost > 0:
                    meta.append(f"cost: {fmt_cost(turn_cost)}")
                if stop and stop not in ("stop", "end_turn"):
                    meta.append(c(C.RED, f"stop: {stop}"))
                if meta:
                    print(c(C.DIM, f"        {' | '.join(meta)}"))
                print()

            elif role == "toolResult":
                tool_name = msg.get("toolName", "?")
                call_id = msg.get("toolCallId", "")
                is_err = is_error_result(msg)
                text = extract_text(msg.get("content", ""))
                call_info = pending_calls.get(call_id, {})
                step_num = call_info.get("step", "?")

                if is_err:
                    display = text if max_text == 0 else truncate(text, 300)
                    print(
                        c(C.WHITE, f"  [{step_num:>3}]")
                        + c(C.RED, f" \u2717 ")
                        + c(C.YELLOW, f"{tool_name}: ")
                        + c(C.RED, display)
                    )
                else:
                    display = text if max_text == 0 else truncate(text, 200)
                    print(
                        c(C.WHITE, f"  [{step_num:>3}]")
                        + c(C.GREEN, f" \u2713 ")
                        + c(C.YELLOW, f"{tool_name}")
                        + c(C.DIM, f"  {display}")
                    )
                print()


def cmd_metrics(args):
    """Deep metrics for a single session."""
    base_dir = find_base_dir(args.base_dir)
    session = find_session(base_dir, args.session_id, args.agent)
    records = parse_session_file(session["filepath"])
    a = analyze_session(records)

    if args.json_output:
        json.dump(
            {
                "agent": session["agent"],
                "session_id": session["session_id"],
                "status": session["status"],
                "duration_seconds": (a["last_ts"] - a["first_ts"]).total_seconds()
                if a["first_ts"] and a["last_ts"]
                else None,
                "tokens": dict(a["tokens"]),
                "cost": dict(a["cost_breakdown"]),
                "total_cost": a["total_cost"],
                "assistant_turns": a["assistant_turns"],
                "user_turns": a["user_turns"],
                "tool_calls": a["tool_calls"],
                "tool_errors": a["tool_errors"],
                "tools": {k: dict(v) for k, v in a["tools"].items()},
                "stop_reason": a["stop_reason"],
            },
            sys.stdout,
            indent=2,
        )
        print()
        return

    # Header
    duration = ""
    if a["first_ts"] and a["last_ts"]:
        delta = (a["last_ts"] - a["first_ts"]).total_seconds()
        duration = fmt_duration(delta)

    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    parts = [f"Session: {session['session_id'][:12]}", f"Agent: {session['agent']}"]
    if duration:
        parts.append(f"Duration: {duration}")
    print(c(C.BOLD, f" {' \u2502 '.join(parts)}"))
    if session["status"] != "active":
        print(c(C.YELLOW, f" Status: {session['status']}"))
    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    print()

    # Tokens & Cost
    tok = a["tokens"]
    cost = a["cost_breakdown"]

    print(c(C.BOLD, " TOKENS") + " " * 26 + c(C.BOLD, "COST"))
    rows = [
        ("Input:", "input"),
        ("Output:", "output"),
        ("Cache R:", "cacheRead"),
        ("Cache W:", "cacheWrite"),
    ]
    for label, key in rows:
        print(
            f"   {label:10s} {fmt_tokens(tok.get(key, 0)):>12s}"
            f"            {label:10s} {fmt_cost(cost.get(key, 0)):>10s}"
        )
    print(c(C.DIM, "   " + "\u2500" * 24 + "            " + "\u2500" * 22))
    print(
        f"   {'Total:':10s} {fmt_tokens(tok.get('totalTokens', 0)):>12s}"
        f"            {c(C.BOLD, 'Total:'):10s} {c(C.BOLD, fmt_cost(a['total_cost'])):>10s}"
    )
    print()

    # Turn summary
    err_str = (
        c(C.RED, str(a["tool_errors"]))
        if a["tool_errors"] > 0
        else c(C.GREEN, "0")
    )
    print(
        f"   Turns: {a['assistant_turns']}  \u2502  "
        f"Tool calls: {a['tool_calls']}  \u2502  "
        f"Errors: {err_str}"
    )
    print()

    # Tool usage histogram
    if a["tools"]:
        print(c(C.BOLD, " TOOL USAGE"))
        max_count = max(t["count"] for t in a["tools"].values())
        bar_width = 30

        for name in sorted(
            a["tools"], key=lambda n: a["tools"][n]["count"], reverse=True
        ):
            t = a["tools"][name]
            bar = bar_chart(t["count"], max_count, bar_width)
            ok = t["count"] - t["errors"]
            err_part = ""
            if t["errors"] > 0:
                err_part = c(C.RED, f", {t['errors']} err")
            print(f"   {name:18s} {t['count']:>3d}  {bar}  ({ok} ok{err_part})")
        print()

    # Context growth chart
    if a["turns"]:
        print(c(C.BOLD, " CONTEXT GROWTH (input + cache read = prompt size)"))
        # Context size = input + cacheRead (input alone is just non-cached tokens)
        context_sizes = [
            t["input_tokens"] + t["cache_read"] for t in a["turns"]
        ]
        max_ctx = max(context_sizes) if context_sizes else 1
        chart_width = 30

        total_turns = len(a["turns"])
        if total_turns <= 15:
            show_indices = list(range(total_turns))
        else:
            show_indices = sorted(
                set(
                    [0]
                    + [int(i * (total_turns - 1) / 9) for i in range(1, 9)]
                    + [total_turns - 1]
                )
            )

        for idx in show_indices:
            t = a["turns"][idx]
            ctx_size = context_sizes[idx]
            bar = bar_chart(ctx_size, max_ctx, chart_width)
            suffix = ""
            if (
                idx == total_turns - 1
                and a["stop_reason"]
                and a["stop_reason"] not in ("stop", "end_turn")
            ):
                suffix = c(C.RED, f" \u2190 {a['stop_reason']}")
            print(
                f"   Turn {t['step']:>3d}: {bar}  {human_tokens(ctx_size)}{suffix}"
            )
        print()


def cmd_errors(args):
    """Extract errors from a session."""
    base_dir = find_base_dir(args.base_dir)
    session = find_session(base_dir, args.session_id, args.agent)
    records = parse_session_file(session["filepath"])
    a = analyze_session(records)

    if args.json_output:
        json.dump(
            {
                "agent": session["agent"],
                "session_id": session["session_id"],
                "total_errors": len(a["errors"]),
                "errors": a["errors"],
            },
            sys.stdout,
            indent=2,
            default=str,
        )
        print()
        return

    if not a["errors"]:
        print(c(C.GREEN, "No errors found in this session."))
        return

    print(c(C.BOLD + C.CYAN, "\u2550" * 80))
    print(c(C.BOLD, f" ERRORS: {session['agent']}/{session['session_id'][:12]}"))
    print(c(C.BOLD, f" Total: {len(a['errors'])} errors"))
    print(c(C.BOLD + C.CYAN, "\u2550" * 80))
    print()

    # Category summary
    by_cat = defaultdict(list)
    for err in a["errors"]:
        by_cat[err["category"]].append(err)

    print(c(C.BOLD, " BY CATEGORY"))
    for cat in sorted(by_cat, key=lambda k: len(by_cat[k]), reverse=True):
        print(f"   {cat:15s}  {len(by_cat[cat])}")
    print()

    # Individual errors
    for i, err in enumerate(a["errors"], 1):
        cat_color = (
            C.RED if err["category"] in ("sandbox", "auth", "context") else C.YELLOW
        )
        print(
            c(C.BOLD + C.RED, f"  \u2500\u2500\u2500 Error {i} \u2500\u2500\u2500")
            + c(C.DIM, f"  step {err['step']}  \u2502  ")
            + c(cat_color, err["category"])
        )
        print(c(C.CYAN, f"  Tool: {err['tool']}"))
        if err["command"]:
            print(c(C.DIM, f"  Call: {err['command']}"))

        # Extract error message — try to unwrap JSON envelope
        error_text = err["error"]
        try:
            parsed = json.loads(error_text)
            if isinstance(parsed, dict) and "error" in parsed:
                error_text = parsed["error"]
        except (json.JSONDecodeError, TypeError):
            pass

        lines = error_text.split("\n")
        for line in lines[:20]:
            print(c(C.RED, f"  \u2502 {line}"))
        if len(lines) > 20:
            print(c(C.DIM, f"  \u2502 ... ({len(lines) - 20} more lines)"))
        print()


def cmd_summary(args):
    """Agent-level aggregate summary across all sessions."""
    base_dir = find_base_dir(args.base_dir)
    sessions = discover_sessions(base_dir, args.agent)

    if not sessions:
        print("No sessions found.")
        return

    by_agent = defaultdict(list)
    for s in sessions:
        by_agent[s["agent"]].append(s)

    all_stats = {}

    for agent_id in sorted(by_agent):
        agent_sessions = by_agent[agent_id]
        stats = {
            "total_sessions": len(agent_sessions),
            "active_sessions": sum(
                1 for s in agent_sessions if s["status"] == "active"
            ),
            "total_size": sum(s["size"] for s in agent_sessions),
            "total_cost": 0.0,
            "total_tokens": 0,
            "total_turns": 0,
            "total_tool_calls": 0,
            "total_errors": 0,
            "tools": defaultdict(lambda: {"count": 0, "errors": 0}),
            "durations": [],
        }

        for s in agent_sessions:
            records = parse_session_file(s["filepath"])
            a = analyze_session(records)
            stats["total_cost"] += a["total_cost"]
            stats["total_tokens"] += a["tokens"].get("totalTokens", 0)
            stats["total_turns"] += a["assistant_turns"]
            stats["total_tool_calls"] += a["tool_calls"]
            stats["total_errors"] += a["tool_errors"]

            for tool_name, tool_data in a["tools"].items():
                stats["tools"][tool_name]["count"] += tool_data["count"]
                stats["tools"][tool_name]["errors"] += tool_data["errors"]

            if a["first_ts"] and a["last_ts"]:
                dur = (a["last_ts"] - a["first_ts"]).total_seconds()
                if dur > 0:
                    stats["durations"].append(dur)

        all_stats[agent_id] = stats

    if args.json_output:
        output = {}
        for agent_id, stats in all_stats.items():
            s = dict(stats)
            s["tools"] = {k: dict(v) for k, v in s["tools"].items()}
            s["avg_duration"] = (
                sum(s["durations"]) / len(s["durations"]) if s["durations"] else 0
            )
            del s["durations"]
            output[agent_id] = s
        json.dump(output, sys.stdout, indent=2)
        print()
        return

    grand_cost = sum(s["total_cost"] for s in all_stats.values())
    grand_sessions = sum(s["total_sessions"] for s in all_stats.values())
    grand_tokens = sum(s["total_tokens"] for s in all_stats.values())

    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    print(
        c(
            C.BOLD,
            f" SUMMARY \u2014 {grand_sessions} sessions across {len(all_stats)} agents",
        )
    )
    print(
        c(
            C.BOLD,
            f" Total cost: {fmt_cost(grand_cost)}  \u2502  "
            f"Total tokens: {fmt_tokens(grand_tokens)}",
        )
    )
    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    print()

    for agent_id, stats in sorted(all_stats.items()):
        print(c(C.BOLD + C.MAGENTA, f" \u250c\u2500 {agent_id}"))
        print(
            f" \u2502  Sessions: {stats['total_sessions']} "
            f"({stats['active_sessions']} active)  \u2502  "
            f"Size: {human_size(stats['total_size'])}  \u2502  "
            f"Cost: {c(C.BOLD, fmt_cost(stats['total_cost']))}"
        )

        err_part = ""
        if stats["total_tool_calls"] > 0:
            err_rate = stats["total_errors"] / stats["total_tool_calls"] * 100
            if stats["total_errors"] > 0:
                err_part = c(C.RED, f"{stats['total_errors']} ({err_rate:.0f}%)")
            else:
                err_part = c(C.GREEN, "0")
        else:
            err_part = "0"

        print(
            f" \u2502  Turns: {stats['total_turns']}  \u2502  "
            f"Tool calls: {stats['total_tool_calls']}  \u2502  "
            f"Errors: {err_part}"
        )

        if stats["durations"]:
            avg_dur = sum(stats["durations"]) / len(stats["durations"])
            print(f" \u2502  Avg duration: {fmt_duration(avg_dur)}")

        if stats["tools"]:
            top = sorted(
                stats["tools"].items(), key=lambda x: x[1]["count"], reverse=True
            )[:5]
            tool_strs = []
            for name, t in top:
                err_s = f" ({t['errors']}\u2717)" if t["errors"] > 0 else ""
                tool_strs.append(f"{name}:{t['count']}{err_s}")
            print(f" \u2502  Top tools: {', '.join(tool_strs)}")

        print(c(C.MAGENTA, " \u2514" + "\u2500" * 69))
        print()


# ─── LLM Commands ────────────────────────────────────────────────────────────


def cmd_llm_list(args):
    """List LLM calls from the telemetry log file."""
    log_path = find_llm_log(args.llm_log)
    calls = parse_llm_log(log_path)

    # Apply filters
    if args.agent:
        calls = [c for c in calls if c["agentId"] == args.agent]
    if args.model:
        calls = [c for c in calls if args.model.lower() in (c["model"] or "").lower()]
    if args.session:
        calls = [c for c in calls if c["sessionId"] and c["sessionId"].startswith(args.session)]

    if not calls:
        print("No LLM calls found.")
        return

    if args.json_output:
        json.dump(calls, sys.stdout, indent=2)
        print()
        return

    hdr = (
        f"{'TIMESTAMP':21s} {'AGENT':12s} {'MODEL':24s} {'DUR':>6s} "
        f"{'IN_TOK':>7s} {'OUT_TOK':>7s} {'CACHE_R':>7s} {'CACHE_W':>7s} {'COST':>8s} "
        f"{'STOP':12s} {'TOOLS'}"
    )
    print(c(C.BOLD + C.CYAN, hdr))
    print(c(C.DIM, "\u2500" * 140))

    for call in calls:
        ts = ""
        if call["timestamp"]:
            dt = parse_timestamp(call["timestamp"])
            if dt:
                ts = dt.strftime("%Y-%m-%d %H:%M UTC")

        dur = ""
        if call["durationMs"] is not None:
            dur = f"{call['durationMs'] / 1000:.1f}s"

        model = (call["model"] or "?")[:24]
        cost_val = call["cost"]
        cost_str = fmt_cost(cost_val) if cost_val is not None else "?"

        # Color cost
        if cost_val is not None and cost_val > 1:
            cost_col = c(C.RED + C.BOLD, f"{cost_str:>8s}")
        elif cost_val is not None and cost_val > 0.1:
            cost_col = c(C.YELLOW, f"{cost_str:>8s}")
        else:
            cost_col = f"{cost_str:>8s}"

        stop = (call["stopReason"] or "?")[:12]
        if stop in ("stop", "end_turn"):
            stop_col = c(C.GREEN, f"{stop:12s}")
        else:
            stop_col = f"{stop:12s}"

        tools = ",".join(call["toolNames"][:4])
        if len(call["toolNames"]) > 4:
            tools += f"+{len(call['toolNames']) - 4}"

        print(
            f"{ts:21s} {call['agentId'][:12]:12s} {model:24s} {dur:>6s} "
            f"{human_tokens(call['inputTokens']):>7s} "
            f"{human_tokens(call['outputTokens']):>7s} "
            f"{human_tokens(call['cacheReadTokens']):>7s} "
            f"{human_tokens(call['cacheWriteTokens']):>7s} "
            f"{cost_col} {stop_col} {c(C.DIM, tools)}"
        )


def _extract_user_turns(records):
    """Extract per-user-turn tool call and result data from session records.

    Returns a list of dicts, one per user turn, each containing:
      - user_ts: timestamp of the user message
      - user_text: truncated user message text
      - tool_calls: list of {step, name, summary, result_ok, result_text}
      - response_text: truncated final assistant text response
    """
    turns = []
    current_turn = None
    step = 0
    pending_calls = {}  # call_id -> index in current_turn["tool_calls"]

    for record in records:
        rtype = record.get("type")
        if rtype != "message":
            continue

        msg = record.get("message", {})
        role = msg.get("role")

        if role == "user":
            # Start a new user turn
            ts = parse_timestamp(msg.get("timestamp") or record.get("timestamp"))
            text = extract_text(msg.get("content", ""))
            current_turn = {
                "user_ts": ts,
                "user_text": truncate(text, 200) if text else "",
                "tool_calls": [],
                "response_text": "",
            }
            turns.append(current_turn)
            pending_calls = {}

        elif role == "assistant" and current_turn is not None:
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "toolCall":
                        step += 1
                        name = block.get("name", "?")
                        call_id = block.get("id", "")
                        args = block.get("arguments", {})
                        summary = _tool_call_summary(name, args)
                        tc = {
                            "step": step,
                            "name": name,
                            "summary": truncate(summary, 120),
                            "result_ok": None,
                            "result_text": "",
                        }
                        current_turn["tool_calls"].append(tc)
                        pending_calls[call_id] = tc
                    elif btype == "text":
                        text = block.get("text", "")
                        if text:
                            current_turn["response_text"] = truncate(text, 200)

        elif role == "toolResult" and current_turn is not None:
            call_id = msg.get("toolCallId", "")
            tc = pending_calls.get(call_id)
            if tc:
                is_err = is_error_result(msg)
                tc["result_ok"] = not is_err
                tc["result_text"] = truncate(extract_text(msg.get("content", "")), 150)

    return turns


def cmd_llm_trace(args):
    """Per-session LLM call sequence with running cost total."""
    log_path = find_llm_log(args.llm_log)
    calls = parse_llm_log(log_path)

    # Filter by session
    session_id = args.session_id
    matched = [c for c in calls if c["sessionId"] and c["sessionId"].startswith(session_id)]

    if args.agent:
        matched = [c for c in matched if c["agentId"] == args.agent]

    if not matched:
        print(c(C.YELLOW, f"No LLM calls found for session: {session_id}"))
        print(c(C.DIM, "Ensure the telemetry plugin was enabled during this session."))
        return

    if args.json_output:
        json.dump(matched, sys.stdout, indent=2)
        print()
        return

    # Cross-reference with session transcript
    agent = matched[0]["agentId"]
    sid = matched[0]["sessionId"][:12] if matched[0]["sessionId"] else session_id[:12]
    session_user_turns = None
    session_assistant_turns = None
    user_turns_data = []
    try:
        session_info = find_session(args.base_dir, session_id, agent if args.agent else None)
        if session_info:
            records = parse_session_file(session_info["filepath"])
            a = analyze_session(records)
            session_user_turns = a["user_turns"]
            session_assistant_turns = a["assistant_turns"]
            user_turns_data = _extract_user_turns(records)
    except Exception:
        pass

    # Match LLM log entries to user turns by order (both are chronological)
    # LLM hooks fire once per user turn, so entry i corresponds to user turn i
    # But if plugin was enabled mid-session, early turns have no log entry.
    # Align from the end if counts differ due to missing early entries.
    turn_for_call = {}  # index in matched -> user turn data
    if user_turns_data:
        n_calls = len(matched)
        n_turns = len(user_turns_data)
        if n_calls <= n_turns:
            # Align from the end — missing entries are at the start
            offset = n_turns - n_calls
            for i in range(n_calls):
                turn_for_call[i] = user_turns_data[offset + i]

    # Header
    print(c(C.BOLD + C.CYAN, "\u2550" * 90))
    print(c(C.BOLD + C.CYAN, f" LLM TRACE: {agent}/{sid}  ({len(matched)} calls)"))
    print(c(C.BOLD + C.CYAN, "\u2550" * 90))
    # LLM hooks fire once per user turn, not per API call — compare against user_turns
    if session_user_turns is not None and len(matched) < session_user_turns:
        print(c(C.YELLOW, f" \u26a0  Session has {session_user_turns} user turns but only {len(matched)} LLM calls logged"))
        print(c(C.DIM, "    (telemetry plugin may have been enabled after session started)"))
    if session_assistant_turns is not None and session_assistant_turns > len(matched):
        extra = session_assistant_turns - len(matched)
        if session_user_turns is not None and len(matched) >= session_user_turns:
            # All user turns are logged — the extra are tool-use intermediate calls
            print(c(C.DIM, f"    Note: {session_assistant_turns} total LLM calls in session "
                           f"({extra} intermediate tool-use calls not individually logged)"))
    print()

    cumulative_cost = 0.0
    total_tokens = 0

    for i, call in enumerate(matched, 1):
        ts = ""
        if call["timestamp"]:
            dt = parse_timestamp(call["timestamp"])
            if dt:
                ts = dt.strftime("%H:%M:%S")

        dur = ""
        if call["durationMs"] is not None:
            dur = f"{call['durationMs'] / 1000:.1f}s"

        cost_val = call["cost"] or 0
        cumulative_cost += cost_val
        in_tok = call["inputTokens"]
        out_tok = call["outputTokens"]
        total_tokens += in_tok + out_tok

        model_short = (call["model"] or "?")
        # Strip common prefix for brevity
        for prefix in ("claude-", ""):
            if model_short.startswith(prefix) and prefix:
                model_short = model_short[len(prefix):]
                break

        stop = call["stopReason"] or "?"
        if stop in ("stop", "end_turn"):
            stop_col = c(C.GREEN, stop)
        elif "error" in stop.lower():
            stop_col = c(C.RED, stop)
        else:
            stop_col = stop

        # Cost coloring
        cost_str = fmt_cost(cost_val)
        if cost_val > 1:
            cost_col = c(C.RED + C.BOLD, cost_str)
        elif cost_val > 0.1:
            cost_col = c(C.YELLOW, cost_str)
        else:
            cost_col = cost_str

        cache_parts = []
        if call["cacheReadTokens"] > 0:
            cache_parts.append(f"cr:{human_tokens(call['cacheReadTokens'])}")
        if call["cacheWriteTokens"] > 0:
            cache_parts.append(f"cw:{human_tokens(call['cacheWriteTokens'])}")
        cache_str = "  ".join(cache_parts)

        # User message context from session transcript
        turn_data = turn_for_call.get(i - 1)
        if turn_data and turn_data["user_text"]:
            user_preview = turn_data["user_text"].replace("\n", " ")
            if len(user_preview) > 80:
                user_preview = user_preview[:80] + "..."
            print(c(C.BLUE, f"  \u2502 {user_preview}"))

        print(
            c(C.BOLD + C.CYAN, f"  [{i:3d}]")
            + f" {ts}  {model_short}  {dur}"
        )
        print(
            f"        in: {human_tokens(in_tok)}  out: {human_tokens(out_tok)}  "
            f"{cache_str}  cost: {cost_col}  "
            + c(C.DIM, f"cumul: {fmt_cost(cumulative_cost)}")
        )
        print(
            f"        stop: {stop_col}"
        )

        # Tool calls from session transcript
        if turn_data and turn_data["tool_calls"]:
            for tc in turn_data["tool_calls"]:
                if tc["result_ok"] is True:
                    status = c(C.GREEN, "\u2713")
                elif tc["result_ok"] is False:
                    status = c(C.RED, "\u2717")
                else:
                    status = c(C.DIM, "?")
                name_col = c(C.CYAN, tc["name"])
                summary = c(C.DIM, tc["summary"]) if tc["summary"] else ""
                print(f"        {status} {name_col}  {summary}")
                if tc["result_ok"] is False and tc["result_text"]:
                    print(c(C.RED, f"          {truncate(tc['result_text'], 120)}"))

        # Final response text preview
        if turn_data and turn_data["response_text"]:
            resp_preview = turn_data["response_text"].replace("\n", " ")
            if len(resp_preview) > 100:
                resp_preview = resp_preview[:100] + "..."
            print(c(C.DIM, f"        \u2192 {resp_preview}"))

        print()

    # Summary
    print(c(C.DIM, "\u2500" * 90))
    print(
        c(C.BOLD, f"  Total: {len(matched)} calls  \u2502  ")
        + c(C.BOLD, f"Cost: {fmt_cost(cumulative_cost)}  \u2502  ")
        + f"Tokens: {fmt_tokens(total_tokens)}"
    )
    print()


def cmd_llm_summary(args):
    """Aggregate LLM stats by agent and model."""
    log_path = find_llm_log(args.llm_log)
    calls = parse_llm_log(log_path)

    if args.agent:
        calls = [c for c in calls if c["agentId"] == args.agent]

    if not calls:
        print("No LLM calls found.")
        return

    # Aggregate by agent
    by_agent = defaultdict(lambda: {
        "calls": 0, "cost": 0.0, "input_tokens": 0, "output_tokens": 0,
        "cache_read": 0, "cache_write": 0, "durations": [], "models": defaultdict(int),
    })
    # Aggregate by model
    by_model = defaultdict(lambda: {"calls": 0, "cost": 0.0, "input_tokens": 0, "output_tokens": 0, "cache_read": 0, "cache_write": 0})

    for call in calls:
        agent = call["agentId"] or "unknown"
        model = call["model"] or "unknown"
        cost = call["cost"] or 0

        a = by_agent[agent]
        a["calls"] += 1
        a["cost"] += cost
        a["input_tokens"] += call["inputTokens"]
        a["output_tokens"] += call["outputTokens"]
        a["cache_read"] += call["cacheReadTokens"]
        a["cache_write"] += call["cacheWriteTokens"]
        if call["durationMs"] is not None:
            a["durations"].append(call["durationMs"])
        a["models"][model] += 1

        m = by_model[model]
        m["calls"] += 1
        m["cost"] += cost
        m["input_tokens"] += call["inputTokens"]
        m["output_tokens"] += call["outputTokens"]
        m["cache_read"] += call["cacheReadTokens"]
        m["cache_write"] += call["cacheWriteTokens"]

    if args.json_output:
        output = {
            "total_calls": len(calls),
            "total_cost": sum(c["cost"] or 0 for c in calls),
            "by_agent": {},
            "by_model": {},
        }
        for agent, stats in by_agent.items():
            s = dict(stats)
            s["models"] = dict(s["models"])
            s["avg_duration_ms"] = sum(s["durations"]) / len(s["durations"]) if s["durations"] else 0
            del s["durations"]
            output["by_agent"][agent] = s
        for model, stats in by_model.items():
            output["by_model"][model] = dict(stats)
        json.dump(output, sys.stdout, indent=2)
        print()
        return

    total_cost = sum(c["cost"] or 0 for c in calls)
    total_in = sum(c["inputTokens"] for c in calls)
    total_out = sum(c["outputTokens"] for c in calls)
    total_cr = sum(c["cacheReadTokens"] for c in calls)
    total_cw = sum(c["cacheWriteTokens"] for c in calls)

    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    print(c(C.BOLD, f" LLM SUMMARY \u2014 {len(calls)} calls across {len(by_agent)} agents"))
    print(c(C.BOLD, f" Total cost: {fmt_cost(total_cost)}"))
    print(
        f" In: {human_tokens(total_in)}  Out: {human_tokens(total_out)}  "
        f"Cache R: {human_tokens(total_cr)}  Cache W: {human_tokens(total_cw)}"
    )
    print(c(C.BOLD + C.CYAN, "\u2550" * 70))
    print()

    # By agent
    print(c(C.BOLD, " BY AGENT"))
    for agent in sorted(by_agent, key=lambda a: by_agent[a]["cost"], reverse=True):
        stats = by_agent[agent]
        avg_dur = ""
        if stats["durations"]:
            avg_ms = sum(stats["durations"]) / len(stats["durations"])
            avg_dur = f"  \u2502  Avg: {avg_ms / 1000:.1f}s"

        print(c(C.BOLD + C.MAGENTA, f" \u250c\u2500 {agent}"))
        print(
            f" \u2502  Calls: {stats['calls']}  \u2502  "
            f"Cost: {c(C.BOLD, fmt_cost(stats['cost']))}{avg_dur}"
        )
        print(
            f" \u2502  In: {human_tokens(stats['input_tokens'])}  "
            f"Out: {human_tokens(stats['output_tokens'])}  "
            f"Cache R: {human_tokens(stats['cache_read'])}  "
            f"Cache W: {human_tokens(stats['cache_write'])}"
        )
        # Model breakdown
        models_str = ", ".join(
            f"{m}:{n}" for m, n in sorted(stats["models"].items(), key=lambda x: x[1], reverse=True)
        )
        print(f" \u2502  Models: {c(C.DIM, models_str)}")
        print(c(C.MAGENTA, " \u2514" + "\u2500" * 69))
        print()

    # By model
    print(c(C.BOLD, " BY MODEL"))
    hdr = f"   {'MODEL':30s} {'CALLS':>6s} {'IN_TOK':>8s} {'OUT_TOK':>8s} {'CACHE_R':>8s} {'CACHE_W':>8s} {'COST':>10s}"
    print(c(C.DIM, hdr))
    print(c(C.DIM, "   " + "\u2500" * 87))
    for model in sorted(by_model, key=lambda m: by_model[m]["cost"], reverse=True):
        stats = by_model[model]
        print(
            f"   {model[:30]:30s} {stats['calls']:>6d} "
            f"{human_tokens(stats['input_tokens']):>8s} "
            f"{human_tokens(stats['output_tokens']):>8s} "
            f"{human_tokens(stats['cache_read']):>8s} "
            f"{human_tokens(stats['cache_write']):>8s} "
            f"{fmt_cost(stats['cost']):>10s}"
        )
    print()


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _tool_call_summary(name, args):
    """Get a short summary of a tool call."""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (json.JSONDecodeError, TypeError):
            return args

    if not isinstance(args, dict):
        return str(args)

    if name == "exec":
        return args.get("command", args.get("cmd", ""))
    if name in ("read", "write"):
        return args.get("path", args.get("file", ""))
    if name == "browser":
        return f"{args.get('action', '')} {args.get('url', '')}".strip()
    if name in ("sessions_spawn", "sessions_send"):
        return f"\u2192 {args.get('agent', args.get('agentId', ''))}"
    if name == "gateway":
        return args.get("action", "")
    if name == "image":
        return "screenshot"
    return json.dumps(args)


# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="OpenClaw session JSONL debug & analytics tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  %(prog)s list
  %(prog)s list --agent personal
  %(prog)s trace 4e29832a --agent personal
  %(prog)s trace 4e29832a --full
  %(prog)s metrics 4e29832a
  %(prog)s errors 4e29832a --agent personal
  %(prog)s summary
  %(prog)s llm-list
  %(prog)s llm-list --agent personal --model opus
  %(prog)s llm-trace 4e29832a
  %(prog)s llm-summary
""",
    )

    # Common args via parent parser
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-dir", help="Override agents directory path")
    common.add_argument("--llm-log", help="Override LLM log file path")
    common.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    common.add_argument(
        "--force-color", action="store_true", help="Force colored output (for piped use)"
    )
    common.add_argument(
        "--json", dest="json_output", action="store_true", help="JSON output"
    )
    common.add_argument("--agent", help="Filter by agent ID")

    subparsers = parser.add_subparsers(dest="command", help="Command")

    subparsers.add_parser("list", parents=[common], help="List all sessions")

    p_trace = subparsers.add_parser(
        "trace", parents=[common], help="Full annotated trace"
    )
    p_trace.add_argument("session_id", help="Session ID (or prefix)")
    p_trace.add_argument(
        "--full", action="store_true", help="Show full output (no truncation)"
    )

    p_metrics = subparsers.add_parser(
        "metrics", parents=[common], help="Deep session metrics"
    )
    p_metrics.add_argument("session_id", help="Session ID (or prefix)")

    p_errors = subparsers.add_parser(
        "errors", parents=[common], help="Extract session errors"
    )
    p_errors.add_argument("session_id", help="Session ID (or prefix)")

    subparsers.add_parser(
        "summary", parents=[common], help="Agent-level aggregate summary"
    )

    # LLM log commands
    p_llm_list = subparsers.add_parser(
        "llm-list", parents=[common], help="List LLM API calls"
    )
    p_llm_list.add_argument("--model", help="Filter by model name (substring match)")
    p_llm_list.add_argument("--session", help="Filter by session ID (prefix match)")

    p_llm_trace = subparsers.add_parser(
        "llm-trace", parents=[common], help="Per-session LLM call sequence"
    )
    p_llm_trace.add_argument("session_id", help="Session ID (or prefix)")

    subparsers.add_parser(
        "llm-summary", parents=[common], help="Aggregate LLM stats by agent/model"
    )

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    if args.no_color or (not sys.stdout.isatty() and not args.force_color):
        C.disable()

    commands = {
        "list": cmd_list,
        "trace": cmd_trace,
        "metrics": cmd_metrics,
        "errors": cmd_errors,
        "summary": cmd_summary,
        "llm-list": cmd_llm_list,
        "llm-trace": cmd_llm_trace,
        "llm-summary": cmd_llm_summary,
    }

    try:
        commands[args.command](args)
    except BrokenPipeError:
        # Handle piping to head/less gracefully
        sys.stderr.close()
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
