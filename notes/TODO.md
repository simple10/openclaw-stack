# TODO

AGENTS: IGNORE THIS TODO LIST - for development only

- [ ] Add docs/SKILL-ROUTER.md to point to skill router README.md on how to use skill-router config in openclaw.json

- [ ] Mess around with the config in the UI then check the openclaw.json
  - Use the changes to update 04 playbook - e.g.

  ```json
   "logging": {
    "consoleStyle": "json",
    "redactSensitive": "tools"
  },
  ```

- [ ] Verify if the health cron in log worker can reach the VPS over the tunnel, if not, remove from README

- [ ] Add seccompProfile, apparmorProfile to sandbox configs in openclaw.json
  - See <https://github.com/openclaw/openclaw/blob/main/src/agents/sandbox/types.docker.ts>

## Completed (this branch)

- [x] Serve html instead of not found for media server when no files are present
- [x] Add docs/ to sandbox agents, system prompt references docs/ to assist users with openclaw: <https://docs.openclaw.ai/concepts/system-prompt>
- [x] Set OPENAI_BASE_URL and ANTHROPIC_BASE_URL in sandbox env so sdk's pick up the urls
- [x] Modify log worker to use console.log/warn/error to highlight the logs in cloudflare dashboard
- [x] Make sure CLI pairing happens during deploy - cli requires device pairing or openclaw commands will fail
- [x] Add verification or post-deploy step to run `node openclaw.mjs security audit --deep` on openclaw-gateway
- [x] Update Cloudflare Tunnel doc
  - See existing claude UI chat about "Cloudflare Tunnel"
- [x] Add log rotation: <https://github.com/openclaw/openclaw/blob/main/src/hooks/bundled/command-logger/HOOK.md>
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
