# Plan: Simplify Stack — Single VPS + Cloudflare Workers

## Context

The current two-VPS architecture (gateway + full LGTM observability stack) is overengineered for the actual needs. We only care about two things:

1. **LLM request tracking** — already handled by the AI Gateway worker via Cloudflare AI Gateway analytics
2. **Log collection offsite** — container logs shipped to Cloudflare for console viewing

The OTEL integration required 3 build-time patches (dual-bundle fix, API compat hacks), a WireGuard tunnel, and 6 containers on VPS-2 (Prometheus, Grafana, Loki, Tempo, Alertmanager, cAdvisor). All of that goes away.

**Result:** Single VPS, no WireGuard, no OTEL patches, return to near-upstream OpenClaw. Simpler, cheaper, less to maintain.

---

## Architecture: Before → After

**Before:**

```
Users → Cloudflare → Tunnel → VPS-1 (gateway, promtail, node-exporter)
                            ↕ WireGuard
                     Tunnel → VPS-2 (prometheus, grafana, loki, tempo, alertmanager, cadvisor)
```

**After:**

```
Users → Cloudflare → Tunnel → VPS-1 (gateway, vector)
                  → AI Gateway Worker (LLM proxy + analytics)
                  → Log Receiver Worker (log ingestion)
                  → Health Check (uptime alert → email)
VPS-1 cron → Telegram API (disk/memory/CPU alerts)
```

---

## Phase 1: Pre-flight — Snapshot Current State

**Create `otel-v1` branch** to preserve the current OTEL-based architecture before removing it.

```bash
git checkout -b otel-v1
git push origin otel-v1
git checkout main
```

---

## Phase 2: Create Log Receiver Worker

**Location:** `workers/log-receiver/`

A minimal Cloudflare Worker (same patterns as `workers/ai-gateway/`) that receives batched log lines and writes them to `console.log()`. Cloudflare captures Worker console output via real-time Logs dashboard and Logpush.

### Files to create

```
workers/log-receiver/
├── package.json
├── tsconfig.json
├── wrangler.jsonc
└── src/
    ├── index.ts       # POST /logs endpoint + GET /health
    ├── auth.ts        # Copy from ai-gateway (timing-safe token check)
    ├── cors.ts        # Copy from ai-gateway
    ├── errors.ts      # Copy from ai-gateway
    └── types.ts       # Env type (AUTH_TOKEN secret)
```

### Endpoint design

**`POST /logs`** — Receives log events from Vector (newline-delimited JSON):

```
{"container_name":"openclaw-gateway","message":"Gateway started","stream":"stdout","timestamp":"2026-02-07T10:30:00Z","host":"openclaw","image":"openclaw:local"}
{"container_name":"vector","message":"Healthcheck OK","stream":"stdout","timestamp":"2026-02-07T10:30:01Z","host":"openclaw","image":"timberio/vector:0.43.1-alpine"}
```

Handler:

1. Validate auth (Bearer token)
2. Read request body as text
3. Split by newlines, parse each JSON line
4. For each entry: `console.log(JSON.stringify(entry))` — Cloudflare captures this
5. Return `{"status":"ok","count":N}`

**`GET /health`** — No auth, returns `{"status":"ok"}`

### Deployment

```bash
cd workers/log-receiver
npm install
wrangler secret put AUTH_TOKEN
npm run deploy
```

### Future extension (not in this plan)

- Write to R2 for long-term storage
- Logpush to external destinations (Datadog, S3, etc.)

---

## Phase 3: Create Log Shipper on VPS-1 (Vector)

**Approach:** [Vector](https://vector.dev) — a lightweight Rust-based log pipeline (~50MB). Handles Docker log discovery, position tracking, retries, backpressure, and log rotation out of the box. Config-only, no custom code.

**Why Vector:**

- Battle-tested (by Datadog, open source, Rust)
- Built-in `docker_logs` source — auto-discovers containers via Docker socket
- Built-in `http` sink with bearer auth — ships directly to the Worker
- Automatic checkpointing in `/var/lib/vector/` — survives restarts, catches up
- Handles log rotation, backpressure, retries — no edge cases to code around
- ~50MB image, very low resource usage

### Files to create

**`vector.toml`** — Vector configuration (in openclaw repo root):

```toml
# Collect logs from all Docker containers
[sources.docker_logs]
type = "docker_logs"

# Ship to Cloudflare Log Receiver Worker
[sinks.cloudflare_worker]
type = "http"
inputs = ["docker_logs"]
uri = "${LOG_WORKER_URL}"
encoding.codec = "json"
auth.strategy = "bearer"
auth.token = "${LOG_WORKER_TOKEN}"

[sinks.cloudflare_worker.batch]
max_bytes = 262144    # 256KB per batch
timeout_secs = 60     # Ship at least every 60s

[sinks.cloudflare_worker.request]
retry_max_duration_secs = 300   # Keep retrying for 5 min on failures
```

Vector's `docker_logs` source automatically includes these fields per event:

- `container_name`, `container_id`, `image`
- `message` (the log line)
- `stream` (stdout/stderr)
- `timestamp`
- `host`

The Worker receives these as JSON — no transforms needed.

**Container in `docker-compose.override.yml`:**

```yaml
vector:
  image: timberio/vector:0.43.1-alpine
  container_name: vector
  restart: always
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - ./vector.toml:/etc/vector/vector.toml:ro
    - ./data/vector:/var/lib/vector           # Checkpoint/position data
  environment:
    - LOG_WORKER_URL=${LOG_WORKER_URL}
    - LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
  deploy:
    resources:
      limits:
        cpus: "0.25"
        memory: 128M
  networks:
    - openclaw-gateway-net
```

### Log Worker request format (what Vector sends)

Vector's HTTP sink with `encoding.codec = "json"` sends newline-delimited JSON by default. Each line is one log event:

```json
{"container_name":"openclaw-gateway","message":"Gateway started on port 18789","stream":"stdout","timestamp":"2026-02-07T10:30:00.123Z","host":"openclaw","image":"openclaw:local",...}
```

The Worker parses each line and `console.log()`s it.

### Crash log guarantees

- Container crashes → Docker captures stdout/stderr in JSON log files → Vector catches up from checkpoint
- Vector crashes → `restart: always` brings it back → reads from last checkpoint in `./data/vector/`
- Docker daemon crashes → Vector also stops → both restart → Vector catches up
- VPS reboots → compose `restart: always` → Vector catches up from persisted checkpoints

The only gap is if the VPS is permanently down, but that requires manual intervention regardless.

### Note on Log Worker format

The Log Receiver Worker needs to accept Vector's output format (newline-delimited JSON or JSON array). The Worker should split on newlines, parse each JSON object, and `console.log()` it. This is simpler than defining a custom schema — we just pass through whatever Vector sends.

---

## Phase 3b: Host Monitoring (Replaces Prometheus+Alertmanager)

Two lightweight replacements:

### Cloudflare Health Check (uptime monitoring)

- Configure in Cloudflare dashboard: Health Check on `https://<OPENCLAW_DOMAIN>/health`
- Checks every 1-5 minutes from Cloudflare edge
- Email/webhook notification if gateway is unreachable
- Free on all Cloudflare plans
- Covers: "is the service reachable through the tunnel"

### Cron alerter script (host resource monitoring)

A simple bash script on VPS-1 that checks disk/memory/CPU and sends alerts via Telegram (bot token already configured in `.env`).

**File:** `scripts/host-alert.sh`

- Checks: disk usage > 85%, memory usage > 90%, Docker daemon health, container crash count
- Sends Telegram message via bot API if any threshold is exceeded
- Runs via `/etc/cron.d/openclaw-alerts` every 15 minutes
- Runs as root (needs access to system metrics)
- Idempotent: only alerts on state *change* (tracks last alert in a state file to avoid spam)

**Cron entry:** `*/15 * * * * root /home/openclaw/scripts/host-alert.sh`

**Telegram API call:**

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "text=⚠️ VPS Alert: Disk usage at 92%"
```

Requires adding `TELEGRAM_CHAT_ID` to `openclaw-config.env` (the chat/group ID to send alerts to).

---

## Phase 4: Remove VPS-2 Dependencies from VPS-1

### 4a. Simplify build script (`scripts/build-openclaw.sh`)

**Remove patches 1, 2a, 2b, 3** (all OTEL-related):

- Patch 1: Dockerfile extension deps copy
- Patch 2a: `Resource` → `resourceFromAttributes()`
- Patch 2b: `LoggerProvider` constructor-based processors
- Patch 3: `diagnostic-events.ts` globalThis shared listener Set

**Keep patches 4, 5** (sandbox infrastructure):

- Patch 4: Claude Code CLI install
- Patch 5: Docker + gosu install

**Update cleanup step** — no longer need to restore `extensions/` or `src/infra/diagnostic-events.ts`:

```bash
git checkout -- Dockerfile 2>/dev/null || true
```

### 4b. Simplify `openclaw.json`

**Remove:**

```json
"plugins": { ... },
"diagnostics": { ... }
```

**Keep everything else** (gateway, agents, sandbox, tools, commands).

### 4c. Simplify `docker-compose.override.yml`

**Remove services:**

- `node-exporter` (was scraped by Prometheus on VPS-2)
- `promtail` (was shipping to Loki on VPS-2)

**Remove environment variables from gateway:**

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`

**Add service:**

- `vector` (see Phase 3)

### 4d. Simplify `.env`

**Remove:**

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `GRAFANA_PASSWORD` (no more Grafana)

**Add:**

- `LOG_WORKER_URL=https://log-receiver.<account>.workers.dev`
- `LOG_WORKER_TOKEN=<generated-token>`

### 4e. Configure AI Gateway Worker for LLM requests

Route OpenClaw's API calls through the AI Gateway worker instead of directly to Anthropic. The real API keys live only on the Worker (Cloudflare), not on the VPS.

**In `.env`:**

```
ANTHROPIC_API_KEY=<worker-auth-token>           # Worker's AUTH_TOKEN, not real Anthropic key
ANTHROPIC_BASE_URL=https://ai-gateway-proxy.<account>.workers.dev
```

The Anthropic SDK (used by OpenClaw) respects `ANTHROPIC_BASE_URL` to redirect all API calls. The Worker receives them, swaps auth, and forwards through Cloudflare AI Gateway to Anthropic.

**Verify:** This needs testing — confirm OpenClaw/Anthropic SDK picks up `ANTHROPIC_BASE_URL` from env.

### 4f. Remove WireGuard from VPS-1

```bash
sudo systemctl stop wg-quick@wg0
sudo systemctl disable wg-quick@wg0
sudo rm /etc/wireguard/wg0.conf /etc/wireguard/private.key
sudo apt remove wireguard wireguard-tools
```

### 4g. Simplify UFW on VPS-1

**Remove rules:**

- `51820/udp` (WireGuard)
- `9100/tcp from 10.0.0.0/24` (Node Exporter)
- `18789/tcp from 10.0.0.0/24` (Gateway debug via WireGuard)

**Keep rules:**

- `222/tcp` (SSH)

**Result:** Only SSH port exposed. Gateway accessed exclusively via Cloudflare Tunnel (outbound only).

### 4h. Remove `promtail-config.yml` and `promtail-positions/`

No longer needed — Vector replaces Promtail.

### 4i. Deploy host alerter script

- Copy `scripts/host-alert.sh` to VPS-1 at `/home/openclaw/scripts/host-alert.sh`
- Create cron entry at `/etc/cron.d/openclaw-alerts`
- Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in openclaw-config.env

---

## Phase 5: Decommission VPS-2

### On VPS-2

```bash
# Stop all monitoring containers
cd /home/openclaw/monitoring
sudo -u openclaw docker compose down

# Stop and remove Cloudflare Tunnel
sudo systemctl stop cloudflared
sudo systemctl disable cloudflared
cloudflared tunnel delete observe

# Remove WireGuard
sudo systemctl stop wg-quick@wg0
sudo systemctl disable wg-quick@wg0

# Remove DNS route for Grafana domain
cloudflared tunnel route dns observe <DOMAIN_GRAFANA>  # (delete this CNAME)
```

**VPS cancellation:** User decides whether to cancel the OVH VPS or repurpose it.

---

## Phase 6: Update Documentation & Config

### `openclaw-config.env` / `openclaw-config.example.env`

**Remove:**

- `VPS2_IP`, `VPS2_HOSTNAME`
- `DOMAIN_GRAFANA`, `SUBPATH_GRAFANA`
- `OPENCLAW_OTEL_*` vars

**Add:**

- `LOG_WORKER_URL`
- `LOG_WORKER_TOKEN`
- `AI_GATEWAY_WORKER_URL`
- `TELEGRAM_CHAT_ID` (for host alerter)

### `CLAUDE.md`

Major rewrite — single VPS architecture:

- Remove VPS-2 from tables and flow
- Remove WireGuard section
- Remove OTEL references
- Simplify playbook table (remove 02, 05)
- Update Setup Question Flow (no VPS-2 SSH check)
- Update execution order
- Add Workers deployment section

### `REQUIREMENTS.md`

Major rewrite to match new architecture:

- Section 1: Single VPS topology
- Section 2: Remove WireGuard from common requirements
- Section 3: Remove OTEL, Promtail, Node Exporter; add log shipper
- Section 4: Replace entirely with Cloudflare Workers section
- Section 5: Simplified ports table
- Section 6: Remove OTEL, Tempo, Loki, Grafana gotchas

### Playbooks

- **Remove or archive:** `02-wireguard.md`, `05-vps2-observability.md`
- **Update:** `04-vps1-openclaw.md` (no OTEL, no Promtail, no Node Exporter, add Vector + host alerter)
- **Update:** `07-verification.md` (no VPS-2 checks, add Worker health checks)
- **Update:** `networking/cloudflare-tunnel.md` (VPS-1 only, remove VPS-2 tunnel)
- **New:** Playbook for Workers deployment (AI Gateway + Log Receiver)

### `MEMORY.md`

Remove OTEL-specific learnings that no longer apply. Keep sandbox, Docker, SSH, build gotchas.

---

## Verification

### Workers

- `curl https://<log-worker>/health` returns `{"status":"ok"}`
- `curl -X POST https://<log-worker>/logs -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"container_name":"test","message":"hello","stream":"stdout","timestamp":"2026-02-07T00:00:00Z"}'` returns `{"status":"ok","count":1}`
- Verify log appears in Cloudflare Workers real-time logs dashboard
- `curl https://<ai-gateway>/health` returns `{"status":"ok"}`

### VPS-1

- Gateway starts without OTEL errors: `sudo docker exec openclaw-gateway node dist/index.js devices list`
- Vector is running: `docker compose ps vector`
- Vector checkpoints updating: check `./data/vector/` for recent checkpoint files
- Webchat works: send a message, verify response
- Verify LLM request appears in Cloudflare AI Gateway analytics dashboard
- Verify container logs appear in Log Receiver Worker's real-time logs
- No WireGuard interface: `ip link show wg0` should fail
- UFW only has SSH: `sudo ufw status`
- Host alerter works: manually run `scripts/host-alert.sh` — verify no false alerts

### Crash recovery test

- `docker restart openclaw-gateway` — verify Vector catches gateway restart logs
- Verify logs appear in Worker within ~60s (Vector batch timeout)
- `docker restart vector` — verify it catches up from checkpoints

---

## Summary of what's removed

| Component | Was on | Purpose | Replacement |
|-----------|--------|---------|-------------|
| VPS-2 | VPS-2 | Observability | Cloudflare Workers |
| WireGuard | Both | Inter-VPS tunnel | Not needed (single VPS) |
| Prometheus | VPS-2 | Metrics | AI Gateway analytics |
| Grafana | VPS-2 | Dashboards | Cloudflare AI Gateway dashboard |
| Loki | VPS-2 | Log storage | Log Receiver Worker |
| Tempo | VPS-2 | Trace storage | Not needed (AI Gateway tracks requests) |
| Alertmanager | VPS-2 | Alerts | Cloudflare Health Check + cron alerter (Telegram) |
| cAdvisor | VPS-2 | Container metrics | Not needed |
| Node Exporter | VPS-1 | Host metrics | Not needed |
| Promtail | VPS-1 | Log shipping to Loki | Vector container |
| OTEL patches (1-3) | Build | OTEL compat hacks | Removed entirely |
| OTEL plugin config | openclaw.json | Diagnostics | Removed |
| OTEL env vars | .env | Signal routing | Removed |

## What stays unchanged

- Gateway container (Sysbox, Docker-in-Docker, sandboxes, browser)
- Build patches 4-5 (Claude Code CLI, Docker+gosu)
- Cloudflare Tunnel (VPS-1 only)
- SSH hardening, UFW, fail2ban, kernel hardening
- Backup cron job (simplified — no promtail-positions)
- Device pairing flow
- Two-user security model (adminclaw/openclaw)

## New components added

| Component | Location | Purpose |
|-----------|----------|---------|
| Log Receiver Worker | `workers/log-receiver/` | Accepts logs, console.logs for Cloudflare capture |
| Vector container | `docker-compose.override.yml` | Ships Docker container logs to Worker |
| `vector.toml` | Openclaw repo root on VPS-1 | Vector configuration |
| `host-alert.sh` | `scripts/` on VPS-1 | Cron script: disk/memory/CPU → Telegram alerts |
| Cloudflare Health Check | Cloudflare dashboard | Uptime monitoring on gateway /health |
