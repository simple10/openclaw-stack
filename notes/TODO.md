# TODO

AGENTS: IGNORE THIS TODO LIST - for development only

- [ ] After fresh deploy, try starting agent sandbox via CLI then accessing /dashboard after CF Access
  - Does the dashboard block access since it's not paired?

- [x] Add tagging to sandbox common builds to allow for layered builds instead of full rebuilds

- [x] Rename sandbox-common to sandbox-toolkit

- [x] Add sandbox-toolkit bin test to verification step

- [ ] Try deploying without skill-bin shims to see if it's been fixed
  - Upstream might have better support for routing
  - Coordinator might be solving the issue without shimming
  - At a minimum, needs to be renamed to tool-bin to avoid confusion

- [x] Rename novnc-proxy to dashboard
  - [ ] Add pairing test

- [ ] Verify if the health cron in log worker can reach the VPS over the tunnel, if not, remove from README

- [ ] Add seccompProfile, apparmorProfile to sandbox configs in openclaw.json
  - See <https://github.com/openclaw/openclaw/blob/main/src/agents/sandbox/types.docker.ts>

## Completed (this branch)

- [x] Debug code agent routing: `are you logged in to claude code` didn't route (fixed by changing coordinator prompt)
- [x] Scan playbooks for compaction and optimization
- [x] Make claude store adminclaw and openclaw user passwords in openclaw-config.env as comments when they're generated
- [x] Fix failed first try attempts in playbooks - happened fairly early, probably 02, check asciinema
- [x] Update playbooks to remove AI Gateway requirement or checks
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

- [ ] Configure Cloudflare Health Check in dashboard

## Future

- [ ] Add R2 sync of config & workspace for backups
- [ ] Add optional sidecar proxy to capture and inspect sandbox traffic
- [ ] Harden openclaw gateway container further (after testing sandbox stability)
- [ ] Add Logpush to R2 for long-term log storage
