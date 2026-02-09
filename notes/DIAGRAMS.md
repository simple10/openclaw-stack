## Architecture

```
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
│  Containers (gateway-net 172.30.0.0/24)   │             │              │
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
