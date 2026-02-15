# Plan: Apply MODIFICATIONS.md fixes to playbooks

## Context

During the 2026-02-10 deployment, 4 issues were encountered and documented in `MODIFICATIONS.md`. The playbooks need to be updated so future deployments don't hit the same problems.

## Files to modify

- `playbooks/04-vps1-openclaw.md` (modifications 1 & 2)
- `playbooks/06-backup.md` (modification 3)
- `playbooks/08-post-deploy.md` (modification 4)

## Changes

### 1. Fix sandbox Dockerfile path in entrypoint (`04-vps1-openclaw.md`, section 4.8c)

In the entrypoint script (around line 603-605), change the base sandbox build block:

```diff
-      if ! docker image inspect openclaw-sandbox > /dev/null 2>&1; then
-        echo "[entrypoint] Sandbox image not found, building..."
-        if [ -f /app/sandbox/Dockerfile ]; then
-          docker build -t openclaw-sandbox /app/sandbox/
+      if ! docker image inspect openclaw-sandbox:bookworm-slim > /dev/null 2>&1; then
+        echo "[entrypoint] Base sandbox image not found, building..."
+        if [ -f /app/Dockerfile.sandbox ]; then
+          cd /app && scripts/sandbox-setup.sh
```

And the corresponding warning message:

```diff
-          echo "[entrypoint] WARNING: /app/sandbox/Dockerfile not found"
+          echo "[entrypoint] WARNING: /app/Dockerfile.sandbox not found"
```

Also update the image inspect check — upstream `sandbox-setup.sh` tags the image as `openclaw-sandbox:bookworm-slim`, not `openclaw-sandbox` (untagged).

### 2. Fix clone order vs directory creation (`04-vps1-openclaw.md`, sections 4.3/4.4)

In section 4.3, remove the `openclaw` subdirectory and its `data/docker` child from the mkdir block (let `git clone` create it):

```diff
 mkdir -p "${OPENCLAW_HOME}/openclaw"
-mkdir -p "${OPENCLAW_HOME}/openclaw/data/docker"
```

becomes:

```diff
+# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in section 4.4
```

In section 4.4, add the data subdirectories after the clone:

```diff
 sudo -u openclaw bash << 'EOF'
 cd /home/openclaw
 git clone https://github.com/openclaw/openclaw.git openclaw
+
+# Create data directories for bind mounts (not tracked by git)
+mkdir -p /home/openclaw/openclaw/data/docker
+mkdir -p /home/openclaw/openclaw/data/vector
 EOF
```

### 3. Add `sudo` to backup verification (`06-backup.md`, section 6.3)

```diff
 # Verify backup was created
-ls -la /home/openclaw/.openclaw/backups/
+sudo ls -la /home/openclaw/.openclaw/backups/

 # Verify backup contents
-tar -tzf /home/openclaw/.openclaw/backups/openclaw_backup_*.tar.gz
+sudo tar -tzf /home/openclaw/.openclaw/backups/openclaw_backup_*.tar.gz
```

### 4. Replace Python device pairing with CLI + jq fallback (`08-post-deploy.md`, section 8.3)

Replace the "First device pairing (file-based)" subsection. The new approach:

1. **Primary**: Try `openclaw devices approve` via `docker exec` inside the container (bypasses host wrapper's own pairing requirement)
2. **Fallback**: If CLI also needs pairing, use `jq` to manipulate the files

Replace the Python script block (lines ~117-149) with:

```bash
# 1. Read pending requests directly from the filesystem
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec openclaw-gateway cat /home/node/.openclaw/devices/pending.json"
```

Find the `requestId` for the `openclaw-control-ui` client, then try CLI first:

```bash
# 2. Try CLI approval (works if approve subcommand doesn't require prior pairing)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker exec --user node openclaw-gateway openclaw devices approve <requestId>"
```

Add a fallback subsection "If CLI approval fails (circular dependency)" with the `jq` approach:

```bash
# Fallback: approve via jq file manipulation
# paired.json is a dict keyed by deviceId (NOT an array)
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  'sudo docker exec openclaw-gateway bash -c '"'"'
    REQUEST_ID="<requestId>"
    NOW_MS=$(date +%s)000
    DEVICE=$(jq --arg rid "$REQUEST_ID" --arg now "$NOW_MS" \
      ".[\$rid] + {approvedAt: (\$now | tonumber)}" \
      /home/node/.openclaw/devices/pending.json)
    DEVICE_ID=$(echo "$DEVICE" | jq -r ".deviceId")
    jq --argjson dev "$DEVICE" \
      ". + {(\$dev.deviceId): \$dev}" \
      /home/node/.openclaw/devices/paired.json > /tmp/paired.json \
      && mv /tmp/paired.json /home/node/.openclaw/devices/paired.json
    echo "Approved device: $DEVICE_ID"
  '"'"''
```

Remove the entire Python `<< "PYEOF"` block.

## Cleanup

After applying all changes, delete `MODIFICATIONS.md` — its contents will be incorporated into the playbooks.

## Verification

1. Read each modified file and verify the diffs are correct
2. No runtime verification needed — these are documentation/playbook files, not executable code on the VPS
