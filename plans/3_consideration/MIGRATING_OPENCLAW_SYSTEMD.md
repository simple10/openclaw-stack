# Plan: Migrate OpenClaw Gateway from Docker to Native systemd Service

## Context

The README says it all: *"This feature branch is an ongoing experiment to get openclaw-gateway to run in a container without being severely limited."* The containerized gateway has accumulated 7 custom workarounds:

1. `Dockerfile.custom` — forked upstream Dockerfile (issue #7201)
2. `patches-runtime/diagnostics-otel-service.ts` — runtime volume-mount patch (issue #3201)
3. `scripts/entrypoint-gateway.sh` — custom entrypoint for lock cleanup + sandbox bootstrap
4. `docker-compose.override.yml` — extensive overrides (Sysbox, security, OTEL, networking)
5. Sysbox runtime — only needed because gateway runs Docker-in-Docker
6. Custom Docker bridge network (172.30.0.0/24)
7. `trustedProxies: ["172.30.0.1"]` — because cloudflared routes through Docker bridge

Running natively eliminates **all seven**. Docker stays on VPS-1 for sandbox containers, node-exporter, and promtail.

## What Changes

| Before (containerized) | After (native) |
|------------------------|-----------------|
| Gateway in Docker + Sysbox | Gateway as systemd service (`openclaw` user) |
| Custom Dockerfile for OTEL deps | `pnpm install` handles extension deps directly |
| Runtime volume-mount patch | Patch applied to source tree before build |
| Custom entrypoint script | systemd `ExecStartPre` for lock cleanup |
| Docker-in-Docker for sandboxes | Host Docker daemon (openclaw in docker group) |
| Docker bridge + trustedProxies | cloudflared/Caddy connect to localhost directly |
| `docker exec` for CLI | `node dist/index.js` directly |
| Docker JSON logs → Promtail | journald → Promtail (journal scraper) |

## Architecture After Migration

```
VPS-1 (10.0.0.1):
  Native processes (systemd):
    - openclaw-gateway    (Node.js 22, runs as openclaw user)
    - cloudflared         (already native/systemd — no change)

  Docker containers:
    - node-exporter       (host metrics → Prometheus on VPS-2)
    - promtail            (logs → Loki on VPS-2)
    - sandbox-*           (created/destroyed by gateway on demand)

VPS-2 (10.0.0.2): UNCHANGED
```

---

## Implementation

### 1. Add Node.js 22 + pnpm to `playbooks/02-base-setup.md` (VPS-1 only)

New section after system update:

```bash
# NodeSource apt repo (system-wide, matches upstream requirements)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable

# Bun (needed by OpenClaw build scripts) — installed for openclaw user
curl -fsSL https://bun.sh/install | sudo -u openclaw bash
```

NodeSource over nvm because systemd needs a stable `/usr/bin/node` path.

### 2. Rewrite `playbooks/04-vps1-openclaw.md`

**Remove entirely:**

- 4.1 Sysbox installation
- 4.2 Docker networks (172.30.0.0/24, 172.31.0.0/24)
- 4.6 docker-compose.override.yml (gateway portion)
- 4.8a Dockerfile.custom
- 4.8b Runtime OTEL patch
- 4.8c Custom entrypoint

**Keep/modify:**

- 4.3 Directory structure — remove uid 1000 ownership hacks
- 4.4 Clone repo — unchanged
- 4.5 Environment file — convert from Docker `.env` to systemd `EnvironmentFile` (`gateway.env`)

**New sections:**

#### Build script (`/home/openclaw/scripts/build-openclaw.sh`)

```bash
#!/bin/bash
set -euo pipefail
cd /home/openclaw/openclaw

# Apply OTEL v2.x patch if needed (upstream #3201)
if grep -q "new Resource(" extensions/diagnostics-otel/src/service.ts 2>/dev/null; then
  echo "[build] Applying OTEL v2.x compatibility patch..."
  git apply /home/openclaw/patches/otel-v2-compat.patch
fi

# Build
pnpm install --frozen-lockfile
OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
pnpm ui:build

# Restore patched files for clean git state
git checkout -- extensions/ 2>/dev/null || true
echo "[build] Done."
```

No Dockerfile.custom needed — `pnpm install` picks up extension deps naturally when run from the repo root (the Dockerfile issue was specifically about the Docker COPY ordering).

#### OTEL patch (`/home/openclaw/patches/otel-v2-compat.patch`)

Same two fixes as current runtime patch, but as a unified diff:

- `new Resource()` → `resourceFromAttributes()`
- `logProvider.addLogRecordProcessor()` → constructor-based `logRecordProcessors: [...]`

#### systemd unit (`/etc/systemd/system/openclaw-gateway.service`)

```ini
[Unit]
Description=OpenClaw Gateway
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=exec
User=openclaw
Group=openclaw
WorkingDirectory=/home/openclaw/openclaw
EnvironmentFile=/home/openclaw/openclaw/gateway.env

ExecStartPre=/bin/bash -c 'rm -f /home/openclaw/.openclaw/gateway.*.lock'
ExecStart=/usr/bin/node dist/index.js gateway --allow-unconfigured --bind lan --port 18789

Restart=on-failure
RestartSec=5

# Resource limits (replaces Docker deploy.resources.limits)
CPUQuota=400%
MemoryMax=8G

# Security hardening (replaces Docker read_only + no-new-privileges)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=tmpfs
BindPaths=/home/openclaw
ReadWritePaths=/home/openclaw/.openclaw /home/openclaw/openclaw /tmp
PrivateTmp=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw-gateway

[Install]
WantedBy=multi-user.target
```

Key: `ExecStartPre` replaces the entrypoint's lock cleanup. `Requires=docker.service` ensures Docker is available for sandbox containers.

#### Minimal docker-compose.yml (node-exporter + promtail only)

```yaml
services:
  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    restart: unless-stopped
    network_mode: host
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /run/log/journal:/run/log/journal:ro
      - /etc/machine-id:/etc/machine-id:ro
      - ./data/promtail-positions:/tmp
```

#### Update promtail config — add journald scraper

```yaml
scrape_configs:
  # ... existing system + docker scrape configs ...

  # Gateway logs from journald (new)
  - job_name: journal
    journal:
      json: false
      max_age: 12h
      labels:
        job: gateway
        host: openclaw
      path: /run/log/journal
    relabel_configs:
      - source_labels: ['__journal__systemd_unit']
        regex: 'openclaw-gateway.service'
        action: keep
```

#### Simplify openclaw.json

One config for both networking options (no `if/else` for trustedProxies):

```json
{
  "commands": { "restart": true },
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "controlUi": { "basePath": "/_openclaw" }
  },
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": { "diagnostics-otel": { "enabled": true } }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true, "metrics": true, "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 20000
    }
  }
}
```

No `trustedProxies` — cloudflared connects to localhost:18789 directly (confirmed: it's already a native systemd service, not containerized).

### 3. Update networking playbooks

Minimal changes — both `cloudflare-tunnel.md` and `caddy.md` already connect to `localhost:18789`. Only update troubleshooting commands: `docker compose ps` → `systemctl status openclaw-gateway`.

### 4. Update `CLAUDE.md`

- Architecture table: `Gateway, Sysbox, Node Exporter, Promtail` → `Gateway (native/systemd), Node Exporter, Promtail`
- Service management: Docker commands → systemd commands for gateway
- Remove deployment notes: Docker networks, uid 1000 ownership, trustedProxies, entrypoint script
- Update device pairing: `docker exec openclaw-gateway node dist/index.js` → `sudo -u openclaw bash -c 'cd ~/openclaw && node dist/index.js'`
- Update CLI reference: same pattern

### 5. Update `README.md`

- Remove Docker experiment disclaimer (lines 1-3)
- Remove Sysbox from requirements
- Update architecture diagram and table
- Update "What Claude Will Do" section

### 6. Update supporting playbooks

- `06-backup.md` — path changes (`.env` → `gateway.env`), restore uses `systemctl` not `docker compose`
- `07-verification.md` — replace Docker container checks with `systemctl status` / `journalctl`
- `98-post-deploy.md` — device pairing commands use direct `node dist/index.js` instead of `docker exec`

### 7. Archive obsolete plans

- `plans/OPENCLAW_DOCKER_UPDATE.md` — Docker-specific, no longer relevant
- `plans/_self-modification-loop_docker-concerns.md` — Docker-specific concerns

---

## Key Design Decisions

**OTEL deps without Dockerfile.custom:** The Dockerfile issue (#7201) was specifically that `COPY package.json` didn't include extension dirs before `pnpm install --frozen-lockfile`. Running `pnpm install` natively from the repo root doesn't have this problem — the workspace config already includes extensions.

**Security tradeoff:** Lose container isolation (read-only FS, seccomp). Gain systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`). The `openclaw` user in the docker group has effective root via Docker — this is standard for OpenClaw and was already true in the containerized setup (Sysbox gave the container Docker access).

**Self-restart (SIGUSR1):** OpenClaw's `commands.restart: true` triggers an in-process restart via SIGUSR1 — the process doesn't exit. systemd won't interfere. If it does exit, `Restart=on-failure` catches it.

**Self-update:** Now possible! `.git` is present. `git pull && build && systemctl restart` is clean.

---

## Files to Modify

| File | Change |
|------|--------|
| `playbooks/02-base-setup.md` | Add Node.js 22 + pnpm install section (VPS-1 only) |
| `playbooks/04-vps1-openclaw.md` | **Major rewrite** — replace containerized gateway with native systemd setup |
| `playbooks/networking/cloudflare-tunnel.md` | Update troubleshooting commands |
| `playbooks/networking/caddy.md` | Update troubleshooting commands |
| `playbooks/06-backup.md` | Update paths and restart commands |
| `playbooks/07-verification.md` | Replace Docker checks with systemd checks |
| `playbooks/98-post-deploy.md` | Update CLI commands (no docker exec) |
| `CLAUDE.md` | Update architecture, commands, deployment notes |
| `README.md` | Remove Docker disclaimer, update architecture/requirements |

---

## Verification

1. Gateway starts: `sudo systemctl status openclaw-gateway`
2. Health check: `curl http://localhost:18789/health`
3. Logs flow to journald: `journalctl -u openclaw-gateway -n 20`
4. OTEL traces in Tempo: make a model call, check Grafana Explore → Tempo
5. OTEL metrics in Prometheus: check Grafana Explore → Prometheus for `openclaw_*` metrics
6. OTEL logs in Loki: check Grafana Explore → Loki with `{job="gateway"}`
7. Promtail scraping journald: `docker logs promtail` shows journal scrape
8. Sandbox works: trigger an agent code execution task
9. Cloudflare tunnel: access via public URL
10. Device pairing: `sudo -u openclaw bash -c 'cd ~/openclaw && node dist/index.js devices list'`
