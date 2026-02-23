# Plan: Move llm-logger config from env vars to openclaw.json

## Context

The llm-logger plugin currently reads llemtry configuration from `process.env` (env vars passed through `docker-compose.override.yml`). This means adding any new config option requires modifying the compose file, recreating the container, and updating `openclaw-config.env`.

OpenClaw has first-class plugin config support: plugins declare a JSON Schema in `openclaw.plugin.json`, and the loader validates and passes the config as `api.pluginConfig` in `register()`. The coordinator plugin already uses this pattern. Moving llm-logger config here makes it flexible — new options can be added by editing `openclaw.json` on the VPS (with a gateway restart, since `plugins.*` requires restart).

## Changes

### 1. Update plugin config schema — `deploy/plugins/llm-logger/openclaw.plugin.json`

Add properties to the currently-empty schema:

```json
{
  "id": "llm-logger",
  "name": "LLM Logger",
  "description": "Logs all LLM input/output events to ~/.openclaw/logs/llm.log (JSONL) for debugging and cost tracking",
  "version": "1.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "logFile": {
        "type": "string",
        "description": "Log filename within ~/.openclaw/logs/. Empty string disables file logging.",
        "default": "llm.log"
      },
      "llemtry": {
        "type": "object",
        "description": "LLM telemetry — send spans to Log Worker for Langfuse/other backends",
        "additionalProperties": false,
        "properties": {
          "enabled": {
            "type": ["boolean", "string"],
            "description": "Enable sending telemetry. Accepts boolean or string 'true'/'false' for template compatibility.",
            "default": false
          },
          "url": {
            "type": "string",
            "description": "Full URL of the llemtry endpoint (e.g. https://log-receiver.xxx.workers.dev/llemtry)"
          },
          "authToken": {
            "type": "string",
            "description": "Bearer token for llemtry endpoint authentication"
          }
        }
      }
    }
  }
}
```

Note: `enabled` accepts `["boolean", "string"]` because `{{VAR}}` template substitution produces string `"true"`/`"false"` in JSON. The plugin normalizes to boolean at startup.

### 2. Update plugin — `deploy/plugins/llm-logger/index.js`

Replace env var reads with `api.pluginConfig`:

**In `register(api)`:**

```javascript
// Config from api.pluginConfig (openclaw.json → plugins.entries.llm-logger.config)
const cfg = api.pluginConfig ?? {}
const llemtryCfg = cfg.llemtry ?? {}

// File logging — default "llm.log", empty string disables
const logFileName = cfg.logFile ?? 'llm.log'
const fileLoggingEnabled = logFileName !== ''

// Llemtry — from plugin config
const llemtryWanted = llemtryCfg.enabled === true || llemtryCfg.enabled === 'true'
const llemtryUrl = llemtryCfg.url || undefined
const llemtryToken = llemtryCfg.authToken || undefined

// Deployment identifiers — stay as env vars (system-level, not plugin-specific)
const INSTANCE_ID = process.env.OPENCLAW_INSTANCE_ID || undefined
const HOSTNAME = process.env.VPS_HOSTNAME || undefined
```

**Remove** the module-level env var reads:

```javascript
// DELETE these lines:
const LLEMTRY_ENABLED_ENV = process.env.ENABLE_LLEMTRY_LOGGING === 'true'
const LLEMTRY_URL = process.env.LOG_WORKER_URL ? ...
const LLEMTRY_TOKEN = process.env.LOG_WORKER_TOKEN
```

**Move `INSTANCE_ID` and `HOSTNAME`** inside `register()` (they still read from `process.env` — these are deployment-level identifiers, not plugin config).

**Update validation message** to reference config path instead of env vars:

```javascript
if (llemtryWanted) {
  if (!llemtryUrl || !llemtryToken) {
    api.logger.error(
      '[llm-logger] llemtry.enabled is true but llemtry.url or llemtry.authToken is missing in plugin config. ' +
      'LLM telemetry will NOT be sent.'
    )
    llemtryEnabled = false
  } else {
    api.logger.info(`[llm-logger] LLM telemetry enabled → ${llemtryUrl}`)
    llemtryEnabled = true
  }
}
```

**Update `sendSpan()`** to use the config-sourced URL and token (pass as params or closure).

**File logging path**: When `logFileName` is empty, skip `writeLine()` entirely. When set, build path as `join(logsDir, logFileName)` instead of hardcoded `'llm.log'`.

**Update header comment** to reference config instead of env vars.

### 3. Update deploy template — `deploy/openclaw.json`

Add config block to the llm-logger entry. The `llemtry.url` needs a derived URL since `LOG_WORKER_URL` ends with `/logs`.

```jsonc
"llm-logger": {
  "enabled": false,
  "config": {
    "logFile": "llm.log",
    "llemtry": {
      "enabled": "{{ENABLE_LLEMTRY_LOGGING}}",
      "url": "{{LLEMTRY_URL}}",
      "authToken": "{{LOG_WORKER_TOKEN}}"
    }
  }
}
```

### 4. Update playbook 04 — template vars

In `playbooks/04-vps1-openclaw.md`, the section that deploys `openclaw.json` (around line 347) has a `# VARS:` comment listing template variables. Add the new ones:

```
# VARS: GATEWAY_TOKEN (from .env on VPS), OPENCLAW_DOMAIN_PATH (from openclaw-config.env),
#        YOUR_TELEGRAM_ID (from openclaw-config.env), ENABLE_LLEMTRY_LOGGING (from openclaw-config.env),
#        LLEMTRY_URL (derived: LOG_WORKER_URL with /logs → /llemtry), LOG_WORKER_TOKEN (from openclaw-config.env)
```

The playbook must derive `LLEMTRY_URL` before substitution:

```bash
# Derive llemtry URL from LOG_WORKER_URL (replace /logs suffix with /llemtry)
LLEMTRY_URL="${LOG_WORKER_URL/\/logs/\/llemtry}"
```

### 5. Update docker-compose — `deploy/docker-compose.override.yml`

**Remove** `ENABLE_LLEMTRY_LOGGING` env var (now in openclaw.json config).

**Keep** `OPENCLAW_INSTANCE_ID` and `VPS_HOSTNAME` — these are deployment-level identifiers used by the plugin via `process.env`, not plugin-specific config.

```yaml
# REMOVE this line:
- ENABLE_LLEMTRY_LOGGING=${ENABLE_LLEMTRY_LOGGING:-false}
# KEEP these:
- OPENCLAW_INSTANCE_ID=${OPENCLAW_INSTANCE_ID:-}
- VPS_HOSTNAME=${VPS_HOSTNAME:-}
```

### 6. Update `openclaw-config.env.example`

Keep `ENABLE_LLEMTRY_LOGGING` (still referenced as a template var in openclaw.json). Update the comment to clarify it's a template variable for openclaw.json, not a direct env var:

```bash
# === LLM TELEMETRY (optional — requires llm-logger plugin and Log Worker) ===
OPENCLAW_INSTANCE_ID=             # Unique deployment ID (auto-generated UUID on first deploy if empty)
ENABLE_LLEMTRY_LOGGING=false      # Substituted into openclaw.json llm-logger config during deploy
```

### 7. Update verification playbook — `playbooks/07-verification.md`

Section 7.6a: Update plugin startup check to reference config instead of env vars.

## Files summary

| File | Action |
|------|--------|
| `deploy/plugins/llm-logger/openclaw.plugin.json` | Add configSchema (logFile, llemtry) |
| `deploy/plugins/llm-logger/index.js` | Read from `api.pluginConfig` instead of `process.env` |
| `deploy/openclaw.json` | Add config block to llm-logger entry with template vars |
| `deploy/docker-compose.override.yml` | Remove `ENABLE_LLEMTRY_LOGGING` env var |
| `openclaw-config.env.example` | Update comment for `ENABLE_LLEMTRY_LOGGING` |
| `playbooks/04-vps1-openclaw.md` | Add LLEMTRY_URL derivation and template vars |
| `playbooks/07-verification.md` | Update 7.6a to reference config |

## Verification

1. **Schema validation**: Plugin with invalid config should fail to load (test with typo in config key — `additionalProperties: false` should reject)
2. **Config reads**: Gateway logs should show `[llm-logger] LLM telemetry enabled → https://...` when config has `llemtry.enabled: true` with url/token
3. **File logging toggle**: Set `logFile: ""` → no writes to `llm.log`. Set `logFile: "llm.log"` → writes resume.
4. **Template substitution**: Deployed `openclaw.json` on VPS should have no `{{` remaining
5. **Env var removal**: Gateway works without `ENABLE_LLEMTRY_LOGGING` in docker-compose env
