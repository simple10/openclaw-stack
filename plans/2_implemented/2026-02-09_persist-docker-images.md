# Plan: Persist nested Docker images across gateway container restarts

## Context

The gateway container runs with Sysbox and builds 4 sandbox images on every startup (~5 minutes). Currently, Sysbox auto-provisions an ephemeral `/var/lib/docker` mount that is destroyed when the container stops, forcing a full rebuild on every restart. Sysbox officially supports bind-mounting a host directory to `/var/lib/docker` for persistence.

## Solution

Add a bind mount from `./data/docker/` (host) to `/var/lib/docker` (container) in the compose override. The entrypoint already skips builds when images exist, so no entrypoint changes are needed.

**Requirements:**

- Host directory must be on ext4 or btrfs (standard for Ubuntu VPS)
- Only one container can use this mount at a time (already the case — single gateway)
- Sysbox handles uid remapping automatically via ID-mapped mounts (kernel 5.12+)

## Changes

### 1. `playbooks/04-vps1-openclaw.md` — Section 4.6 (Docker Compose Override)

Add bind mount to the `openclaw-gateway` service volumes:

```yaml
volumes:
  - ./scripts/entrypoint-gateway.sh:/app/scripts/entrypoint-gateway.sh:ro
  - /home/openclaw/.claude-sandbox:/home/node/.claude-sandbox
  - ./data/docker:/var/lib/docker    # Persist nested Docker images across restarts
```

### 2. `playbooks/04-vps1-openclaw.md` — Section 4.3 (Directory Structure)

Add directory creation:

```bash
mkdir -p "${OPENCLAW_HOME}/openclaw/data/docker"
```

### 3. `REQUIREMENTS.md` — Section 3.4 (Gateway Container)

Add a note explaining the `/var/lib/docker` bind mount rationale: Sysbox auto-provisions ephemeral storage by default, but bind-mounting persists sandbox images across restarts (saves ~5 min rebuild on every restart).

### 4. `playbooks/04-vps1-openclaw.md` — Section 4.8c (Entrypoint comment)

Update the comment at the top of the dockerd startup section to note that `/var/lib/docker` is now a persistent bind mount (not Sysbox ephemeral storage), so images survive restarts. Add a TODO comment about future enhancement: verify sandbox image checksums on startup and rebuild if tampered, to mitigate poisoned-image persistence risk.

## Files modified

- `playbooks/04-vps1-openclaw.md` (sections 4.3, 4.6, 4.8c)
- `REQUIREMENTS.md` (section 3.4)

## Verification

1. SSH to VPS, stop gateway: `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose down'`
2. Verify `data/docker/` has content: `ls /home/openclaw/openclaw/data/docker/`
3. Start gateway: `sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'`
4. Watch logs — images should already exist (no rebuild): `sudo docker logs -f openclaw-gateway 2>&1 | grep entrypoint`
5. Expected: all 4 "already exists" messages, gateway starts in seconds instead of minutes
