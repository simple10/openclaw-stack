# Cloudflare Tunnel Setup for OpenClaw

This document describes how to secure OpenClaw behind Cloudflare Tunnel, eliminating the need to expose port 443 on the origin server.

## Why Cloudflare Tunnel?

| Before (Origin Exposed) | After (Tunnel) |
|------------------------|----------------|
| Port 443 open to internet | Port 443 closed |
| Origin IP discoverable | Origin IP hidden |
| Direct IP access possible | Direct IP access blocked |
| Cloudflare can be bypassed | All traffic through Cloudflare |

## Prerequisites

- Cloudflare account with your domain added
- Domain DNS managed by Cloudflare
- SSH access to VPS-1 (<adminclaw@15.204.xxx.xxx>, port 222)
- Cloudflare Access enabled in the Cloudflare account

## Architecture

```
┌─────────────────────────────────────────────────────────────-┐
│                         Internet                             │
│                                                              │
│    User ──► openclaw.yourdomain.com ──► Cloudflare Edge      │
│                                              │               │
│                                    Cloudflare Access         │
│                                        (auth check)          │
│                                              │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                              Encrypted Tunnel (outbound)
                                               │
┌──────────────────────────────────────────────┼───────────────┐
│  VPS-1 (Origin - No inbound ports needed)    │               │
│                                              ▼               │
│    cloudflared ◄─────────────────────────────┘               │
│        │                                                     │
│        ▼                                                     │
│    localhost:18789 (OpenClaw Gateway)                        │
│                                                              │
│    Port 443: CLOSED                                          │
│    Port 80:  CLOSED                                          │
└──────────────────────────────────────────────────────────────┘
```

## Creating the Tunnel Token

The tunnel uses a **token-based** approach — all configuration lives in the Cloudflare Dashboard. No `cert.pem`, `credentials.json`, or `config.yml` files are needed on the server.

### Step 1: Create the Tunnel

1. Go to [Cloudflare Dashboard](https://one.dash.cloudflare.com/) → **Zero Trust** → **Networks** → **Tunnels**
2. Click **Create a tunnel** → Choose **Cloudflared**
3. Name it (e.g., `openclaw`)

### Step 2: Copy the Token

On the tunnel install page, Cloudflare shows the install command containing the token:

```
sudo cloudflared service install eyJhIjoiYWJj...
```

Copy just the **token** part — the long base64 string starting with `ey...`.

### Step 3: Save Without Routes

**Skip** the public hostname configuration — save the tunnel without adding any routes. The domain will be connected later, after Cloudflare Access is configured, so the domain is never accessible without authentication.

### Step 4: Add the Token to Config

Paste the token into `openclaw-config.env`:

```bash
CF_TUNNEL_TOKEN=eyJhIjoiYWJj...  # Paste the full token here
```

> **Why token-based?** The older `cloudflared tunnel login` + `tunnel create` flow requires
> browser authentication on the VPS (a headless server), which means manually downloading
> `cert.pem` and uploading it. Token-based tunnels are created entirely in the Dashboard —
> no browser needed on the server.

### What Happens During Deployment

Claude installs `cloudflared` on the VPS and registers it as a systemd service using your token. The tunnel connects but has no public hostname yet — the domain won't be accessible until you configure Cloudflare Access and add the hostname route (see below).

---

## Cloudflare Access Configuration

Configure Cloudflare Access **before** connecting the domain to your tunnel. This ensures the domain is never publicly accessible without authentication.

**In Cloudflare Dashboard:** [one.dash.cloudflare.com](https://one.dash.cloudflare.com/)

### Step 1: Create an Access Application

This is where you put the lock on the door.

1. Go to **Zero Trust Dashboard** → **Access** → **Applications**
2. Click **Add an application** → choose **Self-hosted**
3. Configure the application:

| Field                | Value                              |
| -------------------- | ---------------------------------- |
| **Application name** | e.g. `OpenClaw`                      |
| **Session duration** | Choose based on your needs (e.g. `24h`) |
| **Application domain** | `openclaw.example.com`              |
| **Path** (optional)  | Leave blank to protect the entire subdomain, or set a specific path like `<OPENCLAW_DOMAIN_PATH>/` |

1. Click **Next**

---

### Step 2: Define an Access Policy

Policies control who gets through. You need at least one **Allow** policy.

1. **Policy name:** e.g. `Allow team members`
2. **Action:** `Allow`
3. **Configure rules** — add one or more *Include* conditions:

**Common Identity Rules:**

| Selector | Example | Use case |
| --- | --- | --- |
| **Emails** | `alice@example.com` | Allow specific individuals |
| **Emails ending in** | `@example.com` | Allow an entire domain |
| **Identity provider groups** | Google Workspace group, Okta group, etc. | Team-based access |
| **Everyone** | — | Allow all authenticated users (still forces login) |
| **IP ranges** | `203.0.113.0/24` | Network-based access |

You can also add **Require** rules (user must match *all* of these) and **Exclude** rules (deny even if other rules match).

#### Example: Allow Anyone with a Company Email

- **Include:** Emails ending in `@yourcompany.com`

#### Example: Restrict to Specific People + Require Country

- **Include:** Emails — `alice@example.com`, `bob@example.com`
- **Require:** Country — `United States`

1. Click **Next** → review → **Add application**

---

### Step 3: Configure an Identity Provider (if not already done)

Access needs at least one IdP to authenticate users. If you haven't set one up:

1. Go to **Zero Trust Dashboard** → **Settings** → **Authentication**
2. Under **Login methods**, click **Add new**
3. Choose a provider — common options:
   - **One-time PIN** (simplest — Cloudflare emails a code, no external IdP needed)
   - **Google**
   - **GitHub**
   - **Okta / Azure AD / SAML**
4. Follow the provider-specific setup (OAuth client ID/secret, etc.)

The **One-time PIN** option is great for getting started quickly — it requires zero external configuration.

### Step 4: Connect Your Domain

Now that Access is configured, add the public hostname route to make the domain accessible (behind Access):

1. Go to **Zero Trust Dashboard** → **Networks** → **Tunnels**
2. Click your tunnel → **Configure**
3. Add a public hostname:

| Field | Value |
|-------|-------|
| **Subdomain** | `openclaw` (or your choice) |
| **Domain** | Select your domain (e.g., `example.com`) |
| **Service Type** | `HTTP` |
| **URL** | `localhost:18789` |

1. Save

#### Browser VNC Access (Optional)

To view/control agent browser sessions remotely, add a second public hostname:

| Field | Value |
|-------|-------|
| **Subdomain** | `openclaw-browser` (or your choice) |
| **Domain** | Select your domain |
| **Service Type** | `HTTP` |
| **URL** | `localhost:6090` |

See [BROWSER-VNC.md](BROWSER-VNC.md) for details.

The domain is now routable — and protected by Cloudflare Access from the first request.

### Step 5: Test Access Protection

1. Open `https://openclaw.yourdomain.com<OPENCLAW_DOMAIN_PATH>/` in an incognito window
2. You should see the Cloudflare Access login page
3. Authenticate with your configured method
4. You should now see the OpenClaw UI

## Maintenance

### Updating cloudflared

The playbook does not set up auto-update for cloudflared. This is by design to avoid breaking changes.

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb
sudo systemctl restart cloudflared
```

### Viewing Tunnel Metrics

Cloudflare Dashboard → Zero Trust → Networks → Tunnels → (your tunnel) → Metrics

### Changing Tunnel Configuration

All routing config lives in the Cloudflare Dashboard. To change hostnames, origins, or add new routes:

1. Go to **Cloudflare Dashboard** → **Zero Trust** → **Networks** → **Tunnels**
2. Click your tunnel → **Configure**
3. Edit the public hostname settings
4. Changes take effect within seconds — no service restart needed

### Rotating Tunnel Token

If the token is compromised:

1. Go to the tunnel in Cloudflare Dashboard
2. Regenerate the token
3. On VPS:

   ```bash
   sudo cloudflared service uninstall
   sudo cloudflared service install <NEW_TOKEN>
   sudo systemctl start cloudflared
   ```

4. Update `CF_TUNNEL_TOKEN` in `openclaw-config.env`
