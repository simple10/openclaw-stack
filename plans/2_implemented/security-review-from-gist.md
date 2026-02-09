# Security Guide Comparison: What's Worth Implementing

## Context

Reviewed the [Securing OpenClaw Guide](https://gist.githubusercontent.com/simple10/7a91c7471fb543bf0a75341cb2367622/raw/d379d395c224ac7f9940728afaf9092ce8a423a6/securing-openclaw-guide.md) — a comprehensive production deployment guide for OpenClaw on Hetzner VPS. The guide targets a Hetzner+SSH tunnel+Tailscale architecture while our deployment uses OVHCloud+Cloudflare Tunnel+Sysbox. Many recommendations overlap but the infrastructure differences matter.

---

## Already Covered (our setup matches or exceeds the guide)

These are things the guide recommends that we already have. No action needed.

| Area | Guide Recommends | Our Implementation |
|------|-----------------|-------------------|
| SSH hardening | Non-standard port, key-only, cipher restrictions | Port 222, ed25519+RSA, ChaCha20/AES-256 only, AllowUsers |
| Firewall | Default deny, minimal rules | UFW default deny, SSH only |
| Fail2ban | Rate limiting on SSH | 3 max retries, 24hr ban |
| Auto updates | unattended-upgrades | Configured with auto-fix |
| Kernel hardening | sysctl settings | ASLR, SYN cookies, rp_filter, dmesg restrict, kptr restrict |
| Docker localhost binding | Loopback-only port binding | `ip` + `default-network-opts` (covers both default and user bridges) |
| no-new-privileges | Prevent escalation | Both daemon.json and compose-level |
| Log rotation | json-file with rotation | 50m max, 5 files |
| Non-root container | Run as non-root user | gosu drops to node (uid 1000) |
| Resource limits | mem_limit, pids_limit | 4 CPU / 8GB gateway, 0.25 CPU / 128MB Vector |
| Health checks | Container health monitoring | 30s interval, 3 retries, 300s startup |
| Host monitoring | Disk/memory/CPU/container alerts | host-alert.sh every 15min via cron |
| Daily backups | Automated with retention | 3am daily, 30-day retention |
| GPG-verified repos | Signed Docker repo | GPG key verification on Docker apt repo |
| Two-user separation | Admin vs runtime users | adminclaw (sudo) + openclaw (no sudo, no SSH) |

**We exceed the guide in these areas:**

- **Sysbox** — user namespace remapping, /proc+/sys virtualization (guide uses basic Docker)
- **Cloudflare Tunnel** — zero inbound ports exposed (guide uses SSH tunnels + Tailscale, which still requires listening ports)
- **Sandbox isolation** — capDrop ALL, read-only root, per-agent isolation, separate credential chains
- **AI Gateway Worker** — API key isolation + LLM analytics (guide doesn't cover this)
- **Vector log shipping** — centralized log aggregation to Cloudflare Workers

---

## Worth Implementing

### 1. Backup age check in host-alerter

**Why:** The guide documents a real-world failure where backups appeared to run but silently failed due to PATH issues in scheduled jobs. Our current alerter checks disk/memory/CPU/container but does NOT check if backups are actually running.

**Change:** Add a check to `host-alert.sh` (in playbook `04-vps1-openclaw.md` section 4.8d) that warns if no backup file exists within the last 36 hours.

**File:** `playbooks/04-vps1-openclaw.md` (section 4.8d, host-alert.sh script)

```bash
# Check backup freshness (warn if no backup in last 36 hours)
BACKUP_DIR="/home/openclaw/.openclaw/backups"
if [ -d "$BACKUP_DIR" ]; then
  LATEST_BACKUP=$(find "$BACKUP_DIR" -name "openclaw_backup_*.tar.gz" -mmin -2160 | head -1)
  if [ -z "$LATEST_BACKUP" ]; then
    ALERTS="${ALERTS}⚠️ No backup in last 36 hours!\n"
  fi
fi
```

### 2. pids_limit on gateway container

**Why:** Sandboxes already have `pidsLimit: 256` via openclaw.json, but the gateway container itself has no process limit. A fork bomb in the gateway could exhaust host PIDs.

**Change:** Add `pids_limit: 512` to the gateway service in docker-compose.override.yml. Using 512 (not 256) because the gateway runs nested Docker with sandbox containers inside.

**File:** `playbooks/04-vps1-openclaw.md` (section 4.6, docker-compose.override.yml)

```yaml
services:
  openclaw-gateway:
    # ... existing config ...
    pids_limit: 512
```

### 3. Update procedure formalization

**Why:** The guide recommends tagging known-good state before updating and keeping the last 3 Docker images for rollback. Our current update procedure in section 4.9 is a bare `git pull` + rebuild with no rollback path.

**Change:** Enhance the "Updating OpenClaw" section in playbook 04 to:

- Tag the current commit before pulling
- Tag the current Docker image before rebuilding
- Document rollback procedure
- Keep last 3 tagged images

**File:** `playbooks/04-vps1-openclaw.md` (the "Updating OpenClaw" section at the end)

```bash
#!/bin/bash
# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git tag -f pre-update'
docker tag openclaw:local openclaw:rollback-$(date +%Y%m%d) 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git pull origin main'
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 4. Restart and verify
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
sudo docker exec --user node openclaw-gateway node dist/index.js --version
curl -s http://localhost:18789/health

# 5. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-' | sort -r | tail -n +4 | xargs -r docker rmi
```

### 4. SHA256 verification for Sysbox download

**Why:** We download Sysbox as a `.deb` via `wget` without verifying integrity. A compromised download could inject a backdoor into the container runtime.

**Change:** Add sha256sum verification after download in playbook 04 section 4.1.

**File:** `playbooks/04-vps1-openclaw.md` (section 4.1)

```bash
# After wget, before dpkg -i:
echo "<SHA256_HASH>  sysbox-ce_0.6.4-0.linux_amd64.deb" | sha256sum -c -
```

### 5. Token rotation documentation

**Why:** We have no documented rotation schedule. The guide recommends quarterly rotation of provider API keys. If a key leaks, having a documented rotation process accelerates response.

**Change:** Add a "Token Rotation" section to the CLAUDE.md or a new `playbooks/maintenance.md` documenting what tokens exist, where they're stored, and rotation cadence.

**File:** New section in an appropriate location (CLAUDE.md or a maintenance playbook)

Tokens to track:

| Token | Location | Rotation Cadence |
|-------|----------|-----------------|
| `OPENCLAW_GATEWAY_TOKEN` | VPS `.env` | 90 days |
| `AI_GATEWAY_AUTH_TOKEN` | VPS `.env` + Worker secret | 90 days |
| `LOG_WORKER_TOKEN` | VPS `.env` + Worker secret | 90 days |
| Provider API keys (Anthropic, OpenAI, etc.) | AI Gateway Worker secrets | Per provider policy |
| `TELEGRAM_BOT_TOKEN` | VPS `.env` | As needed |
| SSH keys | `~/.ssh/` | Annual |

---

## Not Worth Implementing (for our architecture)

| Guide Recommendation | Why It's Unnecessary For Us |
|---------------------|---------------------------|
| **Tailscale / SSH tunneling** | Cloudflare Tunnel is equivalent or better — zero inbound ports, DDoS protection, WAF |
| **Caddy TLS reverse proxy** | Cloudflare terminates TLS at the edge |
| **Full supply chain lockdown** (lockfile enforcement, pinned versions for everything) | Over-engineering for a single-VPS deployment; our Docker GPG verification covers the main risk |
| **Disk encryption** | VPS provider infrastructure concern; runtime decryption creates circular dependency |
| **GPG signature verification on OpenClaw upstream commits** | Bounded by reviewing `git log` diffs before updating (covered by the update procedure enhancement) |
| **Container image signing** | We build and consume images on the same VPS — no transit risk |
| **systemd timers instead of cron** | Our cron jobs work fine; switching adds no security value |
| **Backup encryption at rest** | Local-only backups on an encrypted VPS disk; if adding off-site backup, encrypt then |
| **Accepted risks formal documentation** | Nice operationally but low priority for a single-person deployment |

---

## Implementation Order

1. **Backup age check** — 5 min, high value (catches silent backup failures)
2. **pids_limit on gateway** — 1 line, prevents fork bombs
3. **Update procedure** — Documentation change, enables safe rollbacks
4. **SHA256 for Sysbox** — 1 line, supply chain hygiene
5. **Token rotation docs** — Operational documentation, no code change

---

## Verification

After implementing changes:

1. **Backup age check:** Stop the backup cron, wait, run `host-alert.sh` manually — should produce a warning
2. **pids_limit:** `docker inspect openclaw-gateway | grep -i pids` should show limit
3. **Update procedure:** Walk through a dry-run update using the new steps
4. **SHA256 verification:** Re-download Sysbox and verify the hash matches
5. **Token rotation:** Review documentation for completeness
