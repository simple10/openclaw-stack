# Config Architecture Redesign: `.env` + `stack.yml` + `docker-compose.yml`

## Context

The current config system uses layered env files (`openclaw-config.env` → `openclaws/<name>/config.env`), bash scripts that auto-discover claws and generate compose overrides, and sed-based template substitution. Problems:

- 80+ flat env vars mixing VPS/stack/claw/infra concerns
- Three config levels with inconsistent override semantics
- Claude and scripts both do variable substitution, inconsistently
- Generated compose files the user never directly sees or edits
- No multi-stack isolation (shared networks, shared image tags, shared systemd cloudflared)
- SCP-based deploy with no drift tracking

**Goal**: Three clean files define the entire deployment:

- `.env` — secrets and VPS access (flat key-value, never leaves local)
- `stack.yml` — structured stack config (YAML, gitignored, references `.env` via `${VAR}`)
- `docker-compose.yml` — EJS template for service definitions (checked in)

**Deploy model**: Local pre-deploy script builds artifacts into `.deploy/` (its own git repo) → `git push` to VPS → VPS runs `docker compose up -d`. No more SCP. No more Claude doing variable substitution.

---

## Architecture Overview

```
 LOCAL (dev machine)                          VPS
 ─────────────────────                        ───
 .env          ┐
 stack.yml     ├─→ pre-deploy ──→ .deploy/  ══git push══→  $INSTALL_DIR/deploy/
 docker-compose.yml (template)  ┘   │                           │
                                    ├─ docker-compose.yml       ├─ docker compose up -d
                                    ├─ openclaw/<name>/         │    ↓ sets env vars
                                    │    └─ openclaw.json       ├─ entrypoint: envsubst
                                    ├─ stack.yml (resolved)     │    ↓ resolves $VAR in
                                    ├─ entrypoint-gateway.sh    │    openclaw.json
                                    └─ plugins/                 └─ openclaw starts
```

`.deploy/` is a git repo → `git diff` what's deployed vs planned, `git pull` to sync VPS-generated state (gateway tokens), full audit trail.

**Config value flow** (unidirectional, no build-time substitution of app configs):

```
.env → stack.yml → docker-compose.yml (sets env vars) → openclaw.json (reads env vars at runtime)
```

---

## File 1: `.env`

Flat key-value. Gitignored. Secrets and VPS connection info. Never deployed to VPS. Values consumed by pre-deploy script to resolve `${VAR}` references in `stack.yml`. A `.env.example` with placeholder values is checked in.

```bash
# .env — Secrets & VPS access
# Never leaves local. Values referenced in stack.yml via ${VAR} syntax.

# ── VPS Access (used directly by scripts for SSH) ──────────────
VPS_IP=51.xx.xxx.xxx
HOSTNAME=openclaw-prod
SSH_USER=adminclaw
SSH_PORT=222
SSH_KEY=~/.ssh/vps1_openclaw_ed25519

# ── Cloudflare ─────────────────────────────────────────────────
CLOUDFLARE_API_TOKEN=uxoNZsusU46q...      # Optional: auto-route setup
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiZjdk...

# ── AI Gateway ─────────────────────────────────────────────────
AI_GATEWAY_URL=https://ai-gateway-proxy.example.workers.dev
AI_GATEWAY_TOKEN=e9667fbba87a...

# ── Logging ────────────────────────────────────────────────────
LOG_WORKER_URL=https://log-receiver.example.workers.dev
LOG_WORKER_TOKEN=c0a5e180790a...

# ── Monitoring ─────────────────────────────────────────────────
HOSTALERT_TELEGRAM_BOT_TOKEN=8521499863:AAGav7R4...
HOSTALERT_TELEGRAM_CHAT_ID=-5249142196

# ── Identity ───────────────────────────────────────────────────
ADMIN_TELEGRAM_ID=8090744783
ROOT_DOMAIN=example.com

# ── Per-Claw Telegram Bots ─────────────────────────────────────
PERSONAL_CLAW_TELEGRAM_BOT_TOKEN=8521499863:AAGav7R4...
WORK_CLAW_TELEGRAM_BOT_TOKEN=8667189074:AAGd9vUu...

# ── Resource Defaults ──────────────────────────────────────────
OPENCLAW_CONTAINER_CPU=6
OPENCLAW_CONTAINER_MEM=12G
```

**Design notes:**

- VPS access vars are used directly by scripts (SSH), not just for substitution
- All other vars are optional if user hardcodes values directly in `stack.yml`
- Per-claw bot tokens use `<NAME>_TELEGRAM_BOT_TOKEN` convention

---

## File 2: `stack.yml`

Structured YAML. Gitignored. Created from `stack.yml.example`. References `.env` via `${VAR}` (including `${VAR:-default}`). Pre-deploy script resolves `${VAR}` → parses YAML → deep-merges defaults into each claw.

```yaml
# stack.yml — OpenClaw stack configuration
# Gitignored. Created from: cp stack.yml.example stack.yml
#
# ${VAR} references are resolved from .env during pre-deploy.
# You can hardcode values directly — .env references are a convenience.

# ── VPS Host ──────────────────────────────────────────────────
# Set to false to skip host-level config (secondary stacks on shared VPS)
host:
  hostname: ${HOSTNAME}

  host_alerter:
    telegram_bot_token: ${HOSTALERT_TELEGRAM_BOT_TOKEN}
    telegram_chat_id: ${HOSTALERT_TELEGRAM_CHAT_ID}
    daily_report: "9:30 AM PST"

# ── Stack ─────────────────────────────────────────────────────
stack:
  install_dir: /home/openclaw
  project_name: ${PROJECT_NAME:-openclaw-stack}

  # Docker compose template to use for building this stack
  compose_template: docker-compose.yml

  openclaw:
    version: stable                    # stable | latest | v2026.2.26
    source: https://github.com/openclaw/openclaw.git

  cloudflare:
    tunnel_token: ${CLOUDFLARE_TUNNEL_TOKEN}

  ai_gateway:
    url: ${AI_GATEWAY_URL}
    token: ${AI_GATEWAY_TOKEN}

  logging:
    worker_url: ${LOG_WORKER_URL}
    worker_token: ${LOG_WORKER_TOKEN}
    vector: true
    events: true
    llmetry: true

  # Total VPS resource budget for this stack — percentages resolved against VPS capacity during build
  resources:
    max_cpu: 90%
    max_mem: 90%

# ── Claw Defaults ─────────────────────────────────────────────
# All claws inherit these. Per-claw settings override via deep merge.
defaults:
  allow_updates: false
  domain_path: ""
  dashboard_path: /dashboard
  telegram:
    allow_from: ${ADMIN_TELEGRAM_ID}
  resources:
    cpus: ${OPENCLAW_CONTAINER_CPU:-6}
    memory: ${OPENCLAW_CONTAINER_MEM:-12G}
  openclaw_json: openclaw/default/openclaw.json

# ── Claws ─────────────────────────────────────────────────────
# Each key → container: openclaw-<key>
# Deep-merged with defaults (claw values win at any depth).
claws:
  personal-claw:
    domain: openclaw.${ROOT_DOMAIN}
    gateway_port: 18789
    dashboard_port: 6090
    telegram:
      bot_token: ${PERSONAL_CLAW_TELEGRAM_BOT_TOKEN}
    allow_updates: true

  work-claw:
    domain: openclaw-work.${ROOT_DOMAIN}
    gateway_port: 18790
    dashboard_port: 6091
    telegram:
      bot_token: ${WORK_CLAW_TELEGRAM_BOT_TOKEN}
    resources:
      cpus: 20
      memory: 64G
```

### Design Notes

1. **Deep merge, not YAML anchors.** The brainstorming used `<<: *claw-defaults`, but YAML anchors only do **shallow merge** — a claw's `telegram:` block completely replaces the default's `telegram:`, losing `allow_from`. The pre-deploy script handles deep merge programmatically instead: `defaults` is the base, each claw's values override at any nesting depth. This means a claw only needs `telegram.bot_token` and automatically inherits `telegram.allow_from`.

2. **`host: false` for secondary stacks.** On a shared VPS, the first stack sets hostname and deploys host_alerter. Additional stacks set `host: false` to skip host-level config.

3. **Explicit ports per claw.** `gateway_port` and `dashboard_port` are required per-claw. Avoids the current footgun where reordering claws alphabetically silently reassigns ports.

4. **`stack.resources` = total VPS budget.** Per-claw `resources` are individual container limits. Build script can validate per-claw sum doesn't exceed budget.

5. **Config template paths.** `openclaw_json` points to the openclaw.json template relative to repo root. Per-claw override: `openclaw_json: openclaw/work-claw/openclaw.json`. The file uses `$VAR` references resolved at container startup from Docker env vars set in docker-compose.yml — no build-time substitution.

6. **Gateway tokens absent.** Auto-generated on VPS, stored in `.deploy/` git repo, synced back to local via `git pull`.

---

## File 3: `docker-compose.yml` (Template)

EJS template. Checked into git at project root. Pre-deploy renders it to `.deploy/docker-compose.yml` with all values resolved.

```yaml
# docker-compose.yml — OpenClaw stack template
# Rendered by pre-deploy using stack.yml values.
# Edit the anchor (&claw) to change all claws. Edit infrastructure services directly.
# Claw service blocks are auto-generated from stack.yml claws.

x-openclaw-claw: &claw
  image: <%- stack.project_name %>:local
  runtime: sysbox-runc
  read_only: false
  tmpfs:
    - /tmp:size=1G,mode=1777
    - /var/tmp:size=200M,mode=1777
    - /run:size=100M,mode=755
    - /var/log:size=100M,mode=755
  user: "0:0"
  security_opt: [no-new-privileges:true]
  entrypoint: ["/app/scripts/entrypoint-gateway.sh"]
  command: >-
    sh -c 'node dist/index.js gateway
    --allow-unconfigured --bind lan --port $OPENCLAW_GATEWAY_PORT'
  restart: unless-stopped
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "5"
  networks: [openclaw-net]

services:
  # ── Claws (auto-generated from stack.yml) ─────────────────────
<% for (const [name, claw] of Object.entries(claws)) { %>
  openclaw-<%- name %>:
    <<: *claw
    container_name: openclaw-<%- name %>
    ports:
      - "127.0.0.1:<%- claw.gateway_port %>:<%- claw.gateway_port %>"
      - "127.0.0.1:<%- claw.dashboard_port %>:6090"
    volumes:
      - ./entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
      - ./deploy:/app/deploy:ro
      - <%- stack.install_dir %>/instances/<%- name %>/docker:/var/lib/docker
      - <%- stack.install_dir %>/instances/<%- name %>/.openclaw:/home/node/.openclaw
    environment:
      # ── Core ──
      - NODE_ENV=production
      - TZ=UTC
      - OPENCLAW_GATEWAY_PORT=<%- claw.gateway_port %>
      - OPENCLAW_GATEWAY_TOKEN=<%- claw.gateway_token || '' %>
      - OPENCLAW_MDNS_HOSTNAME=<%- name %>
      - ALLOW_OPENCLAW_UPDATES=<%- claw.allow_updates %>
      # ── AI Provider ──
      - ANTHROPIC_API_KEY=<%- claw.ai_gateway?.token || stack.ai_gateway.token %>
      - ANTHROPIC_BASE_URL=<%- claw.ai_gateway?.url || stack.ai_gateway.url %>
      - OPENAI_API_KEY=<%- claw.ai_gateway?.token || stack.ai_gateway.token %>
      - OPENAI_BASE_URL=<%- claw.ai_gateway?.url || stack.ai_gateway.url %>
      # ── Telegram ──
      - TELEGRAM_BOT_TOKEN=<%- claw.telegram.bot_token %>
      - ADMIN_TELEGRAM_ID=<%- claw.telegram.allow_from %>
      # ── Domain & UI ──
      - OPENCLAW_DOMAIN=<%- claw.domain %>
      - OPENCLAW_DOMAIN_PATH=<%- claw.domain_path %>
      - DASHBOARD_BASE_PATH=<%- claw.dashboard_path %>
      # ── Identity (used by openclaw.json at runtime via envsubst) ──
      - OPENCLAW_INSTANCE_ID=<%- name %>
      - VPS_HOSTNAME=<%- host.hostname || '' %>
      # ── Telemetry (used by openclaw.json at runtime via envsubst) ──
      - LOG_WORKER_URL=<%- stack.logging?.worker_url || '' %>
      - LOG_WORKER_TOKEN=<%- stack.logging?.worker_token || '' %>
      - ENABLE_EVENTS_LOGGING=<%- stack.logging?.events || false %>
      - ENABLE_LLMETRY_LOGGING=<%- stack.logging?.llmetry || false %>
    deploy:
      resources:
        limits:
          cpus: "<%- claw.resources.cpus %>"
          memory: "<%- claw.resources.memory %>"
          pids: 1024
        reservations:
          cpus: "2"
          memory: 2G
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:<%- claw.gateway_port %>/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s
<% } %>

  # ── Cloudflare Tunnel (per-stack sidecar) ─────────────────────
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: <%- stack.project_name %>-cloudflared
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=<%- stack.cloudflare.tunnel_token %>
    networks: [openclaw-net]
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 128M

<% if (stack.logging?.vector) { %>
  # ── Vector Log Shipper ────────────────────────────────────────
  vector:
    image: timberio/vector:0.43.1-alpine
    container_name: <%- stack.project_name %>-vector
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./vector/vector.yaml:/etc/vector/vector.yaml:ro
      - <%- stack.install_dir %>/vector/data:/var/lib/vector
    environment:
      - LOG_WORKER_URL=<%- stack.logging.worker_url %>
      - LOG_WORKER_TOKEN=<%- stack.logging.worker_token %>
    networks: [openclaw-net]
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 128M
<% } %>

networks:
  openclaw-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.30.0.0/24
```

### Design Notes

1. **Adding a claw = add to `stack.yml`.** The EJS loop auto-generates service blocks. No copying 30 lines of compose YAML.

2. **Anchor (`&claw`) = shared claw config.** Users edit the anchor to change all claws at once. EJS generates per-claw differences.

3. **All values fully resolved in output.** `.deploy/docker-compose.yml` contains actual tokens/URLs, not `${VAR}` references. Docker Compose doesn't need a separate `.env` on VPS.

4. **Docker env vars drive openclaw.json.** Every value that openclaw.json needs is set as a Docker env var in the compose template. At runtime, the entrypoint runs `envsubst` on openclaw.json to resolve `$VAR` references. This makes the compose template the single source of truth for what config values flow into the container — no opaque sed pipelines.

5. **Vector is conditional**, not profile-gated. Service is either in the rendered compose or it isn't.

6. **cloudflared is a per-stack sidecar.** Container name is project-scoped for multi-stack isolation.

7. **Per-claw AI gateway override.** Template supports `claw.ai_gateway?.token` falling back to `stack.ai_gateway.token`. A claw can set its own `ai_gateway:` block in `stack.yml` to use a different LLM provider.

---

## Build & Deploy Flow

### Pre-Deploy (local)

1. Sync `.deploy/` from VPS (`git pull`)
2. Read `.env` → resolve `${VAR}` in `stack.yml` → parse YAML
3. Deep-merge `defaults` into each claw
4. Resolve `%` resources against VPS capacity (SSH query)
5. Render `docker-compose.yml` EJS template → `.deploy/docker-compose.yml`
6. Process `openclaw.json`: strip JS comments → `.deploy/openclaw/<name>/openclaw.json` (env var `$VAR` references preserved, resolved at container runtime)
7. Copy deploy artifacts (entrypoint, plugins, dashboard, scripts) → `.deploy/`
8. Save resolved `stack.yml` → `.deploy/stack.yml` (for VPS scripts)

### Deploy (to VPS)

1. Commit `.deploy/` changes
2. `git push` to VPS deploy repo
3. SSH → `cd $INSTALL_DIR/deploy && docker compose up -d`
4. Host setup (if `host` is not `false`): hostname, alerter, cron
5. Health check + status report

### Rollback

`cd .deploy && git revert HEAD && git push` → VPS picks up reverted config.

---

## Template Processing

| Syntax | Where | Resolved By | When |
|--------|-------|-------------|------|
| `${VAR}` | `stack.yml` | Pre-deploy script (from `.env`) | Build time (local) |
| `<%- expr %>` | `docker-compose.yml` | Pre-deploy script (EJS engine) | Build time (local) |
| `$VAR` | `openclaw.json` | Entrypoint (`envsubst`) | Container startup (VPS) |

**No build-time substitution of openclaw.json.** The pre-deploy script only strips JS comments — `$VAR` references are preserved and resolved at runtime from Docker env vars set in docker-compose.yml. This makes the compose template the single point where config values are defined.

Example: `"basePath": "$OPENCLAW_DOMAIN_PATH"` in openclaw.json → entrypoint runs `envsubst` → `"basePath": ""` at runtime. The `OPENCLAW_DOMAIN_PATH` env var was set by the compose template from `claw.domain_path` in stack.yml.

**Custom openclaw.json:** If a claw needs custom config, either (a) add an env var to the compose template and reference it in openclaw.json, or (b) hardcode the value directly in a per-claw openclaw.json.

---

## Cloudflare Tunnel Routing

With cloudflared on the same Docker network, tunnel ingress uses container names:

| Before (systemd) | After (sidecar) |
|---|---|
| `http://localhost:18789` | `http://openclaw-personal-claw:18789` |
| `http://localhost:6090` | `http://openclaw-personal-claw:6090` |
| `http://localhost:18790` | `http://openclaw-work-claw:18790` |
| `http://localhost:6091` | `http://openclaw-work-claw:6090` |

**Note:** Dashboard tunnel routes use internal port 6090, not the host-mapped `dashboard_port`.

**trustedProxies**: `["172.30.0.1"]` (bridge gateway IP).

**LAN binding**: Still needed (`--bind lan`) because Sysbox blocks network namespace sharing. The `openclaw doctor` warning is cosmetic — security enforced by isolated per-stack network.

---

## Multi-Stack Isolation

Two stacks on the same VPS (`/home/alice` and `/home/bob`):

| Concern | Isolation Mechanism |
|---|---|
| Docker images | `alice-stack:local` vs `bob-stack:local` (`stack.project_name`) |
| Docker network | `alice-stack_openclaw-net` vs `bob-stack_openclaw-net` (compose project prefix) |
| Containers | `alice-stack-cloudflared` vs `bob-stack-cloudflared` (project-scoped) |
| Tunnel | Separate `CLOUDFLARE_TUNNEL_TOKEN` per stack |
| Ports | Explicit per-claw — no auto-assignment collisions |
| Data | Separate `install_dir` → separate instance dirs |
| Host config | First stack: `host:` with values. Others: `host: false` |

Containers from different stacks **cannot see each other** — separate Docker networks.

---

## What This Replaces

| Current | New |
|---|---|
| `openclaw-config.env` (80+ flat vars) | `.env` (secrets) + `stack.yml` (structured config) |
| `openclaws/<name>/config.env` (per-claw overrides) | `stack.yml` → `claws.<name>` section |
| `openclaw-multi.sh generate` (639 lines) | EJS template + pre-deploy build script |
| `source-config.sh` env resolution | Pre-deploy reads `.env` + `stack.yml` directly |
| `deploy-config.sh` sed/`{{VAR}}` substitution | Env vars via compose + `envsubst` at runtime |
| SCP-based deploy | Git push to VPS |
| `setup-infra.sh` network creation | Compose-managed network |
| systemd cloudflared | Compose sidecar container |
| Separate Vector compose project | Conditional Vector in same compose |

**Preserved:**

- `openclaw.json` config files (now using `$VAR` env var references instead of `{{VAR}}`)
- `deploy/plugins/` — plugins shipped to VPS
- `deploy/build-openclaw.sh` — image building (on VPS)
- `deploy/entrypoint-gateway.sh` — container startup (now also runs `envsubst` on openclaw.json)
- Host scripts — alerter, maintenance checker

---

## Notes

1. **Resource budget enforcement.** `stack.resources.max_cpu: 90%`

    — When this is a % and not an integer, build script should first check resource limits on VPS then resolve this to an actual number
    - Build script passes the resolved stack.yml to the docker-compose.yml template to then use for inline calculations - e.g. can do math in the template to determine how to effeciently divide up the resources per claw as needed

## Open Questions

IMPORTANT: discuss these first before proceeding with full implementation.

1. **`.deploy/` git repo setup.** On first deploy, how is the VPS-side repo created? Options: (a) `bun run init` handles setup, (b) first deploy creates it lazily.

2. **EJS for compose vs simpler approach.** EJS is powerful but adds a dependency and makes the compose template harder to read at a glance. Alternative: a simpler custom templating (like Handlebars or even just JSON-to-YAML generation in TypeScript). Worth considering during implementation.

3. **Subnet conflicts.** Both stacks use `172.30.0.0/24` in the example. Docker Compose may auto-assign different subnets, but explicit config could collide. Should `stack.yml` include an optional `network.subnet` field, or just let Docker auto-assign?

4. **envsubst scope.** `envsubst` replaces ALL `$VAR` references in openclaw.json with their env var values (or empty string if unset). This is fine for our controlled templates, but means literal `$` in JSON values would need escaping. Should the entrypoint use `envsubst` with an explicit variable list to avoid accidental substitutions? e.g. `envsubst '$OPENCLAW_DOMAIN_PATH $OPENCLAW_DOMAIN ...' < template > resolved`

5. **models.json.** Excluded from this plan — separate exploration in progress. Will need its own resolution approach once that's done.
