#!/usr/bin/env python3
"""
OpenClaw session JSONL debug & analytics tool.

Usage:
  debug-sessions.py list [--agent <id>]
  debug-sessions.py trace <session-id> [--agent <id>] [--full]
  debug-sessions.py metrics <session-id> [--agent <id>]
  debug-sessions.py errors <session-id> [--agent <id>]
  debug-sessions.py summary [--agent <id>]

Global options:
  --base-dir <path>  Override agents directory (default: auto-detect)
  --no-color         Disable ANSI colors
  --json             Machine-readable JSON output

Session JSONL schema (OpenClaw):
  Entry types: session, model_change, thinking_level_change, custom, message
  Message roles: user, assistant, toolResult
  Assistant content blocks: text, thinking, toolCall (arguments field, not input)
  Error detection: isError is always false — check details.status and content text
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


DEFAULT_PATHS = [
    "/home/node/.openclaw/agents",  # Inside gateway container
    "/home/openclaw/.openclaw/agents",  # On host via Sysbox mapping
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
                    print(c(C.BOLD + C.BLUE, "\u250c\u2500 USER"))
                    for line in display.split("\n"):
                        print(c(C.BLUE, f"\u2502 {line}"))
                    print(c(C.BLUE, "\u2514" + "\u2500" * 79))
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
                                print(c(C.YELLOW, f"  \U0001f4ad {display}"))

                        elif btype == "text":
                            text = block.get("text", "")
                            if text:
                                display = (
                                    text
                                    if max_text == 0
                                    else truncate(text, 300)
                                )
                                print(c(C.DIM, f"  \U0001f4ac {display}"))

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
                                c(C.CYAN + C.BOLD, f"  [{step:3d}] {name}")
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
                        c(C.RED, f"  [{step_num:>3}] \u2717 {tool_name}: {display}")
                    )
                else:
                    display = text if max_text == 0 else truncate(text, 200)
                    print(
                        c(C.GREEN, f"  [{step_num:>3}] \u2713 {tool_name}")
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
""",
    )

    # Common args via parent parser
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base-dir", help="Override agents directory path")
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
