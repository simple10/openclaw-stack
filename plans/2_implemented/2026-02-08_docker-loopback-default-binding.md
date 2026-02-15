# UPDATED DURING PLAN IMPLEMENTATION

Completed

  Documentation changes (3 files)

  playbooks/03-docker.md — Added "ip": "127.0.0.1" and "default-network-opts" to daemon.json config, added two rows to the
  configuration table explaining both settings, updated security notes.

  REQUIREMENTS.md — Added both settings to section 2.8 daemon.json config + table, added note in section 3.14 that
  OPENCLAW_GATEWAY_PORT stays port-only because the daemon handles localhost binding, added Docker-bypasses-UFW gotcha in
  section 6 explaining both settings and the network recreation requirement.

  playbooks/07-verification.md — Added localhost binding checklist item and ss verification command for ports 18789/18790.

  VPS deployment

- Added "ip": "127.0.0.1" and "default-network-opts" with host_binding_ipv4 to /etc/docker/daemon.json
- Restarted Docker daemon
- Recreated openclaw-gateway-net network (needed because default-network-opts only applies to new networks)
- Full down/up of containers

  Verification

- ss -tlnp confirms 127.0.0.1:18789 and 127.0.0.1:18790 (not 0.0.0.0)
- Gateway health check passes on localhost
- Cloudflare Tunnel external access (openclaw.ventureunknown.com) still works

  Key discovery

  The plan's original approach ("ip" only) was insufficient — "ip" only affects the default bridge network. Since the gateway
  uses a user-defined bridge (openclaw-gateway-net), we also needed "default-network-opts" with
  com.docker.network.bridge.host_binding_ipv4. Both settings are now in place.

  ---

# Plan: Localhost-Only Docker Port Binding via Daemon Config

## Context

With `OPENCLAW_GATEWAY_PORT=18789` (port-only format, required by OpenClaw CLI), Docker binds to `0.0.0.0:18789` — all interfaces. This is a security concern because **Docker bypasses UFW**: it manipulates iptables directly via the DOCKER chain (processed before UFW's INPUT chain), so port 18789 is reachable from the internet even if UFW blocks it.

We already have `userland-proxy: false` in daemon.json, which means Docker uses iptables DNAT rules instead of a userland proxy — but this doesn't change the binding address.

The Cloudflare Tunnel connects to `localhost:18789`, so the gateway never needs to be reachable from outside the host.

## Options Considered

| Option | Approach | Verdict |
|--------|----------|---------|
| **A. `daemon.json "ip": "127.0.0.1"`** | Docker daemon defaults all port bindings to localhost | **Recommended** |
| B. Patch upstream `docker-compose.yml` | sed the ports line in build script | Another fragile patch to maintain |
| C. Custom `docker-compose.yml` (Hetzner approach) | Replace upstream compose entirely | Must maintain full file, can't pull upstream updates |
| D. Compose override with ports | Add `127.0.0.1:18789:18789` in override | Ports MERGE (don't replace) → double-bind conflict |
| E. DOCKER-USER iptables chain | Firewall rules in Docker's chain | Complex, easy to misconfigure |
| F. Accept `0.0.0.0` | Rely on UFW (which Docker bypasses) | Insecure by design |

## Recommended Approach: Docker Daemon `"ip": "127.0.0.1"`

Add `"ip": "127.0.0.1"` to `/etc/docker/daemon.json`. This tells Docker to bind **all** port mappings to localhost by default, unless a compose file explicitly specifies a different address.

**Why this is ideal for our setup:**

- No compose file changes — works with upstream updates, no patches to maintain
- Doesn't break OpenClaw CLI — env var stays port-only (`18789`)
- System-wide default — all current and future containers get localhost binding
- Appropriate for a single-purpose VPS where everything goes through Cloudflare Tunnel
- Defence in depth — even if UFW breaks, ports aren't exposed to the internet

**Why "affects all containers" is fine here:**

- The only containers are: gateway, vector, cloudflared
- Vector doesn't expose ports (pushes logs outbound)
- Cloudflared doesn't expose ports (outbound tunnel)
- Gateway needs localhost-only — that's the whole point

## Changes

### 1. Update daemon.json in `playbooks/03-docker.md`

Add `"ip": "127.0.0.1"` to the existing daemon.json:

```json
{
  "ip": "127.0.0.1",
  "log-driver": "json-file",
  ...existing settings...
}
```

Add to the configuration table:

| `ip: 127.0.0.1` | Bind all port mappings to localhost only (services accessed via Cloudflare Tunnel, not direct) |

### 2. Update `REQUIREMENTS.md`

- Section 2.3 (Docker daemon hardening): add `"ip": "127.0.0.1"` to the config and explain why
- Section 3.14 (.env): add a note that `OPENCLAW_GATEWAY_PORT` can stay port-only because the daemon handles localhost binding
- Gotchas: add Docker-bypasses-UFW explanation and how daemon `"ip"` setting solves it

### 3. Update `playbooks/07-verification.md`

Add a verification check that port 18789 is only listening on 127.0.0.1:

```bash
# Verify gateway binds to localhost only (not 0.0.0.0)
sudo ss -tlnp | grep 18789
# Expected: 127.0.0.1:18789   (NOT 0.0.0.0:18789)
```

### 4. Deploy to VPS

```bash
# Update daemon.json on VPS
ssh ... "sudo python3 -c \"
import json
with open('/etc/docker/daemon.json') as f: c = json.load(f)
c['ip'] = '127.0.0.1'
with open('/etc/docker/daemon.json', 'w') as f: json.dump(c, f, indent=2)
\""

# Restart Docker (live-restore keeps containers running, but port bindings
# only take effect on container restart)
ssh ... "sudo systemctl restart docker"

# Restart gateway to pick up new binding
ssh ... "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart openclaw-gateway'"

# Verify localhost binding
ssh ... "sudo ss -tlnp | grep 18789"
```

## Files Modified

| File | What Changes |
|------|-------------|
| `playbooks/03-docker.md` | Add `"ip": "127.0.0.1"` to daemon.json, add table row |
| `playbooks/07-verification.md` | Add localhost binding check |
| `REQUIREMENTS.md` | Document daemon ip setting, Docker-UFW gotcha |

## Verification

1. **`ss -tlnp | grep 18789`** shows `127.0.0.1:18789` (not `0.0.0.0:18789`)
2. **`ss -tlnp | grep 18790`** shows `127.0.0.1:18790` (bridge port too)
3. **Cloudflare Tunnel** still connects (cloudflared → localhost:18789)
4. **OpenClaw CLI** still works: `sudo docker exec --user node openclaw-gateway node dist/index.js security audit --deep`
5. **External port scan** from another machine: `nc -zv <VPS_IP> 18789` should fail/timeout
