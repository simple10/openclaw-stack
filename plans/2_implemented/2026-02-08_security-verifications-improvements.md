# Plan: Add Security Verification Steps to 07-verification.md

## Context

The verification playbook currently checks service health and has a security checklist, but lacks active security testing — specifically verifying that gateway ports aren't externally reachable and running OpenClaw's built-in security audit. These are important validations given the Docker-bypasses-UFW issue we just fixed.

## Changes

### File: `playbooks/07-verification.md`

Add a new **section 7.8 Security Verification** after the existing 7.7 End-to-End Test. This section contains three checks:

#### 1. External port reachability (run from local machine)

Attempt to connect to gateway ports 18789/18790 directly via VPS public IP from the local machine. Both should fail/timeout, confirming they're not externally reachable.

```bash
# Run from LOCAL machine (not on VPS)
nc -zv -w 5 <VPS1_IP> 18789 2>&1 || echo "Port 18789 not reachable (expected)"
nc -zv -w 5 <VPS1_IP> 18790 2>&1 || echo "Port 18790 not reachable (expected)"
```

#### 2. Full listening port audit (run on VPS)

Verify the only externally-bound port is SSH (222). All other listening ports should be on 127.0.0.1 only.

```bash
# On VPS-1: list all listening ports — only 222 should be on 0.0.0.0 or [::]
sudo ss -tlnp
```

This catches any unexpected services that might have been installed or misconfigured.

#### 3. OpenClaw security audit (run on VPS)

Run OpenClaw's built-in security scanner. Does NOT need device pairing — it performs local HTTP probes inside the container.

```bash
sudo docker exec --user node openclaw-gateway node dist/index.js security audit --deep
```

Expected: 0 critical, 0 warnings. (1 info is normal.)

**Sequencing:** All three checks go in 7.8, after 7.7 End-to-End Test. The security audit doesn't need device pairing (it's HTTP probes, not WebSocket), so it can run before `98-post-deploy.md`.

### Also update

- **Success Criteria** section at the bottom: add "Security audit passes with no critical/warning findings" and "Gateway ports not reachable from external network"

## Verification

After implementing, deploy to VPS and run the checks:

1. `nc -zv -w 5 15.204.238.118 18789` from local — should timeout
2. `ssh ... "sudo ss -tlnp"` — only 222 on 0.0.0.0
3. `ssh ... "sudo docker exec --user node openclaw-gateway node dist/index.js security audit --deep"` — 0 critical, 0 warn
