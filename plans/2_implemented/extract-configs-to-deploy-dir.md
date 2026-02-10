# Plan: Extract openclaw.json (and other heredocs) to deploy/ with template convention

## Context

After extracting 4 files from playbook heredocs into `deploy/`, the biggest remaining heredocs are:

| Section | File | Lines | Has variables? |
|---------|------|-------|---------------|
| 4.6 | `docker-compose.override.yml` | 121 | No (quoted heredoc; `${VAR}` is Docker Compose runtime interpolation) |
| 4.8 | `openclaw.json` | 94 | Yes: `${GATEWAY_TOKEN}` (bash), `<OPENCLAW_DOMAIN_PATH>` (placeholder) |
| 4.8 | `models.json` (x2) | 10 each | Yes: `<AI_GATEWAY_WORKER_URL>` (placeholder) |

The compose override is a plain extraction (no template needed). But openclaw.json and models.json have variables that Claude must substitute at deploy time.

We need a **template convention** that extends the existing `# SOURCE:` / `# <<< >>>` pattern.

## Template Convention

Template files in `deploy/` use `{{VAR}}` placeholders (Mustache-style). This syntax is:

- Unambiguous in JSON, YAML, and shell scripts
- Visually distinct from the `# <<< file >>>` file-reference sentinel
- Widely understood (Mustache, Handlebars, Go templates, Jinja2)

**Playbook pattern for templates:**

```bash
#!/bin/bash
# SOURCE: deploy/openclaw.json (template) → /home/openclaw/.openclaw/openclaw.json
# VARS: GATEWAY_TOKEN (from .env on VPS), OPENCLAW_DOMAIN_PATH (from openclaw-config.env)
sudo tee /home/openclaw/.openclaw/openclaw.json << 'JSONEOF'
# <<< deploy/openclaw.json (template) >>>
JSONEOF
```

The `(template)` marker tells the executor: read the file, substitute all `{{VAR}}` placeholders with values from the deployment config, then use the result.

## Changes

### 1. Create `deploy/openclaw.json` (template)

Copy the JSON from section 4.8, replacing variables with `{{VAR}}` syntax:

- `${GATEWAY_TOKEN}` → `{{GATEWAY_TOKEN}}`  (appears 2x: auth.token, remote.token)
- `<OPENCLAW_DOMAIN_PATH>` → `{{OPENCLAW_DOMAIN_PATH}}` (appears 1x: controlUi.basePath)

### 2. Create `deploy/models.json` (template)

Single template used for both main and code agents:

- `<AI_GATEWAY_WORKER_URL>` → `{{AI_GATEWAY_WORKER_URL}}` (appears 2x)

### 3. Create `deploy/docker-compose.override.yml` (plain file)

Verbatim copy from the playbook — no template processing needed. The `${VAR}` references inside are Docker Compose runtime interpolation from `.env`.

### 4. Update playbook section 4.6

Replace 121-line compose override heredoc with SOURCE sentinel (plain, not template).

### 5. Update playbook section 4.8

Replace openclaw.json heredoc body with `# <<< deploy/openclaw.json (template) >>>`.
Keep the surrounding bash (GATEWAY_TOKEN read, chown, chmod) — those are deployment commands.

Replace both models.json heredoc bodies with `# <<< deploy/models.json (template) >>>`.

### 6. Update `deploy/README.md`

Add new files to manifest table. Add template column:

| Source | VPS Target | Owner | Mode | Template |
|--------|-----------|-------|------|----------|
| `vector.yaml` | `.../vector.yaml` | openclaw | 644 | No |
| `build-openclaw.sh` | `.../build-openclaw.sh` | openclaw | 755 | No |
| `entrypoint-gateway.sh` | `.../entrypoint-gateway.sh` | openclaw | 755 | No |
| `host-alert.sh` | `.../host-alert.sh` | root | 755 | No |
| `docker-compose.override.yml` | `.../docker-compose.override.yml` | openclaw | 644 | No |
| `openclaw.json` | `~/.openclaw/openclaw.json` | 1000:1000 | 600 | Yes |
| `models.json` | `~/.openclaw/agents/*/agent/models.json` | 1000:1000 | 600 | Yes |

Add a "Templates" subsection explaining `{{VAR}}` syntax.

### 7. Update CLAUDE.md convention rule

Extend the existing rule to cover templates:

```markdown
- **Single source of truth for deployed files.** Files deployed to the VPS live in `deploy/`. Playbooks reference them via `# SOURCE: deploy/<file>` comments with a `# <<< deploy/<file> >>>` sentinel in the heredoc body. When executing a playbook step with this pattern, read the referenced file from the local repo and use its contents in place of the sentinel. Template files are marked `(template)` and use `{{VAR}}` placeholders — substitute values from `openclaw-config.env` or as documented in the `# VARS:` comment. Never duplicate file contents inline in playbooks.
```

## Files modified

| File | Action |
|------|--------|
| `deploy/docker-compose.override.yml` | New (plain, from playbook 4.6) |
| `deploy/openclaw.json` | New (template, from playbook 4.8) |
| `deploy/models.json` | New (template, from playbook 4.8) |
| `deploy/README.md` | Add new files + template docs |
| `playbooks/04-vps1-openclaw.md` | Replace heredocs in 4.6, 4.8 |
| `CLAUDE.md` | Extend convention rule |

## Verification

1. `deploy/openclaw.json` has `{{GATEWAY_TOKEN}}` (2x) and `{{OPENCLAW_DOMAIN_PATH}}` (1x) — no bare `${VAR}` or `<VAR>` placeholders
2. `deploy/models.json` has `{{AI_GATEWAY_WORKER_URL}}` (2x)
