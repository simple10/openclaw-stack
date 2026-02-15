# Plan: Update Playbooks with Deployment Learnings

## Context

During a full fresh deployment on a new VPS, several issues were discovered that caused delays and required manual fixes. These need to be incorporated into the playbooks so future fresh deployments go smoothly without hitting the same problems.

## Issues Found During Deployment

1. **Vector loaded wrong config** — Vector Alpine image defaults to `vector.yaml` but we create `vector.toml`. Fix: convert to `vector.yaml` to match Vector's default expectation (easier to maintain than TOML).
2. **Entrypoint crash-loops on sandbox build failures** — `set -euo pipefail` causes the entire container to exit when any sandbox build script fails (e.g., `sandbox-common-setup.sh` failing due to `USER sandbox` in base image).
3. **Device pairing CLI circular dependency** — `node dist/index.js devices list` connects via websocket which itself requires pairing. First device can never be approved via CLI alone.
4. **Extras playbook has same entrypoint bug** — `extras/sandbox-and-browser.md` section E.3 has identical `set -euo pipefail` issue.
5. **Tunnel cert.pem auth was painful** — `cloudflared tunnel login` opens a browser URL on the VPS (headless server), requiring manual cert download/upload. Switch to token-based remotely-managed tunnel: user creates tunnel in CF Dashboard, gets a token, playbook just installs cloudflared with that token.

## Changes

### 1. Convert Vector config from TOML to YAML

**Files:** `playbooks/04-vps1-openclaw.md` (sections 4.6 and 4.7)

Vector Alpine image defaults to `vector.yaml`. Instead of overriding the command, convert the config to YAML format which is easier to maintain and matches Vector's default.

**Section 4.7** — Replace the `vector.toml` content with `vector.yaml`:

```yaml
# Vector configuration — ships Docker container logs to Cloudflare Log Receiver Worker
# https://vector.dev/docs/

sources:
  docker_logs:
    type: docker_logs

transforms:
  enrich:
    type: remap
    inputs:
      - docker_logs
    source: '.vps_ip = "${VPS1_IP}"'

sinks:
  cloudflare_worker:
    type: http
    inputs:
      - enrich
    uri: "${LOG_WORKER_URL}"
    encoding:
      codec: json
    auth:
      strategy: bearer
      token: "${LOG_WORKER_TOKEN}"
    batch:
      max_bytes: 262144    # 256KB per batch
      timeout_secs: 60     # Ship at least every 60s
    request:
      retry_max_duration_secs: 300   # Keep retrying for 5 min on failures
```

Update the section title from "4.7 Create Vector Config" and change:

- `tee ... vector.toml` → `tee ... vector.yaml`
- `mkdir -p ... data/vector` stays the same

**Section 4.6** — Update the compose override volume mount:

- `./vector.toml:/etc/vector/vector.toml:ro` → `./vector.yaml:/etc/vector/vector.yaml:ro`

No `command` override needed — Vector will find `vector.yaml` by default.

### 2. Wrap sandbox builds in `set +e` subshell in entrypoint

**File:** `playbooks/04-vps1-openclaw.md` (section 4.8c)

After the `"Nested Docker daemon ready"` message (line 612), wrap all four sandbox build blocks in a subshell with `set +e`:

```bash
    echo "[entrypoint] Nested Docker daemon ready (took ${elapsed:-0}s)"

    # Sandbox builds are non-fatal — gateway starts even if builds fail.
    # Failures are logged but don't prevent the gateway from running.
    # Rebuild manually later: sudo docker exec openclaw-gateway /app/scripts/sandbox-common-setup.sh
    (
      set +e

      # Build default sandbox image if missing
      ...
      # Build common sandbox image if missing
      ...
      # Build browser sandbox image if missing
      ...
      # Build claude sandbox image if missing
      ...
    )
  fi
```

The opening `(` and `set +e` go right after the "ready" echo. The closing `)` goes before `fi` (closing the `if docker info` block). This ensures:

- Lock cleanup, config perms, dockerd startup still use strict mode
- Sandbox build failures are non-fatal — the gateway starts regardless
- Failures are still logged via echo statements

### 3. Add file-based device pairing fallback

**File:** `playbooks/98-post-deploy.md` (section 98.3)

Replace the current "List pending device requests" approach with a file-based approach as the **primary method** for first-ever pairing. The CLI approach has a circular dependency: `devices list` connects via websocket, which requires an already-paired device.

Add a new subsection before the existing CLI commands:

```markdown
### First device pairing (file-based)

The CLI command `devices list` connects to the gateway via WebSocket, which itself requires
a paired device — a circular dependency on first deployment. Use the file-based approach instead:

\```bash
# 1. Read pending requests directly from the filesystem
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway cat /home/node/.openclaw/devices/pending.json"
\```

Find the `requestId` from the output, then approve it:

\```bash
# 2. Approve by writing to paired.json (replace <requestId> with actual value)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  'sudo docker exec openclaw-gateway python3 -c "
import json, os, time
pf = \"/home/node/.openclaw/devices/pending.json\"
af = \"/home/node/.openclaw/devices/paired.json\"
with open(pf) as f: pending = json.load(f)
paired = []
if os.path.exists(af):
    with open(af) as f: paired = json.load(f)
# Approve the most recent pending request
device = pending[-1]
device[\"approvedAt\"] = int(time.time() * 1000)
paired.append(device)
with open(af, \"w\") as f: json.dump(paired, f, indent=2)
print(f\"Approved: {device.get(chr(110)+chr(97)+chr(109)+chr(101), device[chr(114)+chr(101)+chr(113)+chr(117)+chr(101)+chr(115)+chr(116)+chr(73)+chr(100)])}\")"'
\```

> **Note:** After the first device is paired, subsequent devices can be approved from the
> Control UI or via the CLI `devices approve` command.
```

Actually, the Python one-liner is too complex for a playbook. Use a simpler approach:

```bash
# 2. Approve the most recent pending request
ssh ... 'sudo docker exec openclaw-gateway python3 << "PYEOF"
import json, os, time
pending_file = "/home/node/.openclaw/devices/pending.json"
paired_file = "/home/node/.openclaw/devices/paired.json"
with open(pending_file) as f:
    pending = json.load(f)
if not pending:
    print("No pending requests found. Ask the user to refresh the browser page.")
    exit(1)
paired = []
if os.path.exists(paired_file):
    with open(paired_file) as f:
        paired = json.load(f)
device = pending[-1]
device["approvedAt"] = int(time.time() * 1000)
paired.append(device)
with open(paired_file, "w") as f:
    json.dump(paired, f, indent=2)
print(f"Approved device: {device.get('name', device.get('requestId', 'unknown'))}")
PYEOF'
```

Keep the existing CLI-based sections but move them under a "Subsequent devices" heading and note they only work after first pairing.

### 4. Apply same entrypoint fix to extras playbook

**File:** `playbooks/extras/sandbox-and-browser.md` (section E.3)

Apply the same `set +e` subshell wrapping around sandbox builds in the extras entrypoint (lines 182-235). The fix is identical to change #2.

### 5. Rewrite tunnel playbook to use token-based setup

**Files:** `playbooks/05-cloudflare-tunnel.md`, `openclaw-config.env.example`, `CLAUDE.md`

The current flow uses `cloudflared tunnel login` (cert-based, locally-managed), which requires browser auth on a headless server. Replace with the simpler token-based (remotely-managed) approach:

**Add `CF_TUNNEL_TOKEN` to config:**

- Add `CF_TUNNEL_TOKEN=` to `openclaw-config.env.example` (in a new "Cloudflare Tunnel" section)
- Add it to the CLAUDE.md config validation list (non-required — prompted if missing)

**Update CLAUDE.md Setup Question Flow:**

- During config validation (Step 0), if `CF_TUNNEL_TOKEN` is empty/missing, prompt the user with instructions to create a tunnel in the CF Dashboard and provide the token
- If set, validate by testing `cloudflared tunnel run --token <token>` on VPS

**Rewrite `05-cloudflare-tunnel.md`:**

The new flow:

1. **Step 1: Install cloudflared** — same as current (download .deb, install)
2. **Step 2: Install as service with token** — replaces Steps 2-7:

   ```bash
   # Install cloudflared as service using the tunnel token
   sudo cloudflared service install ${CF_TUNNEL_TOKEN}
   sudo systemctl enable cloudflared
   sudo systemctl start cloudflared
   ```

   No cert.pem, no credentials.json, no config.yml needed — all config lives in the CF Dashboard.
3. **Step 3: Remove port 443** — same as current Step 8

Add a section explaining how to create the tunnel + token in the CF Dashboard:

```
1. Go to Cloudflare Dashboard → Zero Trust → Networks → Tunnels
2. Click "Create a tunnel" → Choose "Cloudflared"
3. Name it (e.g., "openclaw")
4. Copy the tunnel token (long base64 string starting with "ey...")
5. Configure the public hostname:
   - Subdomain: openclaw (or your choice)
   - Domain: example.com
   - Service: http://localhost:18789
6. Save the tunnel
```

Remove all cert-based sections (Steps 2-7 in current playbook): `tunnel login`, `tunnel create`, config.yml creation, `tunnel route dns`.

Keep: Architecture diagram, Cloudflare Access section, Verification, Troubleshooting (update for token-based), Maintenance (simplify — no credential rotation needed).

**Update Related Files section:** Remove `cert.pem` and `credentials.json` references. The only tunnel file is now the systemd unit created by `cloudflared service install`.

### 6. Add Vector troubleshooting to 04

**File:** `playbooks/04-vps1-openclaw.md` (Troubleshooting section)

Add a new troubleshooting entry:

```markdown
### Vector Not Shipping Logs

\```bash
# Check Vector logs for config errors
sudo docker logs vector 2>&1 | head -20

# Verify vector.yaml is mounted correctly
sudo docker exec vector ls -la /etc/vector/

# Test the Worker endpoint is reachable from within the container
sudo docker exec vector wget -q -O- https://<LOG_WORKER_URL>/health

# Restart Vector after fixing
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose restart vector'
\```
```

## Files Modified

| File | Sections Changed |
|------|-----------------|
| `playbooks/04-vps1-openclaw.md` | 4.6 (compose override volume), 4.7 (vector.toml → vector.yaml), 4.8c (entrypoint), Troubleshooting |
| `playbooks/05-cloudflare-tunnel.md` | Full rewrite: cert-based → token-based |
| `playbooks/98-post-deploy.md` | 98.3 (device pairing) |
| `playbooks/extras/sandbox-and-browser.md` | E.3 (entrypoint) |
| `openclaw-config.env.example` | Add `CF_TUNNEL_TOKEN` variable |
| `CLAUDE.md` | Add `CF_TUNNEL_TOKEN` to config validation, update Setup Question Flow |

## Verification

After making changes, verify by reviewing each modified section:

1. Section 4.6: Confirm Vector volume mount uses `vector.yaml` (not `vector.toml`)
2. Section 4.7: Confirm config is YAML format, filename is `vector.yaml`
3. Section 4.8c: Confirm sandbox builds are wrapped in `( set +e; ... )`
4. Section 98.3: Confirm file-based pairing is the primary method with clear instructions
5. Section E.3: Confirm same `set +e` fix applied
6. Section 05: Confirm tunnel uses token-based flow, no cert.pem references
7. `openclaw-config.env.example`: Confirm `CF_TUNNEL_TOKEN` present
8. `CLAUDE.md`: Confirm `CF_TUNNEL_TOKEN` in validation and setup flow
9. Troubleshooting: Confirm Vector and tunnel entries added
