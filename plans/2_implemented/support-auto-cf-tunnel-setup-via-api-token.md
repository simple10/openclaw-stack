# Automated Cloudflare Tunnel Setup via CF API Token

## Context

Currently, setting up a Cloudflare tunnel requires manual steps in the CF Dashboard: creating a tunnel, copying the token, configuring public hostname routes, and creating DNS records. With multiple claws, this multiplies the manual work — each instance needs dashboard + gateway routes plus CNAME records.

Adding `CF_API_TOKEN` support lets Claude automate all of this: discover/create tunnels, configure routes for every claw, and create DNS records — all via the CF API. The user only needs to create an API token with the right permissions and set their domains.

**SSL constraint**: Cloudflare only auto-generates SSL certs for subdomains (2nd-level), not 3rd-level (e.g., `personal.openclaw.example.com`). Each claw must use a single-level subdomain like `openclaw-personal.example.com`. A wildcard CF Access application (e.g., `openclaw*.example.com`) can cover all claws.

---

## Design Decisions

**Helper script vs inline playbook**: Create `deploy/scripts/cf-tunnel-setup.sh` because:

- Complex CF API logic (~200 lines) doesn't belong inline in playbook heredocs
- Reusable: called during fresh deploy AND when adding new instances later
- Can be integrated with `openclaw-multi.sh` (replace `tunnel-config` print-only with actual API calls)
- Runs locally (CF API calls from deploying machine, not VPS)

**Playbook placement**: Integrate into `00-fresh-deploy-setup.md` as a new § 0.2b (after config validation, before SSH check). When CF_API_TOKEN is set, Claude runs the script to auto-configure everything. When only CF_TUNNEL_TOKEN is set, behavior is unchanged (manual flow).

---

## Implementation Steps

### Step 1: Create `deploy/scripts/cf-tunnel-setup.sh`

Local helper script (~200-250 lines). Uses `curl` + `jq` for CF API v4 calls.

**Commands:**

| Command | Description |
|---------|-------------|
| `verify` | Verify API token has required permissions (tunnel edit + DNS edit) |
| `list-tunnels` | List active tunnels in the account |
| `create-tunnel <name>` | Create a new tunnel, output tunnel ID + token |
| `get-token <tunnel-id>` | Get the connector install token for an existing tunnel |
| `setup-routes` | Read all claw configs, configure tunnel ingress rules + create DNS CNAMEs |
| `setup-routes --instance <name>` | Configure routes for a single instance only |

**Key implementation details:**

- **Auth**: `Authorization: Bearer ${CF_API_TOKEN}` header on all requests
- **Account ID discovery**: `GET /accounts` → extract `result[0].id` (most users have one account)
- **Zone ID discovery**: Extract root domain from `OPENCLAW_DOMAIN` (last two parts), then `GET /zones?name=<root>` → `result[0].id`
- **Tunnel config**: `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` with ingress array
- **DNS records**: `POST /zones/{zone_id}/dns_records` — CNAME pointing subdomain to `{tunnel_id}.cfargotunnel.com`, proxied=true
- **Idempotent**: Check existing DNS records before creating (skip if CNAME already exists for subdomain)
- **Ingress rule ordering**: Dashboard paths MUST come before catch-all gateway rules (CF evaluates top-to-bottom)
- **Catch-all rule**: Required as last ingress entry: `{"service": "http_status:404"}`

**`setup-routes` flow:**

1. Load `openclaw-config.env` for shared config
2. Discover instances from `deploy/openclaws/*/` (same logic as `openclaw-multi.sh`)
3. For single-instance mode (no instance dirs): use `OPENCLAW_DOMAIN` from main config
4. Determine tunnel ID — from CF_TUNNEL_TOKEN (decode base64 JWT → extract tunnel ID from `t` claim) or from `--tunnel-id` flag
5. GET current tunnel config to preserve any existing non-openclaw rules
6. Build ingress rules for each instance:

   ```json
   {"hostname": "openclaw-personal.example.com", "path": "dashboard", "service": "http://localhost:6090"}
   {"hostname": "openclaw-personal.example.com", "service": "http://localhost:18789"}
   ```

7. PUT combined ingress config (existing non-claw rules + new claw rules + catch-all)
8. For each instance subdomain, create CNAME DNS record if not exists

**Subdomain validation**: Warn if any `OPENCLAW_DOMAIN` contains 3+ dots (3rd-level subdomain — SSL won't auto-provision).

**Interface:**

```
Env vars: CF_API_TOKEN, CF_TUNNEL_TOKEN (optional — for tunnel ID extraction)
Stdin: none
Stdout: structured output (JSON for programmatic use, human-readable summaries)
Stderr: progress messages
Exit: 0 success, 1 failure
```

### Step 2: Update `openclaw-config.env.example`

Add `CF_API_TOKEN` alongside `CF_TUNNEL_TOKEN`:

```bash
# === CLOUDFLARE TUNNEL ===
# Option A: Manual tunnel token (create tunnel in CF Dashboard, paste token)
CF_TUNNEL_TOKEN=                   # See docs/CLOUDFLARE-TUNNEL.md

# Option B: API token (Claude auto-creates tunnel + routes + DNS records)
# Create at: https://dash.cloudflare.com/profile/api-tokens
# Required permissions:
#   Account > Cloudflare Tunnel > Edit
#   Zone > DNS > Edit (specific zone for your domain)
# When set, Claude will prompt to use an existing tunnel or create a new one,
# then auto-configure routes and DNS for all claws.
CF_API_TOKEN=
```

Update the validation comment: `CF_TUNNEL_TOKEN` OR `CF_API_TOKEN` required (not both mandatory).

### Step 3: Update `playbooks/00-fresh-deploy-setup.md`

**§ 0.2 — Config validation**: Change `CF_TUNNEL_TOKEN` from required to conditional:

- One of `CF_TUNNEL_TOKEN` or `CF_API_TOKEN` must be non-empty
- If both empty: error with guidance on both options

**New § 0.2b — Automated Tunnel Setup** (after § 0.2, before § 0.3):

When `CF_API_TOKEN` is set:

1. Run `cf-tunnel-setup.sh verify` — confirm token has required permissions
2. Run `cf-tunnel-setup.sh list-tunnels` — show existing tunnels
3. Prompt user: use existing tunnel or create new one
   - If existing: user selects from list
   - If new: ask for tunnel name (default: `openclaw`), run `cf-tunnel-setup.sh create-tunnel <name>`
4. Get tunnel token: `cf-tunnel-setup.sh get-token <tunnel-id>`
5. Write `CF_TUNNEL_TOKEN=<token>` to `openclaw-config.env`
6. Run `cf-tunnel-setup.sh setup-routes` — configures all ingress rules + DNS records
7. Report what was configured (routes, DNS records)

When `CF_API_TOKEN` is NOT set: Skip § 0.2b entirely (manual flow unchanged).

**§ 0.5 — Cloudflare Access verification**: Add note about wildcard Access applications:

> When using `CF_API_TOKEN` with multiple claws, a single Cloudflare Access application
> with a wildcard domain (e.g., `openclaw*.example.com` or `*claw.example.com`) can
> protect all instance subdomains. This must still be configured manually in the
> CF Dashboard before deployment.

### Step 4: Update `deploy/openclaws/_example/config.env`

Update the domain example to use a single-level subdomain (not 3rd-level):

```bash
# Domain — must be a single-level subdomain (NOT 3rd-level like personal.openclaw.example.com)
# Cloudflare only auto-generates SSL for subdomains, not deeper levels.
# Good: openclaw-personal.example.com, personalclaw.example.com
# Bad:  personal.openclaw.example.com (3rd-level, no auto SSL)
OPENCLAW_DOMAIN=example-openclaw.example.com
OPENCLAW_DASHBOARD_DOMAIN=example-openclaw.example.com
```

(This already matches what's there — just add the SSL warning comment.)

### Step 5: Update `docs/CLOUDFLARE-TUNNEL.md`

Add a new section **"Automated Setup (CF_API_TOKEN)"** before the existing manual instructions:

- Explain the two options (manual token vs API token)
- Document required API token permissions (with screenshot reference)
- Show the automated flow
- Note: CF Access still needs manual setup (wildcard application recommended)
- Link to the API token creation page: `https://dash.cloudflare.com/profile/api-tokens`

### Step 6: Update `openclaw-multi.sh` tunnel-config command

When `CF_API_TOKEN` is available, enhance `tunnel-config` to offer:

- Current behavior (print rules) when no API token
- `tunnel-config --apply` to actually configure routes via `cf-tunnel-setup.sh setup-routes`

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `deploy/scripts/cf-tunnel-setup.sh` | **CREATE** | CF API helper script (~200-250 lines) |
| `openclaw-config.env.example` | **MODIFY** | Add CF_API_TOKEN option |
| `playbooks/00-fresh-deploy-setup.md` | **MODIFY** | Conditional validation + new § 0.2b for auto-setup |
| `deploy/openclaws/_example/config.env` | **MODIFY** | Add SSL subdomain warning comment |
| `docs/CLOUDFLARE-TUNNEL.md` | **MODIFY** | Add automated setup section |
| `deploy/scripts/openclaw-multi.sh` | **MODIFY** | Enhance tunnel-config with --apply |

---

## Per-Instance CF_TUNNEL_TOKEN Override

Each claw's `config.env` can optionally set `CF_TUNNEL_TOKEN` to use a different tunnel. The `setup-routes` command in `cf-tunnel-setup.sh` handles this by:

1. Grouping instances by tunnel (instances sharing a tunnel get combined ingress rules)
2. Configuring each tunnel separately
3. Creating DNS CNAMEs pointing to the correct tunnel ID per instance

Default: all claws use the shared `CF_TUNNEL_TOKEN` from `openclaw-config.env`.

---

## Verification

1. `cf-tunnel-setup.sh verify` — token permissions OK
2. `cf-tunnel-setup.sh list-tunnels` — shows account tunnels
3. `cf-tunnel-setup.sh setup-routes` — configures routes, creates DNS records, outputs summary
4. `curl -sI https://<claw-subdomain>/` — returns 302 to CF Access login
5. After VPS deploy: cloudflared connects, traffic flows through tunnel to gateway containers
