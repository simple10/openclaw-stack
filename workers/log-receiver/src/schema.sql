-- OpenClaw Telemetry Events — D1 Schema
-- Applied via: wrangler d1 execute <database_name> --remote --file=src/schema.sql

-- Core events table — one row per event
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'llm_input', 'llm_output', 'session_start', etc.
  category TEXT NOT NULL,       -- 'llm', 'session', 'tool', 'message', 'agent', 'gateway'
  timestamp TEXT NOT NULL,      -- ISO 8601
  agent_id TEXT,
  session_id TEXT,
  session_key TEXT,
  instance_id TEXT,

  -- Common numeric fields (nullable, event-type-dependent)
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_total REAL,

  -- Type-specific metadata (small structured data)
  meta TEXT,                    -- JSON: model, provider, toolName, error, stopReason, etc.

  -- Full content (only when granularity = full or summary)
  content TEXT,                 -- JSON: prompt, response, params, result, message body

  created_at TEXT DEFAULT (datetime('now'))
);

-- Query patterns: session explorer, cost tracking, agent activity
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_agent_time ON events(agent_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, timestamp);
