# Architecture

```text
  User                                                   LLM Providers
  │ HTTPS                                            (OpenAI, Anthropic)
  ▼                                                          ▲
┌──────────────────────── Cloudflare ────────────────────────┼───────────┐
│                                                            │           │
│  Access ──► Tunnel                 AI Gateway Worker ──────┘           │
│  (auth)     (encrypted)            (LLM proxy + analytics)             │
│                │                          ▲                            │
│                │                          │      Log Receiver Worker   │
│                │                          │      (log capture)         │
│                │                          │             ▲              │
└────────────────┼──────────────────────────┼─────────────┼──────────────┘
     INGRESS     │                          │             │     EGRESS
┌────────────────┼───────── VPS-1 ──────────┼─────────────┼──────────────┐
│                ▼                          │             │              │
│  Host                                     │             │              │
│  ├ cloudflared (tunnel endpoint)          │             │              │
│  │   └► localhost:18789                   │             │              │
│  ├ sshd :222 (key-only)                   │             │              │
│  ├ sysbox-runc                            │             │              │
│  ├ UFW · fail2ban · unattended-upgrades   │             │              │
│  ├ cron: host-alert.sh (15m) ─────────────┼─────────────┼──► Telegram  │
│  └ cron: backup.sh (daily 3am)            │             │              │
│                                           │             │              │
│  Containers (openclaw-net 10.200.0.0/24)   │             │              │
│  ┌────────────────────────────────────────┼─────────────┼────────────┐ │
│  │                                        │             │            │ │
│  │  openclaw-gateway (Sysbox runtime)     │             │            │ │
│  │  ├ 127.0.0.1:18789 · :18790 ───────────┘             │            │ │
│  │  └ Nested Docker (sandbox-net, no internet)          │            │ │
│  │    ├ sandbox-claude · sandbox-browser                │            │ │
│  │    └ sandbox (base)                                  │            │ │
│  │                                                      │            │ │
│  │  vector (log shipper)                                │            │ │
│  │  └ docker_logs ──► HTTP sink ────────────────────────┘            │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  Port 443: CLOSED · Port 80: CLOSED · Only :222 (SSH) open             │
└────────────────────────────────────────────────────────────────────────┘
```

---

```text
╔════════════════════════════════════  INGRESS  ════════════════════════════════════╗
║                                                                                   ║
║  User ── HTTPS ──► Cloudflare Access (auth) ──► Cloudflare Tunnel (encrypted)     ║
║  Cloudflare Access manages authentication layer · routes to VPS via tunnel        ║
║                                                                                   ║
╚════════════════════════════════════════════════════════════════════════╦══════════╝
                                                                         ║
                                                                         ║
  Port 443: CLOSED · Port 80: CLOSED · Only 222 open (sshd, key-only)    ▼
┌──────────────────────────────────── VPS-1 ────────────────────────────────────────┐
│                                                                                   │
│  Host (systemd)                                                                   │
│  ├ cloudflared (tunnel endpoint - establishes an outbound connection)             │
│  │   └► localhost:18789 (routes to openclaw-gateway container)                    │
│  ├ sysbox-runc                                                                    │
│  ├ UFW · fail2ban · unattended-upgrades                                           │
│  ├ cron: backup.sh (daily 3am)                                                    │
│  ├ cron: host-alert.sh (15m) ─────────────────────────────────────────────────────│──► Telegram
│  └ dockerd                                                                        │
│                                                                                   │
│  Host Docker Containers:                                                          │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │  openclaw-gateway (sysbox runtime · 4 CPU / 8G RAM / 512 PIDs)              │  │
│  │  - entrypoint: dockerd start → gosu drop to node                            │  │
│  │                                                                             │  │
│  │  openclaw gateway                                                           │  │
│  │  ├ :18789 (gateway · lan binding to cloudflared)                            │  │
│  │  ├ Channels: Telegram / Slack / etc. ───────────────────────────────────────│──│──► Telegram / Slack
│  │  ├ Models patch: ANTHROPIC_BASE_URL / OPENAI_BASE_URL ──────────────────┐   │  │
│  │  │                                                                      │   │  │
│  │  └ Nested Docker (openclaw agent sandboxes) ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐         │   │  │
│  │    │ sandbox-code (claude code, codex, etc. · net)            │         │   │  │
│  │    │ sandbox-browser (chromium · playwright · net)            │         │   │  │
│  │    │ sandbox-toolkit (build tools · net · write)              │         │   │  │
│  │    │ sandbox (base · no net · limited write)                  │         │   │  │
│  │    └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘         │   │  │
│  │                                                                         │   │  │
│  └─────────────────────────────────────────────────────────────────────────┼───┘  │
│                                                                            │      │
│  ┌───────────────────────────────────────────────────────────────┐         │      │
│  │  vector (log shipper · 0.25 CPU / 128M RAM)                   │         │      │
│  │  └ docker_logs via /var/run/docker.sock                       │         │      │
│  │  └ follows docker logs and batch ships to Log Receiver        │         │      │
│  └────┼──────────────────────────────────────────────────────────┘         │      │
│       │                                                                    │      │
│       │                                                                    │      │
└───────┼────────────────────────────────────────────────────────────────────┼──────┘
        │                                                                    │
        │ logs                                                    llm traffic│
        │                                                                    │
╔═══════╩══════════════════════════  EGRESS  ════════════════════════════════╩═══════╗
║       │                                                                    │       ║
║  ┌────┼───────────────────────────┐       ┌────────────────────────────────┼────┐  ║
║  │    │  Cloudflare               │       │  Cloudflare                    │    │  ║
║  │    ▼                           │       │                                ▼    │  ║
║  │  Log Receiver Worker           │       │  AI Gateway Worker ◄───────────┘    │  ║
║  │  (log capture)                 │       │  (proxy + analytics)                │  ║
║  │                                │       │         │                           │  ║
║  └────────────────────────────────┘       └─────────┼───────────────────────────┘  ║
║                                                     │                              ║
╚═════════════════════════════════════════════════════╤══════════════════════════════╝
                                                      │
                                                      ▼
                                               LLM Providers
                                           (OpenAI, Anthropic)
```
