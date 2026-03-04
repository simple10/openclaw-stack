# Scripts Reference

CLI scripts for managing an OpenClaw VPS stack without Claude. All scripts live in [`scripts/`](../scripts/) — see the comment header at the top of each file for the most up-to-date usage.

Most scripts auto-detect the target claw when only one is configured. For multi-claw stacks, use `--instance <name>` to target a specific claw.

---

## Deployment

### `deploy.sh`

Full deployment orchestrator: builds artifacts, syncs everything to VPS, and auto-restarts services that need it.

```
scripts/deploy.sh [options]
```

| Flag | Description |
|------|-------------|
| `--instance <claw>` | Deploy one claw only (default: all) |
| `--force` | Overwrite VPS configs (skip drift detection) |
| `--no-restart` | Sync only, print restart instructions |
| `-y, --yes` | Skip confirmation prompt |
| `-n, --dry-run` | Preview only (no transfers, no restart) |

### `sync-claw-config.sh`

Push a single claw's `openclaw.jsonc` config to VPS. No stack-level syncs, no drift detection. For quick config iterations.

```
scripts/sync-claw-config.sh <claw> [options]
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Auto-restart if config changes require it |
| `--restart` | Always restart after sync |
| `--no-restart` | Sync only, skip restart |
| `-n, --dry-run` | Preview only |

### `sync-deploy.sh`

Lower-level sync of `.deploy/` artifacts to VPS. Usually called by `deploy.sh` rather than directly.

```
scripts/sync-deploy.sh [options]
```

| Flag | Description |
|------|-------------|
| `--all` | Stack files + all instance configs |
| `--instance <name>` | Stack files + one instance's config |
| `--fresh` | Implies `--all`, prints post-sync next-steps |
| `--force` | Skip drift detection |
| `-n, --dry-run` | Preview without transferring |

### `tag-deploy.sh`

Tag the current deployment as successful on the VPS.

```
scripts/tag-deploy.sh [message]
```

---

## SSH & Shell Access

### `ssh-vps.sh`

SSH to the VPS host as `adminclaw`.

```
scripts/ssh-vps.sh
```

### `ssh-openclaw.sh`

Interactive shell inside a gateway container.

```
scripts/ssh-openclaw.sh [--instance <name>]
```

### `ssh-agent.sh`

SSH into an agent's sandbox container. Shows available agents and lets you pick one. Triggers sandbox creation if needed.

```
scripts/ssh-agent.sh [agent-name] [--instance <name>]
```

---

## Logs & Monitoring

### `logs-openclaw.sh`

Stream logs from a gateway container.

```
scripts/logs-openclaw.sh [tail-count] [--no-follow] [--instance <name>]
```

| Argument | Description |
|----------|-------------|
| `[tail-count]` | Show last N lines then follow (default: 100) |
| `--no-follow` | Dump all logs and exit |

### `logs-docker.sh`

Stream logs from all Docker containers on the VPS.

```
scripts/logs-docker.sh [tail-count | --no-follow]
```

### `logs-explorer.sh`

TUI for browsing OpenClaw session JSONL files and LLM logs.

```
scripts/logs-explorer.sh [command] [options]
```

| Command | Description |
|---------|-------------|
| *(none)* | Interactive TUI (requires bun) |
| `list` | List sessions |
| `trace <session-id>` | Session details |
| `metrics <session-id>` | Session metrics |
| `errors <session-id>` | Session errors |
| `summary` | Agent summary |
| `llm-list` | List LLM calls |
| `llm-trace <session-id>` | LLM trace for session |
| `llm-summary` | LLM statistics |

| Flag | Description |
|------|-------------|
| `--instance <name>` | Select claw |
| `--agent <name>` | Filter by agent |
| `--full` | Show full details |
| `--json` | JSON output |
| `--no-color` | Disable colors |

### `health-check.sh`

Check Docker container status, healthcheck results, restart history, and gateway health.

```
scripts/health-check.sh [options]
```

| Flag | Description |
|------|-------------|
| `-q, --quiet` | Exit code only (0 = healthy, 1 = unhealthy) |
| `--instance <name>` | Target specific instance |

---

## Updates

### `update-openclaw.sh`

Pull latest OpenClaw source and rebuild the gateway Docker image. Brief downtime during container swap (~5-10s).

```
scripts/update-openclaw.sh [--instance <name>]
```

### `update-sandbox-toolkit.sh`

Sync sandbox toolkit files to VPS and rebuild sandbox images.

```
scripts/update-sandbox-toolkit.sh [options]
```

| Flag | Description |
|------|-------------|
| *(none)* | Detect changes + quick-layer |
| `--full` | Full rebuild of packages + toolkit layers |
| `--all` | Also rebuild browser sandbox (with `--full`) |
| `--sync-only` | Sync files + regenerate shims, skip image rebuild |
| `--dry-run` | Show what would happen |
| `--instance <name>` | Target specific instance |

### `update-sandboxes.sh`

Force-rebuild sandbox images without gateway downtime.

```
scripts/update-sandboxes.sh [options]
```

| Flag | Description |
|------|-------------|
| `--all` | Also rebuild browser sandbox |
| `--dry-run` | Show what would be rebuilt |
| `--instance <name>` | Target specific instance |

---

## Service Management

### `restart-gateway.sh`

Restart the gateway container. Needed after config changes that aren't hot-reloadable.

```
scripts/restart-gateway.sh [--instance <name>]
```

### `restart-sandboxes.sh`

Remove running sandbox containers so OpenClaw recreates them from current images.

```
scripts/restart-sandboxes.sh [options]
```

| Flag | Description |
|------|-------------|
| `--all` | Also restart browser sandboxes |
| `--dry-run` | Show what would be removed |
| `-f, --force` | Skip confirmation prompt |
| `--instance <name>` | Target specific instance |

### `start-browser.sh`

Start a browser container for an agent and print the dashboard URL.

```
scripts/start-browser.sh [agent-name] [--instance <name>]
```

### `message-agents.sh`

Send a message to all agents for a given claw. Also seeds agent workspace files (AGENTS.md, SOUL.md, etc.) for any agents that haven't been invoked yet.

```
scripts/message-agents.sh <claw> "message" [options]
```

| Flag | Description |
|------|-------------|
| `--agent <id>` | Target a single agent instead of all |
| `--timeout <seconds>` | Per-agent timeout |

---

## Data & Config Sync

### `openclaw.sh`

Run `openclaw` CLI commands on the VPS via SSH.

```
scripts/openclaw.sh [--instance <name>] <command> [args...]
```

Examples:

```bash
scripts/openclaw.sh status
scripts/openclaw.sh doctor --deep
scripts/openclaw.sh security audit --deep
scripts/openclaw.sh devices list
```

### `sync-media.sh`

Download agent media files from VPS to local `./media/`.

```
scripts/sync-media.sh [--instance <name>] [local-path]
```

### `sync-workspaces.sh`

Bidirectional sync of agent workspace files between local and VPS.

```
scripts/sync-workspaces.sh <up|down> [options]
```

| Flag | Description |
|------|-------------|
| `--instance <name>` | Target specific claw (default: all) |
| `--force` | Skip conflict resolution, force overwrite |
| `--all` | (down mode) Sync all files, not just `.md` files |
| `-y, --yes` | Auto-accept conflicts |

### `sync-down-configs.sh`

Download live configs from VPS. Saves as `openclaw.live-version.jsonc` with diff summary if local config already exists.

```
scripts/sync-down-configs.sh [--instance <name>]
```

---

## Infrastructure

### `cf-tunnel-setup.sh`

Automated Cloudflare Tunnel configuration via API. Discovers claws from `.deploy/stack.json` and configures tunnel ingress + DNS.

```
scripts/cf-tunnel-setup.sh <command> [options]
```

| Command | Description |
|---------|-------------|
| `verify` | Verify API token permissions |
| `list-tunnels` | List active tunnels |
| `create-tunnel <name>` | Create a new tunnel |
| `get-token <tunnel-id>` | Get connector install token |
| `setup-routes` | Configure tunnel ingress + DNS for all claws |

| Flag | Description |
|------|-------------|
| `--instance <name>` | Configure routes for one claw only |
| `--tunnel-id <id>` | Override tunnel ID |

Requires `CF_API_TOKEN` environment variable.

### `telegram-test.sh`

Send a test message to Telegram using stack.env settings.

```
scripts/telegram-test.sh [message]
```

---

Browse all scripts: [`scripts/`](../scripts/)
