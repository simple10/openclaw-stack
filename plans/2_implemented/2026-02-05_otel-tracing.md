---
feature: otel-tracing
type: base
target-vps: Both
playbook: playbooks/99-new-feature-implementation.md
---

# Plan: Add OpenTelemetry Tracing to OpenClaw VPS Deployment

## Summary

Add Grafana Tempo for distributed tracing to complete the observability stack (metrics + logs + **traces**). OpenClaw's built-in `diagnostics-otel` plugin exports traces directly to Tempo via OTLP/HTTP over WireGuard.

## Prerequisites

- `04-vps1-openclaw.md` completed (OpenClaw running)
- `05-vps2-observability.md` completed (Grafana, Loki running)
- `02-wireguard.md` completed (WireGuard tunnel active between VPSs)
- SSH access as `adminclaw` on port 222 to both VPSs

## Architecture Decision

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tempo location | VPS-2 | Matches existing observability stack location |
| OTEL Collector | Skip | OpenClaw exports directly via `diagnostics-otel` plugin |
| Tempo binding | 10.0.0.2:4318 | WireGuard IP only - matches Loki security pattern |
| OTEL metrics | Enabled → Prometheus | Per-signal routing via OTEL SDK env vars; Prometheus OTLP receiver on WireGuard |
| OTEL logs | Enabled → Loki | Structured OTEL logs complement Promtail's raw container logs |

## Traffic Flow

```
VPS-1 (10.0.0.1)                    VPS-2 (10.0.0.2)
┌──────────────────┐     traces     ┌──────────────────┐
│ OpenClaw Gateway │──OTLP/HTTP────>│ Tempo (:4318)    │
│ (diagnostics-otel)│    metrics    │ Prometheus (:9090)│
│                  │──OTLP/HTTP────>│ Loki (:3100)     │
│                  │     logs       │       │          │
└──────────────────┘──OTLP/HTTP────>│       v          │
                       WireGuard    │ Grafana (:3000)  │
                                    └──────────────────┘
```

## Files to Modify

### 1. `playbooks/05-vps2-observability.md`

**Section 5.2** - Add Tempo service to docker-compose.yml:

```yaml
  tempo:
    image: grafana/tempo:latest
    container_name: tempo
    restart: unless-stopped
    volumes:
      - ./tempo-config.yml:/etc/tempo/config.yaml:ro
      - tempo_data:/var/tempo
    command: ["-config.file=/etc/tempo/config.yaml"]
    # NOTE: Tempo needs WireGuard access - OpenClaw on VPS-1 pushes traces to 10.0.0.2:4318
    network_mode: host
```

Add volume:

```yaml
volumes:
  tempo_data:
```

**New Section 5.6a** - Create Tempo configuration (after Loki config):

```yaml
# /home/openclaw/monitoring/tempo-config.yml
stream_over_http_enabled: true

server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "10.0.0.2:4318"

ingester:
  max_block_duration: 5m
  lifecycler:
    ring:
      kvstore:
        store: inmemory
      replication_factor: 1

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks
    wal:
      path: /var/tempo/wal
```

**Section 5.7** - Add Tempo datasource to `datasources.yml`:

```yaml
  - name: Tempo
    type: tempo
    access: proxy
    url: http://127.0.0.1:3200
    editable: false
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: '-1h'
        spanEndTimeShift: '1h'
        tags: ['host', 'job']
        filterByTraceID: true
        filterBySpanID: true
      nodeGraph:
        enabled: true
```

### 2. `playbooks/04-vps1-openclaw.md`

**Section 4.8** - Update `openclaw.json`:

```json
{
  "gateway": {
    "bind": "lan",
    "mode": "local"
  },
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://10.0.0.2:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": false,
      "logs": false,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

### 3. `playbooks/07-verification.md`

Add new section:

```bash
## Verify Tracing

# On VPS-2: Check Tempo is running
sudo docker ps | grep tempo
curl -s http://localhost:3200/ready

# Check OTLP endpoint listening on WireGuard
ss -tlnp | grep 4318

# From VPS-1: Test connectivity
curl -s http://10.0.0.2:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}'
# Returns 400 (not connection refused) = working

# In Grafana: Explore -> Tempo datasource
# Query: { resource.service.name = "openclaw-gateway" }
```

### 4. `CLAUDE.md`

Update overview table to add Tempo to VPS-2 services.

Add to Key Deployment Notes:

```
12. **Tempo OTLP:** Binds to WireGuard IP (10.0.0.2:4318) for trace ingestion
13. **OpenClaw OTEL:** Keep metrics/logs disabled; use existing Prometheus/Promtail
```

## Verification Checklist

1. [ ] Tempo container running: `docker ps | grep tempo`
2. [ ] Tempo ready: `curl http://localhost:3200/ready`
3. [ ] OTLP listening: `ss -tlnp | grep 4318`
4. [ ] OpenClaw config updated and container restarted
5. [ ] Traces visible in Grafana Explore (Tempo datasource)
6. [ ] Trace-to-logs correlation working

## Rollback

1. Set `"diagnostics": { "enabled": false }` in openclaw.json, restart gateway
2. `docker compose stop tempo && docker compose rm tempo` on VPS-2
3. Remove Tempo datasource from Grafana provisioning

## Firewall

VPS-2 requires a UFW rule to allow WireGuard subnet traffic:

```bash
sudo ufw allow from 10.0.0.0/24
```

VPS-1 already has specific WireGuard rules (ports 9100, 18789). No changes needed on VPS-1.

## Runtime Patch: @opentelemetry/resources v2.x

The upstream `diagnostics-otel` extension uses `new Resource()` from `@opentelemetry/resources`,
which was replaced by `resourceFromAttributes()` in v2.x. A patched `service.ts` is mounted via
Docker volume in `docker-compose.override.yml` until the upstream fix is merged.
