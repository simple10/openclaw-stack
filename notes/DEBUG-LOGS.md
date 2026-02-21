# Debug Logs

## Log Hierarchy

```text
  Agent (e.g. "main", "code", "skills")
   └─ Session (UUID, one per conversation)
       └─ Run (UUID, one per LLM API call within a session)
```

### What each level means

Agent — A named OpenClaw agent identity (e.g. main, code, skills). Each has its own sandbox and config. This is just
an ID string, not a first-class log entity.

Session — One conversation. Created when a user (or cron) starts talking to an agent. The session transcript is
stored as a JSONL file at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Contains heterogeneous event
types:

- session — initialization (timestamp)
- model_change — model/provider selection
- message with role user / assistant / toolResult

### Run

One LLM API round-trip within a session. A single user message typically triggers multiple runs because:

1. User sends message → Run 1: LLM responds, decides to call tools (stopReason: toolUse)
2. Tool results fed back → Run 2: LLM responds, calls more tools
3. ...repeat until Run N: LLM responds with final text (stopReason: end_turn)

### Each run has its own runId and captures

- Input: systemPrompt, user prompt, accumulated history, model, temperature, tools available
- Output: response content (thinking + text + toolCalls), token usage (input/output/cacheRead/cacheWrite),
stopReason, durationMs, cost

### Two separate log sources

```bash
Source: Session transcripts
Path: agents/<id>/sessions/<sid>.jsonl
Granularity: Every message, tool call, tool result
Content: Full conversation flow — what the user/agent said and did
────────────────────────────────────────
Source: LLM log
Path: logs/llm.log
Granularity: One paired entry per run
Content: Token usage, cost, cache stats, model, duration — the API call metrics
```

The session transcript gives you the what (conversation content, tool interactions). The LLM log gives you the how
much (tokens, cost, latency) per API call.

### Key relationship

- **Session transcript:** user msg → [assistant turn with N tool calls] → [tool results] → [assistant turn] → ...
- **LLM log:** run1 (input+output pair) → run2 (input+output pair) → ...

They're linked by sessionId and runId. One user turn in the transcript may produce multiple runs in the LLM log (the
tool-use loop), but the llm-logger plugin currently only emits one log entry per user turn (the final aggregated
call), not per intermediate tool-use call.

The natural SQL table schema would be:

- sessions — one row per conversation (agentId, sessionId, timestamps, total cost/tokens)
- runs — one row per LLM API call (sessionId FK, runId, model, tokens, cost, duration, stopReason)
- Optionally events — if you want to store the full conversation content (messages, tool calls, tool results)

---

OpenClaw Event Types

1. Gateway Lifecycle

  ```text
  ┌─────────────────────────────────┬─────────────────────────────┬────────────────────────────────┐
  │              Event              │           Source            │              When              │
  ├─────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
  │ gateway:startup / gateway_start │ internal hook + plugin hook │ Gateway boots, channels loaded │
  ├─────────────────────────────────┼─────────────────────────────┼────────────────────────────────┤
  │ gateway_stop                    │ plugin hook                 │ Gateway shutting down          │
  └─────────────────────────────────┴─────────────────────────────┴────────────────────────────────┘
  ```

1. Agent Lifecycle

  ```text
  ┌──────────────────────────────────────┬─────────────┬────────────────────────────────────────────────────────┐
  │                Event                 │   Source    │                          When                          │
  ├──────────────────────────────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ agent:bootstrap / before_agent_start │ both        │ Agent workspace bootstrapped / prompt about to be sent │
  ├──────────────────────────────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ agent_end                            │ plugin hook │ Agent turn completes (success/error, duration)         │
  └──────────────────────────────────────┴─────────────┴────────────────────────────────────────────────────────┘
  ```

1. Session Lifecycle

  ```text
  ┌───────────────────────────────┬─────────────┬───────────────────────────────────────────────────────┐
  │             Event             │   Source    │                         When                          │
  ├───────────────────────────────┼─────────────┼───────────────────────────────────────────────────────┤
  │ session:start / session_start │ both        │ New session created                                   │
  ├───────────────────────────────┼─────────────┼───────────────────────────────────────────────────────┤
  │ session_end                   │ plugin hook │ Session ends (messageCount, duration)                 │
  ├───────────────────────────────┼─────────────┼───────────────────────────────────────────────────────┤
  │ before_compaction             │ plugin hook │ Before context compaction (includes sessionFile path) │
  ├───────────────────────────────┼─────────────┼───────────────────────────────────────────────────────┤
  │ after_compaction              │ plugin hook │ After compaction completes                            │
  ├───────────────────────────────┼─────────────┼───────────────────────────────────────────────────────┤
  │ before_reset                  │ plugin hook │ Before session reset                                  │
  └───────────────────────────────┴─────────────┴───────────────────────────────────────────────────────┘
  ```

1. LLM Telemetry

  ```text
  ┌────────────┬─────────────┬────────────────────────────────────────────────────────┐
  │   Event    │   Source    │                          When                          │
  ├────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ llm_input  │ plugin hook │ Before LLM API call (prompt, model, params)            │
  ├────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ llm_output │ plugin hook │ After LLM response (response, usage, cost, stopReason) │
  └────────────┴─────────────┴────────────────────────────────────────────────────────┘
  ```

1. Message Channel Events

  ```text
  ┌──────────────────┬─────────────┬────────────────────────────────────────────────────────┐
  │      Event       │   Source    │                          When                          │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ message_received │ plugin hook │ Inbound message from channel (Telegram, webchat, etc.) │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ message_sending  │ plugin hook │ Before outbound message (can modify/cancel)            │
  ├──────────────────┼─────────────┼────────────────────────────────────────────────────────┤
  │ message_sent     │ plugin hook │ After delivery attempt (success/error)                 │
  └──────────────────┴─────────────┴────────────────────────────────────────────────────────┘
  ```

1. Tool Execution

  ```text
  ┌─────────────────────┬─────────────┬───────────────────────────────────────────────┐
  │        Event        │   Source    │                     When                      │
  ├─────────────────────┼─────────────┼───────────────────────────────────────────────┤
  │ before_tool_call    │ plugin hook │ Before tool runs (can modify params or block) │
  ├─────────────────────┼─────────────┼───────────────────────────────────────────────┤
  │ after_tool_call     │ plugin hook │ After tool runs (result, error, duration)     │
  ├─────────────────────┼─────────────┼───────────────────────────────────────────────┤
  │ tool_result_persist │ plugin hook │ Before tool result written to transcript      │
  └─────────────────────┴─────────────┴───────────────────────────────────────────────┘
  ```

1. Command Events

  ```text
  ┌───────────────┬───────────────┬────────────────────┐
  │     Event     │    Source     │        When        │
  ├───────────────┼───────────────┼────────────────────┤
  │ command:new   │ internal hook │ User issued /new   │
  ├───────────────┼───────────────┼────────────────────┤
  │ command:reset │ internal hook │ User issued /reset │
  ├───────────────┼───────────────┼────────────────────┤
  │ command:stop  │ internal hook │ User issued /stop  │
  └───────────────┴───────────────┴────────────────────┘
  ```

1. Syslog (Console/Docker)

  Not event-based — these are the structured tslog entries written to /tmp/openclaw/openclaw-*.log and stdout.
  Categorized by subsystem prefix: gateway, agent, agent/embedded, sessions, commands, gateway/channels/telegram,
  gateway/ws, hooks:loader, etc.

---
Current Coverage Map

```text
┌─────────────────┬──────────────────────────┬──────────────────────┬──────────────────────────┬────────────────┐
│ Event Category  │    debug-logger hook     │  llm-logger plugin   │      Session JSONL       │ Vector/syslog  │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Gateway         │ gateway:startup only     │ -                    │ -                        │ yes            │
│ lifecycle       │                          │                      │                          │                │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Agent lifecycle │ agent:bootstrap only     │ -                    │ -                        │ yes            │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Session         │ registered but rarely    │ -                    │ session start, model     │ yes            │
│ lifecycle       │ fires                    │                      │ changes                  │                │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ LLM telemetry   │ -                        │ full (local +        │ usage/cost in assistant  │ -              │
│                 │                          │ Langfuse)            │ msgs                     │                │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Messages        │ -                        │ -                    │ user/assistant content   │ -              │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Tool calls      │ -                        │ -                    │ full tool calls +        │ -              │
│                 │                          │                      │ results                  │                │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Commands        │ registered but sparse    │ -                    │ -                        │ yes            │
├─────────────────┼──────────────────────────┼──────────────────────┼──────────────────────────┼────────────────┤
│ Compaction      │ -                        │ -                    │ -                        │ yes (as        │
│                 │                          │                      │                          │ syslog)        │
└─────────────────┴──────────────────────────┴──────────────────────┴──────────────────────────┴────────────────┘
```

The session JSONL transcripts are by far the richest source — they have everything except gateway-level events.
But they're local files, not shipped anywhere.
