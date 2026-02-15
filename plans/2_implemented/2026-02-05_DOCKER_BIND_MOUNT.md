# Plan: Convert Named Volumes to Bind Mounts + Fix Promtail Positions

## Goal

Convert all Docker named volumes to bind mounts under known directories so `rsync` can easily back up everything from the host. Also fix Promtail's missing positions persistence.

## Current State

### VPS-2: 5 named volumes to convert

| Container | Named Volume | Container Path | Owner UID |
|-----------|-------------|----------------|-----------|
| prometheus | `monitoring_prometheus_data` | `/prometheus` | `nobody` (65534) |
| grafana | `monitoring_grafana_data` | `/var/lib/grafana` | `472` |
| loki | `monitoring_loki_data` | `/loki` | `10001` |
| tempo | `monitoring_tempo_data` | `/var/tempo` | `10001` |
| alertmanager | `monitoring_alertmanager_data` | `/alertmanager` | `nobody` (65534) |

### VPS-1: 1 missing mount to fix

| Container | Issue |
|-----------|-------|
| promtail | `positions.yaml` at `/tmp/positions.yaml` has no persistent mount — lost on restart, causes duplicate logs |

VPS-1 gateway already uses bind mounts (`/home/openclaw/.openclaw`), no named volumes.

---

## Changes

### VPS-2: Convert named volumes → bind mounts

New directory structure under `/home/openclaw/monitoring/data/`:

```
/home/openclaw/monitoring/data/
├── prometheus/      # UID nobody (65534)
├── grafana/         # UID 472
├── loki/            # UID 10001
├── tempo/           # UID 10001
└── alertmanager/    # UID nobody (65534)
```

**docker-compose.yml changes:**

Replace named volume mounts with bind mounts:

```yaml
  prometheus:
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
      - ./data/prometheus:/prometheus              # was: prometheus_data:/prometheus

  grafana:
    volumes:
      - ./data/grafana:/var/lib/grafana             # was: grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro

  loki:
    volumes:
      - ./loki-config.yml:/etc/loki/local-config.yaml:ro
      - ./data/loki:/loki                           # was: loki_data:/loki

  alertmanager:
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - ./data/alertmanager:/alertmanager            # was: alertmanager_data:/alertmanager

  tempo:
    volumes:
      - ./tempo-config.yml:/etc/tempo/config.yaml:ro
      - ./data/tempo:/var/tempo                      # was: tempo_data:/var/tempo
```

Remove the `volumes:` section at the bottom:

```yaml
# DELETE this entire block:
volumes:
  prometheus_data:
  grafana_data:
  loki_data:
  alertmanager_data:
  tempo_data:
```

### VPS-1: Add Promtail positions persistence

**docker-compose.override.yml** — add bind mount for positions:

```yaml
  promtail:
    volumes:
      - ./promtail-config.yml:/etc/promtail/config.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - ./promtail-positions:/tmp                   # NEW: persist positions.yaml
```

---

## Files to Modify

### Playbooks (documentation)

1. **`playbooks/05-vps2-observability.md`**
   - Section 5.2: Replace named volumes with bind mounts in docker-compose.yml
   - Remove `volumes:` declaration block
   - Add step to create `data/` directories with correct ownership

2. **`playbooks/04-vps1-openclaw.md`**
   - Add `./promtail-positions:/tmp` bind mount to promtail service

### Live deployment

1. **VPS-2** `/home/openclaw/monitoring/docker-compose.yml`
   - Replace 5 named volume references with bind mount paths
   - Remove `volumes:` block

2. **VPS-1** `/home/openclaw/openclaw/docker-compose.override.yml`
   - Add promtail positions bind mount

---

## Live Deployment Steps

### VPS-2 (do first — more containers affected)

```bash
# 1. Stop all services
cd /home/openclaw/monitoring
sudo -u openclaw docker compose down

# 2. Create data directories
sudo -u openclaw mkdir -p data/{prometheus,grafana,loki,tempo,alertmanager}

# 3. Copy data from named volumes to bind mount directories
sudo cp -a /var/lib/docker/volumes/monitoring_prometheus_data/_data/. data/prometheus/
sudo cp -a /var/lib/docker/volumes/monitoring_grafana_data/_data/. data/grafana/
sudo cp -a /var/lib/docker/volumes/monitoring_loki_data/_data/. data/loki/
sudo cp -a /var/lib/docker/volumes/monitoring_tempo_data/_data/. data/tempo/
sudo cp -a /var/lib/docker/volumes/monitoring_alertmanager_data/_data/. data/alertmanager/

# 4. Fix ownership (cp -a preserves, but verify)
sudo chown -R 65534:65534 data/prometheus data/alertmanager
sudo chown -R 472:root data/grafana
sudo chown -R 10001:10001 data/loki data/tempo

# 5. Update docker-compose.yml (replace named volumes with bind mounts)
# 6. Start services
sudo -u openclaw docker compose up -d

# 7. Verify all services healthy
sudo -u openclaw docker compose ps
curl -s http://10.0.0.2:9090/api/v1/targets | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'{t[\"labels\"][\"job\"]}: {t[\"health\"]}') for t in d['data']['activeTargets']]"
curl -s http://10.0.0.2:3100/ready
curl -s http://localhost:3200/ready
curl -s http://localhost:3000/api/health

# 8. After confirming everything works, remove old named volumes
sudo docker volume rm monitoring_prometheus_data monitoring_grafana_data monitoring_loki_data monitoring_tempo_data monitoring_alertmanager_data
```

### VPS-1 (promtail fix)

```bash
# 1. Create positions directory
cd /home/openclaw/openclaw
sudo mkdir -p promtail-positions

# 2. Copy current positions from container
sudo docker cp promtail:/tmp/positions.yaml promtail-positions/positions.yaml

# 3. Update docker-compose.override.yml (add bind mount)
# 4. Restart promtail
sudo -u openclaw docker compose up -d promtail

# 5. Verify positions persist across restart
sudo -u openclaw docker compose restart promtail
sleep 5
sudo docker exec promtail cat /tmp/positions.yaml
```

### Cleanup (both VPSs)

```bash
# Remove orphan caddy volumes (no longer used — using Cloudflare Tunnel)
sudo docker volume rm caddy_config caddy_data
```

---

## Verification

After migration:

```bash
# VPS-2: All data directories exist and have correct ownership
ls -la /home/openclaw/monitoring/data/

# VPS-2: All services running
sudo -u openclaw docker compose ps

# VPS-2: Prometheus still has historical data
curl -s "http://10.0.0.2:9090/api/v1/query?query=up" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['result']), 'series')"

# VPS-2: Grafana still has dashboards/settings
curl -s http://localhost:3000/api/health

# VPS-2: Loki still has logs
curl -s "http://10.0.0.2:3100/loki/api/v1/query" --data-urlencode 'query={host="openclaw"}' | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['result']), 'streams')"

# VPS-1: Promtail positions persist across restart
sudo -u openclaw docker compose restart promtail
sleep 5
sudo docker exec promtail cat /tmp/positions.yaml
```

## Backup

After migration, all persistent data on VPS-2 lives under `/home/openclaw/monitoring/data/` and config files under `/home/openclaw/monitoring/`. A single rsync of `/home/openclaw/monitoring/` captures everything.
