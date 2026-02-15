# Plan: Interactive VPS Management CLI

## Context

The OpenClaw two-VPS deployment is fully operational but all management is done via manual SSH commands. The TODO.md explicitly calls for a "zx script that can execute openclaw commands in the container." This CLI will be the single entry point for all VPS management: running openclaw commands, checking health, viewing logs, managing backups, and running verification checks.

## Project Setup

Create a `cli/` directory at the project root with:

```
cli/
├── package.json          # zx, @inquirer/prompts, chalk, tsx, typescript
├── tsconfig.json
├── cli.mjs               # #!/usr/bin/env npx tsx — thin entry shim
└── src/
    ├── main.ts            # Entry: config load, arg parse or menu loop
    ├── config.ts          # Parse openclaw-config.env (manual parser, no dotenv)
    ├── ssh.ts             # SSH command helpers — foundation for everything
    ├── ui.ts              # chalk formatting: ok/fail/warn, section headers, status lines
    ├── commands/
    │   ├── openclaw.ts    # OpenClaw CLI submenu (status, config, channels, models, etc.)
    │   ├── status.ts      # Status Overview dashboard (parallel checks on both VPSs)
    │   ├── gateway.ts     # Gateway Docker submenu (compose ps, logs, restart, shell)
    │   ├── monitoring.ts  # Monitoring submenu (service health, logs, restart)
    │   ├── infra.ts       # Infrastructure (wireguard, ufw, disk, system resources)
    │   ├── otel.ts        # OTEL endpoint checks and config viewing
    │   ├── backups.ts     # Run/list/view backup log
    │   └── verify.ts      # Full verification suite from 07-verification.md
    └── types.ts           # Shared types (Config, VpsTarget, CheckResult)
```

Dependencies: `zx`, `@inquirer/prompts`, `chalk` (runtime); `tsx`, `typescript`, `@types/node` (dev)

## Menu Tree

```
Main Menu
├── OpenClaw                    — openclaw CLI commands (run inside gateway container)
│   ├── Status & Health
│   │   ├── Status              — openclaw status --all
│   │   ├── Health              — openclaw health
│   │   └── Doctor              — openclaw doctor
│   ├── Configuration
│   │   ├── Get config value    — openclaw config get <key>
│   │   ├── Set config value    — openclaw config set <key> <value>
│   │   ├── Show config schema  — openclaw config schema
│   │   └── Interactive config  — openclaw configure [--section <name>]
│   ├── Channels
│   │   ├── List channels       — openclaw channels list
│   │   ├── Channel status      — openclaw channels status
│   │   ├── Channel logs        — openclaw channels logs --channel <ch|all>
│   │   └── Channel capabilities— openclaw channels capabilities
│   ├── Models
│   │   ├── List models         — openclaw models list
│   │   ├── Model status        — openclaw models status
│   │   ├── Set model           — openclaw models set <provider/model>
│   │   └── Manage aliases      — openclaw models aliases list/add/remove
│   ├── Agent
│   │   ├── Run agent           — openclaw agent --message <msg> [--thinking <level>]
│   │   └── List agents         — openclaw agents list
│   ├── Skills
│   │   └── List skills         — openclaw skills list [--eligible]
│   ├── Sessions
│   │   └── List sessions       — openclaw sessions [--active <min>]
│   ├── Scheduler (Cron)
│   │   ├── List jobs           — openclaw cron list
│   │   ├── Add job             — openclaw cron add (prompted)
│   │   ├── Run job             — openclaw cron run <jobId>
│   │   ├── View run history    — openclaw cron runs --id <jobId>
│   │   └── Remove job          — openclaw cron remove <jobId>
│   ├── Nodes
│   │   ├── List nodes          — openclaw nodes list
│   │   └── Pending requests    — openclaw nodes pending
│   ├── Logs                    — openclaw logs [--follow]
│   ├── Security audit          — openclaw security audit [--deep]
│   └── Run custom command      — freeform: openclaw <anything>
│
├── Status Overview             — parallel health dashboard for both VPSs
│
├── Gateway (Docker)            — manage the gateway container/stack
│   ├── Container status        — docker compose ps
│   ├── Health check            — curl localhost:18789/health
│   ├── View logs               — docker logs (tail N or follow live)
│   ├── Start / Stop / Restart stack
│   └── Shell into container    — interactive SSH with PTY
│
├── Monitoring
│   ├── Container status        — docker compose ps
│   ├── Service health          — prometheus targets, loki/tempo/grafana/alertmanager readiness
│   ├── Service logs            — pick service, tail or follow
│   ├── Start / Stop / Restart stack
│   └── Firing alerts           — alertmanager API
│
├── Infrastructure
│   ├── WireGuard status        — wg show on both VPSs
│   ├── Firewall status         — ufw status on both VPSs
│   ├── Disk usage              — df -h on both VPSs
│   ├── System resources        — free -h, uptime on both VPSs
│   └── SSH connectivity        — echo test on both VPSs
│
├── OTEL
│   ├── Check OTLP endpoints    — curl traces/metrics/logs endpoints from VPS-1
│   ├── View OTEL env vars      — docker exec env | grep OTEL
│   └── View OTEL config        — cat openclaw.json diagnostics section
│
├── Backups
│   ├── Run manual backup
│   ├── List backups
│   └── View backup log
│
├── Verify All                  — full 07-verification.md suite with pass/fail report
└── Exit
```

All OpenClaw commands execute via: `sudo docker exec openclaw-gateway openclaw <args>` on VPS-1.
Interactive commands (configure, channel login) use `sshInteractive()` with PTY allocation.

**Direct command mode** (skip menus): `./cli.mjs status`, `./cli.mjs oc status`, `./cli.mjs oc config get browser.enabled`, `./cli.mjs gateway logs -f`, `./cli.mjs verify`, etc.

## Key Architecture Decisions

### SSH abstraction (`ssh.ts`)

All remote ops go through typed helpers. `adminclaw` cannot `cd` into `/home/openclaw/` so docker compose commands use `sudo sh -c 'cd /path && sudo -u openclaw docker compose ...'`.

```
ssh()           — execute, return stdout
sshSafe()       — execute, return {ok, stdout, stderr, exitCode} (no throw)
sshStream()     — pipe output to terminal (for logs -f), catch Ctrl+C gracefully
sshInteractive()— allocate PTY for shell access (-t flag)
dockerCompose() — wrapper: cd + sudo -u openclaw docker compose <subcmd>
gatewayExec()   — sudo docker exec openclaw-gateway <cmd>
openclawCmd()   — gatewayExec('openclaw <args>') convenience wrapper
```

### Config loading (`config.ts`)

Manual KEY=VALUE parser (not dotenv) — avoids leaking `ANTHROPIC_API_KEY` into `process.env` for child processes. Resolves config path relative to project root (walk up from `cli/`). Validates required fields: `VPS1_IP`, `VPS2_IP`, `SSH_KEY_PATH`, `SSH_USER`, `SSH_PORT`.

### Status dashboard

Runs ~12 checks in parallel via `Promise.allSettled()` across both VPSs. Displays colored pass/fail with detail strings. This is the "at a glance" view.

### Menu loop

After each action, returns to the current submenu (or main menu). Streaming ops (logs -f) exit on Ctrl+C and return to menu. The loop runs until user selects Exit.

## Critical Files Referenced

- `openclaw-config.env` — config source (read by `config.ts`)
- `playbooks/07-verification.md` — all checks replicated by `verify.ts`
- `playbooks/04-vps1-openclaw.md` — VPS-1 container names, compose paths, health endpoints
- `playbooks/05-vps2-observability.md` — VPS-2 service names, bind addresses, health URLs
- `.state/15.204.238.129.md` — documents `adminclaw` cd restriction

## Implementation Order

1. `package.json`, `tsconfig.json`, `cli.mjs` — project scaffold, install deps
2. `types.ts`, `config.ts` — types and config loading
3. `ssh.ts` — SSH helpers (foundation)
4. `ui.ts` — formatting utilities
5. `main.ts` — entry point with menu loop + direct command dispatch
6. `commands/openclaw.ts` — OpenClaw CLI submenu (fulfills the TODO.md item, highest priority)
7. `commands/status.ts` — status dashboard (validates SSH infra end-to-end)
8. `commands/gateway.ts` — gateway Docker submenu
9. `commands/monitoring.ts` — monitoring submenu
10. `commands/infra.ts` — infrastructure checks
11. `commands/otel.ts` — OTEL checks
12. `commands/backups.ts` — backup operations
13. `commands/verify.ts` — full verification suite

## Verification

1. Run `cd cli && npm install` — deps install cleanly
2. Run `./cli.mjs` — interactive menu appears, config loads from `../openclaw-config.env`
3. Select "OpenClaw > Status & Health > Status" — runs `openclaw status --all` in container, output displayed
4. Select "OpenClaw > Run custom command" — type `config get browser.enabled`, output shown
5. Run `./cli.mjs oc status` — direct command mode for openclaw commands works
6. Select "Status Overview" — SSH connects to both VPSs, dashboard renders
7. Test "Gateway > View logs > Follow" — streams live, Ctrl+C returns to menu
8. Run `./cli.mjs verify` — full verification suite runs
