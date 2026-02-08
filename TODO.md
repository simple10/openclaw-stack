# TODO

## Completed (this branch)

- [x] Create branch otel-v1 and push to github — saves a snapshot of the OTEL work
- [x] Create Log Receiver Worker (workers/log-receiver/)
- [x] Create Vector config (vector.toml)
- [x] Create host alerter script (scripts/host-alert.sh)
- [x] Simplify build script — remove OTEL patches 1-3
- [x] Update openclaw-config.env — remove VPS-2, OTEL vars
- [x] Update all playbooks for single-VPS architecture
- [x] Update CLAUDE.md, REQUIREMENTS.md, README.md
- [x] Create Workers deployment playbook (01-workers.md)

## Next Steps

- [ ] Deploy the AI Gateway worker & test end-to-end
- [ ] Deploy the Log Receiver worker & test with Vector
- [ ] Deploy single-VPS architecture on VPS-1
- [ ] Test AI Gateway routing end-to-end (all provider keys via AI_GATEWAY_AUTH_TOKEN)
- [ ] Configure Cloudflare Health Check in dashboard

## Future

- [ ] Add R2 sync of config & workspace for backups
- [ ] Add optional sidecar proxy to capture and inspect sandbox traffic
- [ ] Test if OpenClaw can use claude code effectively in sandboxes
- [ ] Harden openclaw gateway container further (after testing sandbox stability)
- [ ] Add Logpush to R2 for long-term log storage
