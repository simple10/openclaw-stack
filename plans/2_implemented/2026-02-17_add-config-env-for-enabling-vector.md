# Add ENABLE_VECTOR_LOG_SHIPPING config toggle

## Context

Vector is now a standalone compose project, but nothing gates whether it gets started or checked. Add a simple boolean config var so deployments can opt out of Vector without affecting anything else. The log-receiver worker deployment is unchanged — it's fine to have the worker deployed even if Vector isn't running.

## Config Var

```bash
ENABLE_VECTOR_LOG_SHIPPING=true   # Set to false to skip Vector on the VPS
```

## Changes

### 1. `openclaw-config.env.example`

Add `ENABLE_VECTOR_LOG_SHIPPING=true` next to the LOG_WORKER vars, with a comment explaining it controls Vector startup on the VPS.

### 2. `playbooks/04-vps1-openclaw.md`

**§4.7** — Already has a skip note. Update the condition from "skip if LOG_WORKER_URL not set" to check `ENABLE_VECTOR_LOG_SHIPPING`:

```
> **Skip this section** if `ENABLE_VECTOR_LOG_SHIPPING` is `false` in `openclaw-config.env`.
```

**§4.16 (Start services)** — Update the Vector start conditional:

```bash
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
fi
```

### 3. `playbooks/07-verification.md`

**§7.2** — Add skip:

```
> **Skip this section** if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.
```

**§7.3 Log Receiver Worker** — Add skip:

```
> **Skip** Log Receiver verification if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.
```

**§7.6 checklist** — Update:

```
- [ ] Gateway + Sysbox running (+ Vector if ENABLE_VECTOR_LOG_SHIPPING=true)
- [ ] AI Gateway Worker responding (+ Log Receiver if ENABLE_VECTOR_LOG_SHIPPING=true)
```

**Success Criteria** — Update items 3 and 5:

```
3. Vector running and shipping logs (if ENABLE_VECTOR_LOG_SHIPPING=true)
5. Container logs appearing in Cloudflare dashboard (if ENABLE_VECTOR_LOG_SHIPPING=true)
```

### 4. `scripts/health-check.sh`

Source the config file (already does). Use `ENABLE_VECTOR_LOG_SHIPPING` to decide whether to check the vector container:

```bash
CONTAINERS="openclaw-gateway"
if [ "${ENABLE_VECTOR_LOG_SHIPPING:-true}" = "true" ]; then
  CONTAINERS="$CONTAINERS vector"
fi
```

### 5. `playbooks/maintenance.md`

**§ Log Worker Token rotation** — Add note:

```
> **Skip** if `ENABLE_VECTOR_LOG_SHIPPING` is `false`.
```

## Files Modified

| File | Change |
|------|--------|
| `openclaw-config.env.example` | Add `ENABLE_VECTOR_LOG_SHIPPING=true` |
| `playbooks/04-vps1-openclaw.md` | §4.7 + §4.16 gate on config var |
| `playbooks/07-verification.md` | §7.2, §7.3, §7.6 checklist, success criteria |
| `scripts/health-check.sh` | Conditional Vector container check |
| `playbooks/maintenance.md` | Skip note on Log Worker Token rotation |
