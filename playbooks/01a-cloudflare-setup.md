# 01a - Cloudflare Tunnel & Access Setup (Automated)

Automates Cloudflare Tunnel creation, hostname routing, DNS records, and Access application setup via the Cloudflare API. Replaces manual Dashboard configuration described in [`docs/CLOUDFLARE-TUNNEL.md`](../docs/CLOUDFLARE-TUNNEL.md).

## Overview

This playbook uses the Cloudflare API v4 to:

1. Create a Cloudflare Tunnel (or reuse an existing one)
2. Configure public hostname routes (ingress rules)
3. Create DNS CNAME records pointing to the tunnel
4. Create a Cloudflare Access application protecting the domain
5. Create an Access policy allowing specified users
6. Verify One-time PIN login method is available
7. Write `CF_TUNNEL_TOKEN` and `CF_ACCESS_AUD` back to `openclaw-config.env`

All steps are **idempotent** — re-running the playbook will detect existing resources and reuse them.

## Prerequisites

From `../openclaw-config.env`:

- `CF_API_TOKEN` — Cloudflare API Token (see [Required API Token Permissions](#required-api-token-permissions) below)
- `CF_ACCOUNT_ID` — Cloudflare Account ID (found on any zone's Overview page in the Dashboard sidebar)
- `OPENCLAW_DOMAIN` — Gateway domain (e.g., `openclaw.example.com`)
- `OPENCLAW_DASHBOARD_DOMAIN` — Dashboard domain (same as above for path-based routing)
- `OPENCLAW_DASHBOARD_DOMAIN_PATH` — Dashboard path (e.g., `/dashboard`), empty if using separate subdomain
- `OPENCLAW_DOMAIN_PATH` — Gateway UI subpath (usually empty)

Optional:

- `CF_TUNNEL_NAME` — Tunnel name (default: `openclaw`)
- `CF_ACCESS_ALLOWED_EMAILS` — Comma-separated emails for Access policy (prompted if empty)
- `CF_ACCESS_SESSION_DURATION` — Access session duration (default: `24h`)

## Required API Token Permissions

Create a **Custom API Token** at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

| Permission | Access Level | Why |
|-----------|-------------|-----|
| Account · Cloudflare Tunnel | Edit | Create/configure tunnels |
| Account · Access: Apps and Policies | Edit | Create Access applications and policies |
| Account · Access: Identity Providers | Edit | Check/create identity providers (OTP, GitHub, Google, etc.) |
| Zone · DNS | Edit | Create CNAME records for tunnel routing |
| Account · Workers Scripts | Edit | Deploy workers and manage secrets (provider API keys) |


**Account resources:** Include the specific account (or all accounts).
**Zone resources:** Include the zone containing your domain (or all zones).

> **Tip:** The "Edit a tunnel" template in the token creation wizard covers the Tunnel permission. You'll need to add Access and DNS permissions manually.

---

## 1a.1 Validate API Token

Test that the API token is valid and active:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/user/tokens/verify"
```

**Expected:** `{"result":{"status":"active"},"success":true}`

**If `success` is false or `status` is not `active`:**

> "Your Cloudflare API token is invalid or inactive. Check that:
>
> - The token was copied correctly (no trailing spaces)
> - The token hasn't been revoked
> - You're using an API Token (starts with random characters), not the Global API Key
>
> Create a new token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
> with the permissions listed in this playbook."

Stop and wait for user to fix.

### Validate Account Access

Verify the account ID is correct and accessible:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>"
```

**Expected:** `{"success":true}` with the account details in `result`.

**If `success` is false:**

> "Cannot access Cloudflare account `<CF_ACCOUNT_ID>`. Verify the account ID is correct
> (found on any zone's Overview page in the Dashboard sidebar, labeled 'Account ID')
> and that your API token has access to this account."

---

## 1a.2 Resolve Zone ID

Look up the zone ID for the domain. List zones under the account and find the one matching the configured domain:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/zones?account.id=<CF_ACCOUNT_ID>&per_page=50&status=active"
```

From the response, identify the zone whose `name` is a suffix of `OPENCLAW_DOMAIN`. For example:

- If `OPENCLAW_DOMAIN=openclaw.example.com`, the matching zone name is `example.com`
- If `OPENCLAW_DOMAIN=app.proclaw.co`, the matching zone name is `proclaw.co`

Save the zone ID for subsequent steps.

**If no matching zone is found:**

> "No active Cloudflare zone found that matches domain `<OPENCLAW_DOMAIN>`. Available zones
> for this account: [list zone names]. Verify that:
>
> - The domain in `OPENCLAW_DOMAIN` is correct
> - The domain's DNS is managed by Cloudflare
> - The zone is active (not pending)"

**If `OPENCLAW_DASHBOARD_DOMAIN` has a different root domain** than `OPENCLAW_DOMAIN`, resolve its zone ID too (may be the same zone or different).

---

## 1a.3 Create or Reuse Tunnel

### Check for Existing Tunnel

Query for a tunnel with the configured name:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel?name=<CF_TUNNEL_NAME>&is_deleted=false"
```

- **If a tunnel with this name exists:** Reuse it. Save the tunnel `id` from the response. Report: "Found existing tunnel `<CF_TUNNEL_NAME>` (ID: `<tunnel_id>`). Reusing."
- **If no tunnel exists:** Create one (next step).

### Create Tunnel

Generate a 32-byte random secret (base64-encoded) and create the tunnel:

```bash
# Generate tunnel secret
TUNNEL_SECRET=$(openssl rand -base64 32)

# Create tunnel
curl -s -X POST \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel" \
  -d '{"name":"<CF_TUNNEL_NAME>","tunnel_secret":"'"$TUNNEL_SECRET"'","config_src":"cloudflare"}'
```

**Expected:** `{"success":true,"result":{"id":"<tunnel_id>","name":"<CF_TUNNEL_NAME>",...}}`

Save the tunnel `id` from the response.

**If creation fails with "A tunnel with this name already exists but is in a deleted state":**

The tunnel was previously soft-deleted. Clean it up and retry:

```bash
# List deleted tunnels with this name
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel?name=<CF_TUNNEL_NAME>&is_deleted=true"

# Permanently delete the old tunnel (using its ID from the response above)
curl -s -X DELETE \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel/<old_tunnel_id>"
```

Then retry tunnel creation.

### Get Tunnel Token

Retrieve the token for `cloudflared` to connect:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel/<tunnel_id>/token"
```

**Expected:** `{"success":true,"result":"eyJ..."}` — the `result` field is the tunnel token string.

Save this token — it will be written to `CF_TUNNEL_TOKEN` in the config.

---

## 1a.4 Configure Tunnel Ingress Rules

Build the ingress configuration based on whether the gateway and dashboard use the same subdomain or separate subdomains.

### Detect Routing Mode

- **Same subdomain (Option A):** `OPENCLAW_DOMAIN` == `OPENCLAW_DASHBOARD_DOMAIN` (with or without `OPENCLAW_DASHBOARD_DOMAIN_PATH`)
- **Separate subdomains (Option B):** `OPENCLAW_DOMAIN` != `OPENCLAW_DASHBOARD_DOMAIN`

### Option A: Same Subdomain (Path-Based Routing)

Dashboard and gateway share one hostname. The dashboard rule (more specific, with path) **must come first**.

Strip the leading `/` from `OPENCLAW_DASHBOARD_DOMAIN_PATH` for the tunnel path field (e.g., `/dashboard` → `dashboard`).

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel/<tunnel_id>/configurations" \
  -d '{
    "config": {
      "ingress": [
        {
          "hostname": "<OPENCLAW_DASHBOARD_DOMAIN>",
          "path": "<DASHBOARD_PATH_WITHOUT_LEADING_SLASH>",
          "service": "http://localhost:6090"
        },
        {
          "hostname": "<OPENCLAW_DOMAIN>",
          "service": "http://localhost:18789"
        },
        {
          "service": "http_status:404"
        }
      ]
    }
  }'
```

> **Rule order matters.** The dashboard path rule must be listed before the catch-all gateway rule. Cloudflare evaluates rules top-to-bottom and uses the first match.

### Option B: Separate Subdomains

Each service gets its own hostname. No path-based routing needed.

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel/<tunnel_id>/configurations" \
  -d '{
    "config": {
      "ingress": [
        {
          "hostname": "<OPENCLAW_DASHBOARD_DOMAIN>",
          "service": "http://localhost:6090"
        },
        {
          "hostname": "<OPENCLAW_DOMAIN>",
          "service": "http://localhost:18789"
        },
        {
          "service": "http_status:404"
        }
      ]
    }
  }'
```

### Verify Configuration

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/cfd_tunnel/<tunnel_id>/configurations"
```

Confirm the ingress rules match what was just configured.

---

## 1a.5 Create DNS Records

Create CNAME records pointing the domain(s) to the tunnel. The CNAME target is `<tunnel_id>.cfargotunnel.com`.

### Check for Existing DNS Record

For each unique hostname (`OPENCLAW_DOMAIN` and, if different, `OPENCLAW_DASHBOARD_DOMAIN`):

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/zones/<zone_id>/dns_records?type=CNAME&name=<hostname>"
```

- **If a CNAME record exists pointing to `<tunnel_id>.cfargotunnel.com`:** Already correct. Skip.
- **If a CNAME record exists pointing elsewhere:** Update it (the user may have a stale record from a previous tunnel). Use the record `id` from the response:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/<zone_id>/dns_records/<record_id>" \
  -d '{"type":"CNAME","name":"<hostname>","content":"<tunnel_id>.cfargotunnel.com","proxied":true}'
```

- **If no CNAME record exists:** Create one:

```bash
curl -s -X POST \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/<zone_id>/dns_records" \
  -d '{"type":"CNAME","name":"<hostname>","content":"<tunnel_id>.cfargotunnel.com","proxied":true}'
```

> **`proxied: true` is required.** Cloudflare Tunnel only works with proxied (orange-cloud) DNS records. A DNS-only (grey-cloud) record would expose the origin IP or fail to route.

**If the record creation fails with a conflict** (e.g., an A record already exists for this hostname):

> "A DNS record already exists for `<hostname>` that conflicts with the CNAME. You may have
> an A record pointing directly to the VPS IP. The existing record needs to be removed first.
>
> Existing record: [show type, name, content from the API response]
>
> Should I delete the existing record and create the tunnel CNAME?"

Wait for user confirmation before deleting the conflicting record.

### Verify DNS Propagation

After creating/updating records, verify they resolve:

```bash
dig +short <hostname>
```

The response should show a Cloudflare IP (the CNAME is resolved through Cloudflare's proxy). If it shows `NXDOMAIN` or the wrong IP, DNS may not have propagated yet — this is normal and may take a few minutes.

---

## 1a.6 Create Access Application

### Check for Existing Access Application

List Access applications and check if one already exists for the domain:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/apps"
```

Search the `result` array for an application where `domain` matches `OPENCLAW_DOMAIN`.

- **If found:** Reuse it. Save the `id` and `aud` from the matching application. Report: "Found existing Access application `<app_name>` for `<domain>`. Reusing."
- **If not found:** Create one (next step).

### Create Access Application

```bash
curl -s -X POST \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/apps" \
  -d '{
    "name": "OpenClaw (<OPENCLAW_DOMAIN>)",
    "domain": "<OPENCLAW_DOMAIN>",
    "type": "self_hosted",
    "session_duration": "<CF_ACCESS_SESSION_DURATION:24h>",
    "auto_redirect_to_identity": false
  }'
```

**Expected:** `{"success":true,"result":{"id":"<app_id>","aud":"<aud_tag>",...}}`

Save `id` (for creating policies) and `aud` (for `CF_ACCESS_AUD` in config).

### Separate Subdomain: Create Second Access Application

If `OPENCLAW_DASHBOARD_DOMAIN` differs from `OPENCLAW_DOMAIN`, the dashboard needs its own Access application:

```bash
curl -s -X POST \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/apps" \
  -d '{
    "name": "OpenClaw Dashboard (<OPENCLAW_DASHBOARD_DOMAIN>)",
    "domain": "<OPENCLAW_DASHBOARD_DOMAIN>",
    "type": "self_hosted",
    "session_duration": "<CF_ACCESS_SESSION_DURATION:24h>",
    "auto_redirect_to_identity": false
  }'
```

Save the second app's `id` for policy creation.

---

## 1a.7 Create Access Policy

Each Access application needs at least one Allow policy.

### Resolve Allowed Emails

Read `CF_ACCESS_ALLOWED_EMAILS` from config. If empty, **ask the user:**

> "Which email addresses should be allowed through Cloudflare Access?
>
> Enter comma-separated emails (e.g., `alice@example.com,bob@example.com`)
> or an email domain to allow everyone at that domain (e.g., `@example.com`):"

Wait for user input.

### Build Include Rules

Parse the email list and build the policy `include` array:

- **Individual email** (e.g., `alice@example.com`): `{"email":{"email":"alice@example.com"}}`
- **Email domain** (starts with `@`, e.g., `@example.com`): `{"email_domain":{"domain":"example.com"}}`

### Create Policy for Gateway Access Application

```bash
curl -s -X POST \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/apps/<app_id>/policies" \
  -d '{
    "name": "Allow specified users",
    "decision": "allow",
    "include": [
      <...include rules from above...>
    ]
  }'
```

**Expected:** `{"success":true,"result":{"id":"<policy_id>",...}}`

### Create Policy for Dashboard Access Application (Separate Subdomain Only)

If a second Access application was created in 1a.6, create the same policy for it using the second app's `id`.

### Idempotency: Existing Policies

Before creating a policy, check if the application already has policies:

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/apps/<app_id>/policies"
```

If an Allow policy already exists, report it and skip creation:

> "Access application already has an Allow policy: `<policy_name>`. Skipping policy creation.
> To modify the policy, use the Cloudflare Dashboard or re-create it via the API."

---

## 1a.8 Verify One-Time PIN Login Method

One-time PIN (email code) is the simplest identity provider and requires zero external configuration.

### Check Available Login Methods

```bash
curl -s -H "Authorization: Bearer <CF_API_TOKEN>" \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>/access/identity_providers"
```

Search for a provider with `"type": "otp"` in the response.

- **If OTP provider found:** One-time PIN is available. Report: "One-time PIN login is available."
- **If OTP provider not found:** Report:

> "One-time PIN (email code) login method is not configured in your Cloudflare Zero Trust account.
> This is the simplest login method — Cloudflare emails a code to the user, no external IdP needed.
>
> You can enable it in the Cloudflare Dashboard:
> Zero Trust → Settings → Authentication → Login methods → Add new → One-time PIN
>
> Alternatively, configure a different identity provider (Google, GitHub, Okta, etc.)
> through the Dashboard."

This is informational — deployment can continue even without OTP if another IdP is configured.

---

## 1a.9 Update Config

Write the automation results back to `openclaw-config.env`:

### CF_TUNNEL_TOKEN

Update the `CF_TUNNEL_TOKEN` line with the tunnel token retrieved in 1a.3.

### CF_ACCESS_AUD (Optional)

If the `CF_ACCESS_AUD` variable exists in the config (or as a comment), write the AUD tag from the Access application created in 1a.6. This is used for multi-instance JWT validation hardening.

If `CF_ACCESS_AUD` is not in the config, add it as a comment in the deployment record section:

```bash
# DEPLOYED: CF_ACCESS_AUD=<aud_tag>
```

### Verify Config

After writing, re-read `CF_TUNNEL_TOKEN` from the config and verify it's non-empty and doesn't contain angle-bracket placeholders.

---

## 1a.10 Verify Access Protection

Confirm the domain is now protected by Cloudflare Access. This verifies the full chain: DNS → Cloudflare → Access.

```bash
curl -sI --connect-timeout 10 "https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/" 2>&1 | head -10
```

**Expected:** HTTP 302 or 403 with a `location` header containing `cloudflareaccess.com` or `access.`.

> **Note:** The tunnel is not running on the VPS yet (that's set up in `04-vps1-openclaw.md`), so
> requests that pass Access authentication will get a 502 from Cloudflare. This is expected.
> What matters here is that unauthenticated requests are blocked by Access.

**If the response is not a 302/403 redirect to Access:**

DNS propagation may not be complete. Wait 30 seconds and retry up to 3 times. If still failing:

> "The domain `<OPENCLAW_DOMAIN>` is not returning a Cloudflare Access redirect.
> This could mean:
>
> - DNS hasn't propagated yet (CNAME was just created — may take 1-5 minutes)
> - The Access application isn't matching this domain
> - The zone isn't active on Cloudflare
>
> Check DNS: `dig +short <OPENCLAW_DOMAIN>`
> Expected: A Cloudflare IP address (e.g., 104.x.x.x or 172.x.x.x)
>
> You can continue the deployment — the tunnel will work once DNS propagates.
> Re-verify with `07-verification.md` after deployment."

This is a **non-blocking warning** — deployment can continue.

### Also Verify Dashboard Domain (If Separate)

If `OPENCLAW_DASHBOARD_DOMAIN` differs from `OPENCLAW_DOMAIN`:

```bash
curl -sI --connect-timeout 10 "https://<OPENCLAW_DASHBOARD_DOMAIN><OPENCLAW_DASHBOARD_DOMAIN_PATH>/" 2>&1 | head -10
```

Same verification logic.

---

## Summary

After completing this playbook, the following should be in place:

| Resource | Status |
|----------|--------|
| Cloudflare Tunnel | Created (or reused), token saved to config |
| Hostname routes | Configured for gateway + dashboard |
| DNS CNAME(s) | Created (or updated) pointing to tunnel |
| Access application | Created (or reused) protecting the domain |
| Access policy | Created allowing specified users |
| `CF_TUNNEL_TOKEN` | Written to `openclaw-config.env` |
| `CF_ACCESS_AUD` | Written to `openclaw-config.env` (deployment record) |

The domain is now routable and protected by Cloudflare Access. VPS deployment can proceed.

---

## Troubleshooting

### "forbidden" Error on API Calls

The API token is missing required permissions. Check the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) and verify it has:

- Account · Cloudflare Tunnel · Edit
- Account · Access: Apps and Policies · Edit
- Zone · DNS · Edit

### "A tunnel with that name already exists"

A tunnel with this name was previously created. Either:

1. Reuse it: The playbook already handles this — check step 1a.3
2. Choose a different name: Change `CF_TUNNEL_NAME` in config
3. Delete the old tunnel: Use the Dashboard or API (see step 1a.3 for soft-deleted tunnels)

### DNS Record Conflicts

If an A record or other record type already exists for the hostname, it must be removed before the CNAME can be created. The playbook will detect this and ask for confirmation before deleting.

### Access Application Not Matching

If Access verification (1a.10) fails even though the app was created:

1. Verify the Access app domain matches exactly: `<OPENCLAW_DOMAIN>` (no protocol, no trailing slash)
2. Check if another Access app with a wildcard or overlapping domain exists
3. In the Dashboard, go to Zero Trust → Access → Applications and verify the app is listed

### "More than one account available" (Account Ambiguity)

If the API token has access to multiple accounts and `CF_ACCOUNT_ID` is not set correctly:

> "Your API token has access to multiple Cloudflare accounts. Make sure `CF_ACCOUNT_ID`
> in `openclaw-config.env` is set to the correct account ID. You can find it on any zone's
> Overview page in the Dashboard sidebar."
