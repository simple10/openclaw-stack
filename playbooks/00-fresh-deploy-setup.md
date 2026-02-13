# 00 - Fresh Deploy Setup

Minimal validation and overview for starting a fresh VPS deployment. Only `VPS1_IP` and `CF_TUNNEL_TOKEN` are required upfront — domain configuration is deferred to post-deploy.

## Overview

This playbook validates the minimum configuration needed to begin deploying OpenClaw on a fresh Ubuntu VPS. Domain-related settings (`OPENCLAW_DOMAIN`, `OPENCLAW_BROWSER_PUBLIC_URL`, `OPENCLAW_DOMAIN_PATH`) are only needed during post-deploy (step 8) when the user configures Cloudflare Tunnel public routes.

## Prerequisites

- A fresh Ubuntu VPS (>= 24.04) with root/sudo access
- An SSH key pair for VPS access
- A Cloudflare account with a domain and Cloudflare Access enabled

---

## 0.1 Config File Check

Check that `openclaw-config.env` exists:

```bash
ls openclaw-config.env
```

**If missing:** Offer to create it from the example:

```bash
cp openclaw-config.env.example openclaw-config.env
```

Then ask the user to fill in `VPS1_IP` and `CF_TUNNEL_TOKEN` (the two values needed to start).

---

## 0.2 Required for Start

Validate only these two fields:

1. **`VPS1_IP`** — Must be set and not a placeholder (not `15.x.x.1` or containing `<`).
2. **`CF_TUNNEL_TOKEN`** — Must not be empty. If empty, tell the user to follow [docs/CLOUDFLARE-TUNNEL.md](../docs/CLOUDFLARE-TUNNEL.md) to create a tunnel in the Cloudflare Dashboard, then paste the token into the chat or into `openclaw-config.env`.

Report any missing/invalid fields and wait for the user to provide values before continuing.

---

## 0.3 SSH Check

1. Validate `SSH_KEY_PATH` exists on the local system (default: `~/.ssh/vps1_openclaw_ed25519`).
2. Test SSH connectivity using **fresh VPS defaults** (`SSH_USER=ubuntu`, `SSH_PORT=22`):

```bash
ssh -i <SSH_KEY_PATH> -o ConnectTimeout=10 -o BatchMode=yes -p 22 ubuntu@<VPS1_IP> echo "VPS OK"
```

**If SSH fails:**

- If using a reused IP, suggest `ssh-keygen -R <VPS1_IP>` to clear stale host keys.
- Suggest `ssh-add <SSH_KEY_PATH>` if the key isn't loaded.
- Verify the key was added to the VPS during provisioning.

---

## 0.4 VPS Resource Check

After SSH is confirmed working, query the VPS hardware to verify gateway container resource limits match the host.

### Query VPS Resources

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> "nproc && free -b | awk '/^Mem:/{print \$2}'"
```

This returns two lines: CPU count (e.g., `6`) and total memory in bytes (e.g., `11811160064`).

### Compare Against Config

Read current gateway resource limits from `deploy/docker-compose.override.yml`:

- `deploy.resources.limits.cpus` (e.g., `"6"`)
- `deploy.resources.limits.memory` (e.g., `10.5G`)

### Expected Values

- **CPUs:** `limits.cpus` should equal the VPS CPU count from `nproc`
- **Memory:** `limits.memory` should be total VPS memory minus 500M–1GB
  - Vector uses ~128M, system/kernel needs ~500M
  - Formula: `total_memory - 750M` (midpoint) is a good default
  - Acceptable range: `total - 1G` to `total - 500M`

### Action

**If values match** (CPUs equal, memory within the 500M–1G buffer range): Report that resource limits look correct and continue.

**If mismatch detected:** Show the user a comparison:

```
VPS Resources:
  CPUs:   <nproc result>
  Memory: <total from free, human-readable>

Current gateway limits (docker-compose.override.yml):
  CPUs:   <current cpus value>
  Memory: <current memory value>

Recommended gateway limits:
  CPUs:   <nproc result>
  Memory: <total - 750M, rounded to nearest 0.5G>
```

Ask the user if they want to adjust the limits. They may choose:

- Accept the recommended values
- Enter custom values
- Keep the current values (skip)

If the user confirms changes, update `deploy/docker-compose.override.yml` with the new `limits.cpus` and `limits.memory` values. Also update `reservations.cpus` if it exceeds the new limit (reservation cannot exceed limit).

---

## 0.5 Worker Placeholder Detection

Scan `AI_GATEWAY_WORKER_URL` and `LOG_WORKER_URL` for angle-bracket placeholders (e.g., `<account>`).

**If placeholders found:** Note that workers will be deployed via `01-workers.md` before VPS setup begins. The user doesn't need to do anything now — this happens automatically as the first deployment step.

**If no placeholders:** Workers are already configured. Skip `01-workers.md` during deployment.

---

## 0.6 Deployment Overview

Present the full deployment plan to the user:

```
Deployment Plan:
  1. [If needed] Deploy Cloudflare Workers (01-workers.md)
  2. Base setup & hardening (02-base-setup.md)
  3. Docker installation (03-docker.md)
  4. OpenClaw deployment (04-vps1-openclaw.md)
  5. Backup configuration (06-backup.md)
  6. Reboot & verification (07-verification.md)
  7. Post-deploy: Configure Cloudflare Tunnel routes, domain setup,
     browser VNC access, device pairing (08-post-deploy.md)
```

**Note:** `OPENCLAW_DOMAIN`, `OPENCLAW_BROWSER_PUBLIC_URL`, and `OPENCLAW_DOMAIN_PATH` can remain as placeholders for now. They're only needed during post-deploy (step 7) when the user configures Cloudflare Tunnel public hostname routes.

Ask the user to confirm before proceeding with the deployment.
