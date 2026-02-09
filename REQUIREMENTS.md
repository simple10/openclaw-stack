# REQUIREMENTS.md — OpenClaw Single-VPS Deployment

Authoritative reference for the OpenClaw deployment architecture, configuration, and design decisions. Use this as a safety guide when making modifications.

Networking: Cloudflare Tunnel (zero exposed ports, origin IP hidden).

---

## 1. Architecture Overview

Single OVHCloud VPS running the OpenClaw gateway and sandboxes. Observability is handled by Cloudflare Workers (log ingestion, LLM analytics). External access is via Cloudflare Tunnel (outbound-only connections, no inbound ports exposed).

| VPS | Hostname | Role | Public IP |
|-----|----------|------|-----------|
| VPS-1 | `openclaw` | Gateway + Sandboxes | From `openclaw-config.env` |

**Data flow:**

- Users -> Cloudflare Edge -> Cloudflare Tunnel -> VPS-1 gateway (port 18789)
- Users -> Cloudflare -> AI Gateway Worker (LLM proxy + analytics)
- VPS-1 Vector -> Cloudflare Log Receiver Worker (log ingestion)
- VPS-1 cron -> Telegram API (host alerts)
- Cloudflare Health Check -> VPS-1 /health (uptime monitoring)

---

## 2. VPS Requirements

### 2.1 OS & System Packages

**OS:** Ubuntu (OVHCloud VPS default)

**Required packages:**

```
curl wget git vim htop tmux unzip
ca-certificates gnupg lsb-release apt-transport-https software-properties-common
ufw fail2ban auditd
```

### 2.2 Two-User Security Model

| User | SSH Access | Sudo | Purpose |
|------|------------|------|---------|
| `adminclaw` | Key-only, port 222 | Passwordless | System admin, SSH access |
| `openclaw` | None | None | Application runtime, file ownership |

**Rationale:** If `openclaw` is compromised, the attacker cannot escalate to root. `adminclaw` is not a well-known username, reducing brute-force attack surface. Clear separation between admin tasks and application runtime.

**Important:**

- SSH keys are copied from the initial `ubuntu` user to `adminclaw` during setup
- `openclaw` has no SSH access and no sudo — access via `sudo su - openclaw` or `sudo -u openclaw <cmd>`
- Both users should have passwords set (for console access recovery only)
- `adminclaw` cannot `cd` into `/home/openclaw/` (750 perms) — use `sudo -u openclaw bash -c "cd /home/openclaw/... && ..."` or `sudo sh -c 'cd /home/openclaw/... && ...'`

### 2.3 SSH Hardening

**Config file:** `/etc/ssh/sshd_config.d/hardening.conf`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `Port` | `222` | Non-standard port avoids bot scanners |
| `PermitRootLogin` | `no` | Prevent direct root SSH |
| `PasswordAuthentication` | `no` | Key-only authentication |
| `ChallengeResponseAuthentication` | `no` | Disable challenge-response |
| `UsePAM` | `yes` | **Critical on Ubuntu** — `no` breaks authentication |
| `AllowUsers` | `adminclaw` | Only admin user can SSH |
| `MaxAuthTries` | `3` | Rate limit auth attempts |
| `MaxSessions` | `3` | Limit concurrent sessions |
| `LoginGraceTime` | `30` | 30-second window to authenticate |
| `X11Forwarding` | `no` | Disable X11 (not needed) |
| `AllowTcpForwarding` | `no` | Prevent port forwarding |
| `AllowAgentForwarding` | `no` | Prevent agent forwarding |

**Crypto settings:**

- KexAlgorithms: `curve25519-sha256@libssh.org`, `diffie-hellman-group16-sha512`
- Ciphers: `chacha20-poly1305@openssh.com`, `aes256-gcm@openssh.com`
- MACs: `hmac-sha2-512-etm@openssh.com`, `hmac-sha2-256-etm@openssh.com`

**Ubuntu systemd socket activation (critical):**
Ubuntu uses socket activation for SSH. Changing the port requires BOTH:

1. `/etc/ssh/sshd_config.d/hardening.conf` with `Port 222`
2. Systemd socket override at `/etc/systemd/system/ssh.socket.d/override.conf`:

   ```
   [Socket]
   ListenStream=
   ListenStream=0.0.0.0:222
   ListenStream=[::]:222
   ```

The service name is `ssh` on Ubuntu, not `sshd`.

### 2.4 UFW Firewall

**Default policy:** Deny incoming, Allow outgoing

**Rules:**

| Port | Protocol | Rule | Purpose |
|------|----------|------|---------|
| 222 | TCP | Allow | SSH (hardened port) |

**Design decision:** Port 443 is NOT opened. Cloudflare Tunnel uses outbound connections only. Only SSH is exposed.

**Critical ordering:** Configure UFW rules BEFORE changing SSH port. Changing SSH port before adding the UFW rule causes lockout.

### 2.5 Fail2ban

**Config file:** `/etc/fail2ban/jail.local`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `bantime` | `1h` | Default ban duration |
| `findtime` | `10m` | Lookback window for retries |
| `maxretry` | `5` | General retry limit |
| `backend` | `systemd` | Use systemd journal |
| SSH `maxretry` | `3` | Stricter for SSH |
| SSH `bantime` | `24h` | Longer ban for SSH brute force |
| SSH `port` | `222` | Matches hardened SSH port |

### 2.6 Kernel Hardening

**Config file:** `/etc/sysctl.d/99-security.conf`

Key parameters:

- `net.ipv4.conf.all.rp_filter = 1` — IP spoofing protection
- `net.ipv4.icmp_echo_ignore_broadcasts = 1` — Ignore ICMP broadcast
- `net.ipv4.conf.all.accept_source_route = 0` — Disable source routing
- `net.ipv4.conf.all.send_redirects = 0` — Ignore redirects
- `net.ipv4.tcp_syncookies = 1` — SYN flood protection
- `net.ipv4.tcp_max_syn_backlog = 2048`
- `net.ipv4.tcp_synack_retries = 2`
- `net.ipv4.conf.all.log_martians = 1` — Log suspicious packets
- `kernel.randomize_va_space = 2` — Full ASLR
- `kernel.dmesg_restrict = 1` — Restrict dmesg access
- `kernel.kptr_restrict = 2` — Restrict kernel pointer access

### 2.7 Automatic Security Updates

**Package:** `unattended-upgrades`
**Config:** `/etc/apt/apt.conf.d/50unattended-upgrades`

- Allowed origins: Main, Security, ESM Apps, ESM Infra
- `AutoFixInterruptedDpkg: true`
- `Remove-Unused-Kernel-Packages: true`
- `Remove-Unused-Dependencies: true`
- `Automatic-Reboot: false` — Manual reboot preferred to avoid unexpected downtime

### 2.8 Docker

**Package:** Docker CE from official Docker apt repository

**Components:** `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`

**Users in docker group:** `openclaw`, `adminclaw`

**Daemon hardening** (`/etc/docker/daemon.json`):

```json
{
  "ip": "127.0.0.1",
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  },
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" },
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 }
  }
}
```

| Setting | Rationale |
|---------|-----------|
| `ip: 127.0.0.1` | Bind published ports on the **default bridge** to localhost only. Docker bypasses UFW (iptables DOCKER chain runs before INPUT chain), so without this, container ports are reachable from the internet even if UFW blocks them. |
| `default-network-opts` | Bind published ports on **user-defined bridge networks** to localhost only. `ip` only affects the default bridge; this covers networks like `openclaw-gateway-net`. Both settings together ensure all container ports bind to localhost. |
| `json-file` with rotation | Standard logging with 50MB/5 files rotation |
| `overlay2` | Recommended storage driver |
| `live-restore: true` | Containers survive daemon restarts |
| `userland-proxy: false` | Use iptables for port mapping (better performance + security) |
| `no-new-privileges: true` | Prevent container privilege escalation |
| `nofile: 65536` | Increase file descriptor limits for stability |

### 2.9 Cloudflare Tunnel

**Purpose:** Zero exposed ports, origin IP hidden, built-in DDoS protection.

**Package:** `cloudflared` (installed from GitHub releases .deb)

**Architecture:**

- `cloudflared` makes outbound connections to Cloudflare edge
- No inbound ports needed (port 443 stays closed)
- DNS routes traffic: domain -> Cloudflare -> tunnel -> local service

**VPS-1 tunnel:** Named `openclaw`

- Routes `OPENCLAW_DOMAIN` -> `http://localhost:18789` (gateway)
- `originRequest.noTLSVerify: true` (local HTTP, TLS at Cloudflare edge)

**Management:** Token-based (remotely managed via Cloudflare Dashboard). No `config.yml`, `credentials.json`, or `cert.pem` on the VPS — all routing configuration lives in the Dashboard.

**Installation:** `sudo cloudflared service install <CF_TUNNEL_TOKEN>`
**Service:** `cloudflared` (systemd, enabled)

**DNS routing:** Configured in Cloudflare Dashboard (public hostname settings), not via local CLI commands.

**Security:** Port 443 must remain closed (`sudo ufw delete allow 443/tcp` if it was ever opened)

---

## 3. VPS-1 Requirements (OpenClaw Gateway)

### 3.1 Sysbox Runtime

**Package:** `sysbox-ce` (v0.6.4+)
**Purpose:** User namespace isolation for Docker-in-Docker. Maps uid 0 inside container to an unprivileged uid on the host.

**Key behaviors:**

- Auto-provisions writable mounts at `/var/lib/sysbox/docker/<container-id>/` for `/var/lib/docker` and `/var/lib/containerd`
- These auto-mounts inherit the container's `read_only` flag (important — see 3.4)
- Provides equivalent security to `read_only: true` via user namespace isolation

**Verification:** `sudo docker info | grep -i sysbox`

### 3.2 Docker Networks

| Network | Subnet | Driver | Flags | Purpose |
|---------|--------|--------|-------|---------|
| `openclaw-gateway-net` | `172.30.0.0/24` | bridge | external: true | Gateway, cloudflared, Vector |
| `openclaw-sandbox-net` | `172.31.0.0/24` | bridge | internal: true | Agent sandboxes (no outbound internet) |

**Design decision:** Subnets use `172.30.x.x` and `172.31.x.x` to avoid conflicts with Docker's default `172.17.0.0/16` range.

**Critical:** The gateway network's `.1` IP (`172.30.0.1`) is used for `trustedProxies` in the Cloudflare Tunnel setup. cloudflared connects via the Docker bridge and appears as `172.30.0.1` to the gateway.

### 3.3 Directory Structure & Permissions

```
/home/openclaw/
├── openclaw/                    # Cloned repo (github.com/openclaw/openclaw)
│   ├── docker-compose.yml       # Original from upstream
│   ├── docker-compose.override.yml  # Our customizations
│   ├── .env                     # Environment variables
│   ├── vector.yaml              # Vector log shipper configuration
│   ├── data/
│   │   └── vector/              # Vector checkpoint/position data
│   └── scripts/
│       └── entrypoint-gateway.sh  # Custom entrypoint
├── .openclaw/                   # Gateway config & state (owned by uid 1000)
│   ├── openclaw.json            # Gateway configuration (chmod 600)
│   ├── workspace/               # Agent workspaces
│   ├── credentials/             # Stored credentials
│   ├── logs/
│   └── backups/
├── .claude-sandbox/             # Sandbox Claude Code credentials (isolated from gateway)
└── build/
    ├── build-openclaw.sh        # Build script with auto-patching
    └── host-alert.sh            # Cron alerter: disk/memory/CPU -> Telegram
```

**Ownership:**

- `/home/openclaw` and subdirs: `openclaw:openclaw`
- `.openclaw/` contents: `uid 1000:1000` (container's `node` user, which is host `ubuntu` uid 1000)
- **Known deviation:** `ubuntu` user (uid 1000) still exists alongside `openclaw` (uid 1002). Container files in `.openclaw` are owned by uid 1000 (ubuntu), not openclaw. This is correct for container compatibility.

### 3.4 Gateway Container (docker-compose.override.yml)

**Image:** `openclaw:local` (built by `scripts/build-openclaw.sh`)
**Container name:** `openclaw-gateway`
**Runtime:** `sysbox-runc`

| Setting | Value | Rationale |
|---------|-------|-----------|
| `user` | `"0:0"` | Root inside container — Sysbox maps to unprivileged uid on host. Required for starting `dockerd` |
| `read_only` | `false` | **Required.** Sysbox auto-mounts for `/var/lib/docker` inherit this flag. With `true`, dockerd gets `chmod /var/lib/docker: read-only file system` |
| `no-new-privileges` | `true` | Prevent escalation. gosu drops privileges (doesn't gain) |
| `start_period` | `300s` | First boot builds 4 sandbox images (3-5 minutes) |
| `cpus` | `4` (limit), `1` (reservation) | Resource bounds |
| `memory` | `8G` (limit), `2G` (reservation) | Resource bounds |

See `04-vps1-openclaw.md` § 4.6 for the full `docker-compose.override.yml`.

`--bind lan` is required for Docker deployments. `loopback` doesn't work because Docker port-forwards traffic through the bridge network — connections from cloudflared arrive from `172.30.0.1` on `eth0`, not loopback. `openclaw doctor` warns about this; actual security is enforced by daemon.json localhost binding (§ 2.8).

All LLM provider API keys are set to `AI_GATEWAY_AUTH_TOKEN` and base URLs to `AI_GATEWAY_WORKER_URL`, routing everything through the AI Gateway Worker. Unsupported providers fail at the Worker (404), preventing leakage to default endpoints.

### 3.5 Entrypoint Script (`scripts/entrypoint-gateway.sh`)

Runs as root inside container (Sysbox isolation). Performs pre-start tasks in order:

1. **Lock file cleanup** — Removes stale `gateway.*.lock` files from unclean shutdowns
2. **Config permissions** — Enforces `chmod 600` on `openclaw.json` (gateway may rewrite with looser perms)
3. **Sandbox credentials ownership** — `chown -R 1000:1000 /home/node/.claude-sandbox` (Sysbox uid remapping: host uid 1000 appears as uid 1002 inside container)
4. **Config/state dir ownership** — `chown -R 1000:1000 /home/node/.openclaw` if any files are not owned by node (fixes identity/, memory/ dirs created by root before gosu drops privileges)
5. **Start nested Docker daemon** — `dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --log-level=warn`, waits up to 30 seconds for `docker info` to succeed
6. **Build sandbox images** (only if dockerd is ready):
   - `openclaw-sandbox` — Base sandbox (from `/app/sandbox/Dockerfile`)
   - `openclaw-sandbox-common:bookworm-slim` — Node.js, git, dev tools
   - `openclaw-sandbox-browser:bookworm-slim` — Chromium + noVNC
   - `openclaw-sandbox-claude:bookworm-slim` — Common + ffmpeg + imagemagick + Claude Code CLI (layered image)
7. **Privilege drop** — `exec gosu node "$@"` drops from root to node (uid 1000). `gosu` doesn't spawn a subshell (preserves PID 1 signal handling). Full gateway command passed as arguments from compose override.

### 3.6 Build Process (`scripts/build-openclaw.sh`)

**Usage:** `sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh`

Patches upstream Dockerfile in-place before `docker build`, then `git checkout` restores the working tree. Each patch auto-skips when upstream fixes the issue (guard checks via `grep` run before patching).

**Patches applied:**

| # | Target | Issue | Fix |
|---|--------|-------|-----|
| 1 | Dockerfile | Docker + gosu needed for nested Docker (sandbox isolation) | `RUN apt-get install docker.io gosu && usermod -aG docker node` before `USER node` |

**Critical constraint:** The patch MUST be inserted before `USER node` in the Dockerfile. After `USER node`, apt can't write to system directories (EACCES).

**Cleanup step:**

```bash
git checkout -- Dockerfile 2>/dev/null || true
```

**Gotcha:** If build fails, `git checkout` (cleanup step) doesn't run. Next build sees old patches and may skip. Fix: manually `git checkout -- Dockerfile` before retrying.

### 3.7 openclaw.json Configuration

**Location:** `/home/openclaw/.openclaw/openclaw.json`
**Permissions:** `chmod 600` (enforced by entrypoint every startup)
**Ownership:** `1000:1000`

**Important:** OpenClaw rejects unknown keys. Only use documented configuration keys.

See `04-vps1-openclaw.md` § 4.8 for the full `openclaw.json` content.

**Key design decisions:**

| Setting | Rationale |
|---------|-----------|
| `commands.restart: true` | Agents can modify config and trigger in-process restart via SIGUSR1 |
| `bind: "lan"` | Required for Docker deployments. cloudflared (systemd on host) connects via Docker bridge — traffic arrives from `172.30.0.1` on `eth0`, not loopback. `loopback` would make the gateway unreachable via the tunnel. `openclaw doctor` warns about this; the warning is expected. Actual security is enforced by daemon.json localhost binding (section 3.1). |
| `trustedProxies: ["172.30.0.1"]` | cloudflared connects via Docker bridge gateway IP. Only exact IPs work — CIDR ranges NOT supported by `isTrustedProxyAddress()` |
| `controlUi.basePath` | URL prefix for Control UI, set from `OPENCLAW_DOMAIN_PATH` in config |
| `sandbox.mode: "all"` | All agents run in Docker sandboxes. Requires Docker installed inside container (build patch #2). Without Docker, `spawn docker` crashes with EACCES. Fallback: `"non-main"` |
| `sandbox.docker.network: "bridge"` | Required for browser tool. `"none"` breaks CDP connectivity (gateway can't reach port 9222 in sandbox) |
| `tmpfs /home/linuxbrew:uid=1000,gid=1000` | Makes sandbox home writable for `~/.claude.json`. The `:uid=1000,gid=1000` is critical — without it, tmpfs mounts as root-owned and linuxbrew user can't write |
| `readOnlyRoot: true` | Sandbox filesystem is read-only for security. Home dir writable via tmpfs overlay |
| `prune.idleHours: 168` (7 days) | Longer prune avoids repeatedly rebuilding sandbox state |
| `capDrop: ["ALL"]` | Drop all Linux capabilities in sandboxes — minimal privilege |
| `binds` on sandbox | Mounts gateway's `.claude-sandbox` credentials into sandbox home |

### 3.8 Sandbox Images

Four images built during first boot by the entrypoint script:

| Image | Base | Contents | Size |
|-------|------|----------|------|
| `openclaw-sandbox` | Upstream Dockerfile | Minimal sandbox (base) | ~150MB |
| `openclaw-sandbox-common:bookworm-slim` | Custom script | Node.js, git, dev tools | ~500MB |
| `openclaw-sandbox-browser:bookworm-slim` | Custom script | Chromium + noVNC | ~800MB |
| `openclaw-sandbox-claude:bookworm-slim` | Layered on common | Common + ffmpeg + imagemagick + Claude Code CLI | ~700MB |

**Claude sandbox build command:**

```bash
printf 'FROM openclaw-sandbox-common:bookworm-slim\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends ffmpeg imagemagick && rm -rf /var/lib/apt/lists/*\nRUN npm install -g @anthropic-ai/claude-code\nUSER 1000\n' | docker build -t openclaw-sandbox-claude:bookworm-slim -
```

**Critical constraints:**

- Do NOT use `docker build -f - /dev/null` — nested Docker (Sysbox) rejects `/dev/null` as build context. Use `printf ... | docker build -t tag -` instead.
- Do NOT use `docker run`/`docker commit` to mutate images — creates a dirty layer. Use `docker build` with proper FROM layer.

### 3.9 Claude Code in Sandboxes

**Credential isolation:** Sandboxes use `/home/openclaw/.claude-sandbox` (NOT gateway's `/home/openclaw/.claude`). Gateway credentials are device-bound OAuth tokens that don't work across containers. Sandbox gets its own credentials via `claude login` (one-time setup).

**Bind chain:**

1. Host: `/home/openclaw/.claude-sandbox`
2. -> Gateway container: `/home/node/.claude-sandbox` (via compose volume mount)
3. -> Sandbox container: `/home/linuxbrew/.claude` (via openclaw.json `binds`)

**Sandbox user:** `linuxbrew` (uid 1000), home at `/home/linuxbrew`

**Sysbox uid remapping fix:** Host uid 1000 appears as uid 1002 inside gateway. Entrypoint runs `chown -R 1000:1000 /home/node/.claude-sandbox` to fix this before gosu drops privileges.

### 3.10 Vector (Log Shipping)

**Image:** `timberio/vector:0.43.1-alpine`
**Container name:** `vector`
**Network:** `openclaw-gateway-net`

**Config file:** `/home/openclaw/openclaw/vector.yaml` (bind mounted to `/etc/vector/vector.yaml:ro`). YAML format matches the Vector Alpine image default, avoiding a `command` override.

**Purpose:** Ships Docker container logs to the Cloudflare Log Receiver Worker.

See `04-vps1-openclaw.md` § 4.6 (compose) and § 4.7 (vector.yaml) for the full configs.

**Fields per event** (auto-included by `docker_logs` source):

- `container_name`, `container_id`, `image`
- `message` (the log line)
- `stream` (stdout/stderr)
- `timestamp`
- `host`

**Checkpoint persistence:** `./data/vector/` stores checkpoint/position data. Survives container restarts, catches up from last position.

**Crash recovery:**

- Container crashes -> Docker captures stdout/stderr in JSON log files -> Vector catches up from checkpoint
- Vector crashes -> `restart: always` brings it back -> reads from last checkpoint
- VPS reboots -> compose `restart: always` -> Vector catches up from persisted checkpoints

**Environment variables required in `.env`:**

| Variable | Purpose |
|----------|---------|
| `LOG_WORKER_URL` | Full URL to Log Receiver Worker (e.g., `https://log-receiver.<account>.workers.dev/logs`) |
| `LOG_WORKER_TOKEN` | Bearer token matching the Worker's `AUTH_TOKEN` secret |

### 3.11 Host Alerter

**Script:** `/home/openclaw/scripts/host-alert.sh`
**Cron file:** `/etc/cron.d/openclaw-alerts`
**Cron entry:** `*/15 * * * * root /home/openclaw/scripts/host-alert.sh`
**Runs as:** root (needs access to system metrics)

**Checks:**

- Disk usage > 85%
- Memory usage > 90%
- Docker daemon health
- Container crash count

**Alert delivery:** Sends messages via Telegram Bot API:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "text=VPS Alert: Disk usage at 92%"
```

**State-based alerting:** Only alerts on state *change* (tracks last alert state in a file to avoid spam). Does not re-alert every 15 minutes for the same condition.

**Required configuration:**

- `TELEGRAM_BOT_TOKEN` — In `openclaw-config.env`
- `TELEGRAM_CHAT_ID` — In `openclaw-config.env` (the chat/group ID to send alerts to)

### 3.12 Backup

**Script:** `/home/openclaw/scripts/backup.sh`
**Runs as:** root (via `/etc/cron.d/openclaw-backup`)

**Rationale for root:** `.openclaw` files are owned by uid 1000 (`ubuntu`), but the `openclaw` user is uid 1002. Root is the only user that can read all files reliably.

**Schedule:** `0 3 * * *` (daily at 3 AM)

**Files backed up:**

- `.openclaw/openclaw.json` — Gateway config
- `.openclaw/credentials/` — API keys, tokens
- `.openclaw/workspace/` — User workspaces
- `openclaw/.env` — Environment variables

**Retention:** 30 days (auto-delete older backups)
**Output:** `/home/openclaw/.openclaw/backups/openclaw_backup_YYYYMMDD_HHMMSS.tar.gz`
**Ownership:** Files owned by `1000:1000` (container-compatible)

**Cron job location:** `/etc/cron.d/openclaw-backup` (NOT user crontab — user crontab runs as openclaw uid 1002, which can't read uid 1000 files)

### 3.13 Device Pairing & Authentication

**Flow:**

1. User opens `https://<DOMAIN>/<SUBPATH>/chat?token=<TOKEN>`
2. Token auth succeeds -> gateway checks device pairing
3. If unpaired -> WebSocket closed with code `1008: pairing required`
4. Admin approves via CLI:

   ```bash
   sudo docker exec --user node openclaw-gateway node dist/index.js devices list
   sudo docker exec --user node openclaw-gateway node dist/index.js devices approve <requestId>
   ```

5. Browser auto-retries -> connects successfully

**Important:**

- Pending requests have 5-minute TTL. Browser retries create new requests.
- Once one device is paired, subsequent devices can be approved from the Control UI.
- Stored in `~/.openclaw/devices/pending.json`
- Do NOT use `dangerouslyDisableDeviceAuth` — device pairing is defense-in-depth security.

### 3.14 Gateway .env File

**Location:** `/home/openclaw/openclaw/.env`

See `04-vps1-openclaw.md` § 4.5 for the full variable list and creation script.

**Critical gotchas:**

- `OPENCLAW_GATEWAY_PORT` must be port number only (`18789`), NOT IP:port format (`127.0.0.1:18789`). The CLI misparses IP:port and extracts `127` as the port. Localhost binding is handled by daemon.json.
- `.env` values with spaces MUST be quoted (e.g., `VAR="a b c"`). Unquoted values cause bash `source .env` to break.

---

## 4. Cloudflare Workers

### 4.1 AI Gateway Worker (`workers/ai-gateway/`)

Proxies LLM requests through Cloudflare AI Gateway for analytics, rate limiting, and caching. The real API keys live only on the Worker (Cloudflare), not on the VPS.

**Routes:**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/v1/chat/completions` | Bearer token | OpenAI-compatible completions |
| `POST` | `/v1/messages` | Bearer token | Anthropic messages API |
| `GET` | `/health` | None | Health check |

**Auth:** Bearer token (`AUTH_TOKEN` secret) — clients must include `Authorization: Bearer <token>` header.

**Secrets (set via `wrangler secret put`):**

| Secret | Purpose |
|--------|---------|
| `AUTH_TOKEN` | Token clients use to authenticate to this worker |
| `OPENAI_API_KEY` | Forwarded to OpenAI via AI Gateway |
| `ANTHROPIC_API_KEY` | Forwarded to Anthropic via AI Gateway |
| `CF_AI_GATEWAY_TOKEN` | Authenticates requests to Cloudflare AI Gateway |
| `ACCOUNT_ID` | Cloudflare account ID |

**Vars (in `wrangler.jsonc`):**

| Var | Purpose |
|-----|---------|
| `CF_AI_GATEWAY_ID` | Cloudflare AI Gateway ID (e.g., `ai-gateway`) |

### 4.2 Log Receiver Worker (`workers/log-receiver/`)

Receives batched log events from Vector running on VPS-1. Each event is `console.log()`'d so Cloudflare captures it via real-time Logs dashboard and Logpush.

**Routes:**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/logs` | Bearer token | Receive log events from Vector |
| `GET` | `/health` | None | Health check |

**Auth:** Bearer token (`AUTH_TOKEN` secret).

**Request format:** Newline-delimited JSON (Vector's HTTP sink with `encoding.codec = "json"`). Each line is one log event:

```json
{"container_name":"openclaw-gateway","message":"Gateway started","stream":"stdout","timestamp":"2026-02-07T10:30:00Z","host":"openclaw","image":"openclaw:local"}
```

**Handler logic:**

1. Validate auth (Bearer token)
2. Read request body as text
3. Split by newlines, parse each JSON line
4. For each entry: `console.log(JSON.stringify(entry))` — Cloudflare captures this
5. Return `{"status":"ok","count":N}`

**Secrets (set via `wrangler secret put`):**

| Secret | Purpose |
|--------|---------|
| `AUTH_TOKEN` | Token Vector uses to authenticate to this worker |

### 4.3 Worker Deployment Pattern

Both workers follow the same deployment pattern:

```bash
cd workers/<worker-name>
npm install
wrangler secret put AUTH_TOKEN        # Set the auth token secret
# Set any additional secrets specific to the worker
npm run deploy
```

**Verification:**

```bash
curl https://<worker-name>.<account>.workers.dev/health
# Returns: {"status":"ok"}
```

---

## 5. Key Ports & IPs Reference

### VPS-1

| Port | Binding | Service | Access |
|------|---------|---------|--------|
| 222/tcp | 0.0.0.0 | SSH | Public (key-only, adminclaw) |
| 18789/tcp | 127.0.0.1 | Gateway | Via Cloudflare Tunnel (cloudflared on host) |
| 18790/tcp | 127.0.0.1 | Bridge API | Local only |

### Docker Networks (VPS-1)

| Network | Subnet | Type | Purpose |
|---------|--------|------|---------|
| `openclaw-gateway-net` | `172.30.0.0/24` | bridge, external | Gateway + supporting services |
| `openclaw-sandbox-net` | `172.31.0.0/24` | bridge, internal | Agent sandboxes (no internet) |

---

## 6. Known Issues & Critical Gotchas

### Security & Access

- **UsePAM must be `yes` on Ubuntu** — `no` breaks SSH authentication entirely
- **SSH port change requires both** `sshd_config` AND systemd socket override (Ubuntu socket activation)
- **UFW before SSH port change** — configure UFW rules BEFORE changing SSH port to prevent lockout
- **adminclaw can't cd into `/home/openclaw/`** — 750 perms. Use `sudo -u openclaw bash -c "cd ... && ..."`
- **Docker bypasses UFW** — iptables DOCKER chain runs before INPUT. Fix requires **two** daemon.json settings: `"ip": "127.0.0.1"` (default bridge) + `"default-network-opts"` with `host_binding_ipv4` (user-defined bridges). Port binding changes require full container + network recreation (`docker compose down`, `docker network rm`, recreate, `up -d`).

### Container & Build

- **`read_only: false` + `user: "0:0"` required** — Sysbox auto-mounts inherit `read_only`; entrypoint drops to node via gosu
- **Container name is `openclaw-gateway`** (explicit `container_name`)
- **Patches must go before `USER node`** — apt/npm can't write to system dirs after user change. Failed builds leave patches in place — manually `git checkout -- Dockerfile` before retry.
- **`OPENCLAW_GATEWAY_PORT` must be port only** — `127.0.0.1:18789` causes CLI to misparse `127` as port
- **Only 1 patch remains** — Docker+gosu. Agent tools are in the claude sandbox image, not the gateway.

### UID & Ownership

- Host `ubuntu` = uid 1000, host `openclaw` = uid 1002, container `node` = uid 1000
- `.openclaw` files owned by uid 1000 (matches `ubuntu`, not `openclaw`). Backups must run as root.
- Sysbox remaps host uid 1000 to uid 1002 inside container — entrypoint `chown` fixes this

### Sandbox

- **Do NOT use `docker build -f - /dev/null`** in Sysbox — use `printf ... | docker build -t tag -`
- **Do NOT use `docker run`/`docker commit`** — creates dirty layers. Use `docker build` with FROM.
- **Entrypoint heredocs via SSH** mangle shebangs — use `scp` instead

### Vector (Log Shipping)

- **`LOG_WORKER_URL` must include `/logs` path** — Vector sends to this URL directly
- **Batch timeout is 60 seconds** — normal batching delay, not a bug
- If `./data/vector/` is deleted, Vector re-ships all logs from the beginning (safe but bursty)
