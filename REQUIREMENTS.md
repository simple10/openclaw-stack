# REQUIREMENTS.md — OpenClaw Single-VPS Deployment

Architecture decisions, security rationale, and critical gotchas. Implementation details live in playbooks and deploy files — this document explains **why**, not **how**.

---

## 1. Architecture Overview

Single VPS running the OpenClaw gateway and sandboxes. Observability is handled by Cloudflare Workers (log ingestion, LLM analytics). External access is via Cloudflare Tunnel (outbound-only connections, no inbound ports exposed).

**Data flow:**

- Users -> Cloudflare Edge -> Cloudflare Tunnel -> VPS-1 gateway (port 18789)
- Users -> Cloudflare -> AI Gateway Worker (LLM proxy; routes to providers directly or via optional CF AI Gateway)
- VPS-1 Vector -> Cloudflare Log Receiver Worker (log ingestion)
- VPS-1 cron -> Telegram API (host alerts)

---

## 2. Security Model

### 2.1 Two-User Model

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key-only, port 222 | Passwordless | System admin, SSH access |
| `openclaw` | None | None | Application runtime, file ownership |

**Rationale:** If `openclaw` is compromised, the attacker cannot escalate to root. Clear separation between admin tasks and application runtime.

### 2.2 Network Security

- **Cloudflare Tunnel** — Zero exposed ports beyond SSH. `cloudflared` makes outbound-only connections; port 443 stays closed.
- **Docker bypasses UFW** — iptables DOCKER chain runs before INPUT. Requires **two** daemon.json settings: `"ip": "127.0.0.1"` (default bridge) + `"default-network-opts"` with `host_binding_ipv4` (user-defined bridges). Both are needed to ensure all container ports bind to localhost.
- **`--bind lan`** — Required for Docker deployments. `loopback` doesn't work because cloudflared connects via Docker bridge (`172.30.0.1` on `eth0`, not loopback). `openclaw doctor` warns; the warning is expected. Security enforced by daemon.json localhost binding.
- **`trustedProxies: ["172.30.0.1"]`** — cloudflared connects via Docker bridge gateway IP. Only exact IPs work — CIDR ranges NOT supported.

### 2.3 UID & Ownership

- Host `ubuntu` = uid 1000, host `openclaw` = uid 1002, container `node` = uid 1000
- `.openclaw` files owned by uid 1000 (matches `ubuntu`, not `openclaw`). Backups must run as root.
- Sysbox remaps host uid 1000 to uid 1002 inside container — entrypoint `chown` fixes this before gosu drops privileges.

---

## 3. Key Design Decisions

### 3.1 Gateway Container

| Setting | Rationale |
|---------|-----------|
| `user: "0:0"` | Root inside container — Sysbox maps to unprivileged uid on host. Required for starting `dockerd`. Entrypoint drops to node via gosu. |
| `read_only: false` | **Required.** Sysbox auto-mounts for `/var/lib/docker` inherit this flag. With `true`, dockerd gets read-only filesystem error. |
| `/var/lib/docker` bind mount | Persists nested Docker images across container restarts. Without this, Sysbox auto-provisions ephemeral storage destroyed on `docker compose down`, forcing ~5-15 min sandbox rebuild. |
| `memory: 9G` | Outer ceiling for gateway + all nested sandbox containers (cgroup hierarchy) |

### 3.2 Sandbox Configuration

| Setting | Rationale |
|---------|-----------|
| `sandbox.mode: "non-main"` | Main agent operator DM runs on host (gateway control, CLI access). All other sessions/agents run in Docker sandboxes. Requires Docker inside container (build patch #1). |
| `tools.elevated.allowFrom.telegram` | Gates host exec access from sandboxed sessions to specific Telegram sender IDs. Only listed user IDs can trigger elevated tool use (e.g., shell commands on the gateway host). |
| `sandbox.docker.network` default `"none"` | No network by default. Per-agent override to `"bridge"` required for browser tool (CDP) and internet access. |
| `readOnlyRoot: true` | Read-only sandbox filesystem. Home dir writable via tmpfs. |
| `tmpfs /home/linuxbrew:uid=1000,gid=1000` | Writable `$HOME`. The `:uid=1000,gid=1000` is critical — without it, tmpfs mounts as root-owned. |
| `capDrop: ["ALL"]` | Drop all Linux capabilities — minimal privilege. |
| Per-agent `binds` | **Replace** defaults entirely (not merge). Agents with custom binds must repeat all default binds. |

### 3.3 Docker Networks

| Network | Subnet | Flags | Purpose |
|---------|--------|-------|---------|
| `openclaw-gateway-net` | `172.30.0.0/24` | external | Gateway, cloudflared |
| `openclaw-sandbox-net` | `172.31.0.0/24` | internal | Agent sandboxes (no outbound internet) |

Subnets use `172.30.x.x` / `172.31.x.x` to avoid conflicts with Docker's default `172.17.0.0/16`.

### 3.4 Persistent Sandbox Home Directories

Bind chain for agents needing persistent `$HOME` (credentials, SSH keys):

1. Host: `/home/openclaw/sandboxes-home/<agent-id>/`
2. -> Gateway: `/home/node/sandboxes-home/<agent-id>/` (compose volume)
3. -> Sandbox: `/home/sandbox` (openclaw.json agent `binds`)

**Credential isolation:** Sandbox gets its own credentials (NOT gateway's). Gateway credentials are device-bound OAuth tokens that don't work across containers.

### 3.5 LLM API Key Isolation

All provider API keys are set to `AI_GATEWAY_AUTH_TOKEN` and base URLs to `AI_GATEWAY_WORKER_URL`. Real keys live only on the Cloudflare Worker, never on the VPS. Unsupported providers fail at the Worker (404), preventing leakage.

### 3.6 Build Patches

3 patches applied to upstream before `docker build`, each auto-skips when upstream fixes the issue:

| # | Target | Issue |
|---|--------|-------|
| 1 | Dockerfile | Docker + gosu for nested Docker |
| 2 | Dockerfile | Clear build-time jiti cache |
| 3 | `docker.ts` | Sandbox env vars not passed to `docker create` |

---

## 4. Directory Structure

```
/home/openclaw/
├── openclaw/                    # Cloned upstream repo
│   ├── docker-compose.yml       # Upstream
│   ├── docker-compose.override.yml  # Our customizations
│   ├── .env                     # Environment variables
│   ├── data/
│   │   └── docker/              # Persistent nested Docker storage
│   └── scripts/
│       └── entrypoint-gateway.sh
├── vector/                      # Vector log shipper (separate compose project)
│   ├── docker-compose.yml
│   ├── vector.yaml
│   ├── .env                     # LOG_WORKER_URL, LOG_WORKER_TOKEN, VPS1_IP
│   └── data/                    # Vector checkpoint data
├── .openclaw/                   # Gateway config & state (owned by uid 1000)
│   ├── openclaw.json            # Gateway configuration (chmod 600)
│   ├── workspace/               # Agent template workspaces
│   ├── sandboxes/               # Per-agent sandbox workspace copies
│   ├── credentials/
│   ├── logs/
│   └── backups/
├── sandboxes-home/              # Persistent sandbox home dirs
│   └── code/                    # Code agent's $HOME
└── scripts/
    ├── build-openclaw.sh        # Build with auto-patching
    ├── host-alert.sh            # Cron: alerts + daily report -> Telegram
    ├── host-maintenance-check.sh  # Cron: OVH maintenance detection
    └── backup.sh                # Cron: daily backup
```

---

## 5. Ports Reference

| Port | Binding | Service | Access |
|------|---------|---------|--------|
| 222/tcp | 0.0.0.0 | SSH | Public (key-only, adminclaw) |
| 18789/tcp | 127.0.0.1 | Gateway | Via Cloudflare Tunnel only |
| 18790/tcp | 127.0.0.1 | Bridge API | Local only |

---

## 6. Critical Gotchas

### Security

- **UsePAM must be `yes` on Ubuntu** — `no` breaks SSH authentication entirely
- **SSH port change requires both** `sshd_config` AND systemd socket override (Ubuntu socket activation)
- **UFW before SSH port change** — configure UFW rules BEFORE changing SSH port to prevent lockout
- **adminclaw can't cd into `/home/openclaw/`** — 750 perms. Use `sudo -u openclaw bash -c "cd ... && ..."`

### Container & Build

- **`OPENCLAW_GATEWAY_PORT` must be port only** — `127.0.0.1:18789` causes CLI to misparse `127` as port
- **Dockerfile patches must go before `USER node`** — apt can't write to system dirs after user change. Failed builds leave patches in place — manually `git checkout -- Dockerfile src/agents/sandbox/docker.ts` before retry.
- **`docker compose restart` does NOT reload `.env`** — values baked at container creation. Use `up -d <service>` after `.env` changes.

### Sandbox

- **Do NOT use `docker build -f - /dev/null`** in Sysbox — use `printf ... | docker build -t tag -`
- **Do NOT use `docker run`/`docker commit`** — creates dirty layers. Use `docker build` with FROM.

### Vector

- **Separate compose project** — Vector runs independently in `openclaw/vector/`. Start/stop with `cd vector && docker compose up -d`. Does not affect the gateway lifecycle.
- **`LOG_WORKER_URL` must include `/logs` path** — Vector sends to this URL directly
- If `vector/data/` is deleted, Vector re-ships all logs from the beginning (safe but bursty)
