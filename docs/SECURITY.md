# Security Model

End-to-end security architecture for the OpenClaw single-VPS deployment. Covers network perimeter, authentication layers, device pairing protocol, and dashboard access control.

---

## Overview

Three defense layers protect the system. Each layer must pass before the next is evaluated:

```text
Internet
    |
    v
┌─────────────────────────────────────────┐
│  Layer 1: Cloudflare Edge               │
│  - Cloudflare Tunnel (outbound-only)    │
│  - Cloudflare Access (identity + JWT)   │
│  - No inbound ports exposed             │
└─────────────┬───────────────────────────┘
              |
              v
┌─────────────────────────────────────────┐
│  Layer 2: Gateway Authentication        │
│  - Shared secret (GATEWAY_TOKEN)        │
│  - Device identity (Ed25519 keypair)    │
│  - Device pairing (admin approval)      │
└─────────────┬───────────────────────────┘
              |
              v
┌─────────────────────────────────────────┐
│  Layer 3: OS & Container Isolation      │
│  - Two-user model (adminclaw/openclaw)  │
│  - Sysbox runtime (rootless containers) │
│  - Read-only sandbox filesystems        │
│  - Network isolation (no outbound)      │
│  - Capability drop (ALL)                │
└─────────────────────────────────────────┘
```

---

## Network Perimeter

### Cloudflare Tunnel

The VPS has **zero exposed ports** beyond SSH. All HTTP/WebSocket traffic enters through a Cloudflare Tunnel, which makes outbound-only connections from the VPS to Cloudflare's edge.

```text
User Browser                    Cloudflare Edge                         VPS
     |                               |                                   |
     |──── HTTPS request ───────────>|                                   |
     |                               |                                   |
     |                               |     cloudflared (outbound conn)   |
     |                               |<──────────────────────────────────|
     |                               |                                   |
     |                               |──── Forward via tunnel ────────>  |
     |                               |     (172.30.0.1 Docker bridge)    |
     |                               |                                   |
     |<──── HTTPS response ──────────|<────────────────────────────────  |
```

- **Port 443**: Not open. Cloudflare terminates TLS at the edge; `cloudflared` connects outbound.
- **Port 222**: SSH only (key-based, `adminclaw` user, fail2ban protected).
- **Docker port binding**: All containers bind to `127.0.0.1` only via `daemon.json`.
- **Gateway `--bind lan`**: Required because `cloudflared` connects via Docker bridge IP (`172.30.0.1`), not loopback.

### Cloudflare Access

Every request to the gateway or dashboard domain passes through Cloudflare Access, which enforces identity verification before the request reaches the VPS.

```text
User                    Cloudflare Access                    VPS
 |                            |                               |
 |── GET /dashboard/ ────────>|                               |
 |                            |                               |
 |  Not authenticated?        |                               |
 |<── Redirect to IdP ────────|                               |
 |                            |                               |
 |── IdP login ──────────────>|                               |
 |                            |                               |
 |  Authenticated:            |                               |
 |  Set CF_Authorization      |                               |
 |  cookie + inject           |                               |
 |  Cf-Access-Jwt-Assertion   |                               |
 |  header                    |                               |
 |                            |── Forward with JWT header ───>|
 |                            |                               |
 |<─── Response ──────────────|<───────────────────────────── |
```

**JWT claims verified by the dashboard:**

- `exp` — Token not expired
- `iss` — Issuer contains `.cloudflareaccess.com`
- `aud` — Matches `CF_ACCESS_AUD` (if configured)
- **Signature** — RSA-SHA256 verified against Cloudflare's published public keys (fetched from `{issuer}/cdn-cgi/access/certs`, cached 1 hour)

---

## Gateway Device Pairing

The gateway uses a cryptographic device identity system to authenticate clients (Control UI, CLI). Every client generates a long-lived Ed25519 keypair and must be explicitly paired by an administrator before it can interact with the gateway.

### Device Identity Creation

```text
┌─ Browser (first visit) ─────────────────────────────────────┐
│                                                             │
│  1. Generate Ed25519 keypair                                │
│     privateKey = randomSecretKey()        (32 bytes)        │
│     publicKey  = derivePublic(privateKey) (32 bytes)        │
│                                                             │
│  2. Derive deviceId                                         │
│     deviceId = SHA-256(publicKey) → hex   (64 chars)        │
│                                                             │
│  3. Store in localStorage                                   │
│     key: "openclaw-device-identity-v1"                      │
│     val: { version, deviceId, publicKey, privateKey,        │
│            createdAtMs }                                    │
│                                                             │
│  Identity persists across sessions until localStorage       │
│  is cleared. Same keypair = same deviceId.                  │
└─────────────────────────────────────────────────────────────┘
```

**Server-side** (CLI, gateway self-identity): Same derivation using Node.js `crypto.generateKeyPairSync("ed25519")`. Stored at `~/.openclaw/identity/device.json` with mode `0600`.

### WebSocket Handshake Protocol

Every Control UI or CLI connection to the gateway follows this challenge-response handshake:

```text
Browser                                          Gateway
   |                                                |
   |════ WebSocket connect ════════════════════════>|
   |                                                |
   |          ┌─────────────────────────────────┐   |
   |<─────────│ event: "connect.challenge"      │───|
   |          │ payload: {                      │   |
   |          │   nonce: "<uuid-v4>",           │   |
   |          │   ts: 1707123456789             │   |
   |          │ }                               │   |
   |          └─────────────────────────────────┘   |
   |                                                |
   |  Build auth payload (pipe-delimited):          |
   |  ┌──────────────────────────────────────┐      |
   |  │ v2                      (version)    │      |
   |  │ |<deviceId>             (sha256 hex) │      |
   |  │ |control-ui             (clientId)   │      |
   |  │ |webchat                (clientMode) │      |
   |  │ |operator               (role)       │      |
   |  │ |operator.admin,...     (scopes csv) │      |
   |  │ |1707123456789          (signedAtMs) │      |
   |  │ |<device-token>         (if paired)  │      |
   |  │ |<nonce-uuid>           (from above) │      |
   |  └──────────────────────────────────────┘      |
   |                                                |
   |  Sign payload with Ed25519 private key         |
   |  signature = Ed25519.sign(payload, privateKey) |
   |                                                |
   |          ┌─────────────────────────────────┐   |
   |──────────│ method: "connect"               │──>|
   |          │ params: {                       │   |
   |          │   client: { id, mode },         │   |
   |          │   auth: { token },              │   |
   |          │   device: {                     │   |
   |          │     id: "<deviceId>",           │   |
   |          │     publicKey: "<base64url>",   │   |
   |          │     signature: "<base64url>",   │   |
   |          │     signedAt: 1707123456789,    │   |
   |          │     nonce: "<uuid>"             │   |
   |          │   }                             │   |
   |          │ }                               │   |
   |          └─────────────────────────────────┘   |
   |                                                |
```

### Server-Side Verification

The gateway performs these checks in order:

```text
┌─ Gateway: Verify Connect ────────────────────────────────────────────┐
│                                                                      │
│  1. IDENTITY CHECK                                                   │
│     derivedId = SHA-256(device.publicKey)                            │
│     assert derivedId === device.id                                   │
│     → Reject: "device identity mismatch"                             │
│                                                                      │
│  2. TIMESTAMP CHECK                                                  │
│     skew = |now - device.signedAt|                                   │
│     assert skew < 10 minutes                                         │
│     → Reject: "device signature expired"                             │
│                                                                      │
│  3. NONCE CHECK (v2 only, non-loopback)                              │
│     assert device.nonce === connectNonce (from challenge)            │
│     → Reject: "invalid nonce" (prevents replay attacks)              │
│                                                                      │
│  4. SIGNATURE CHECK                                                  │
│     Rebuild same pipe-delimited payload server-side                  │
│     Ed25519.verify(payload, device.publicKey, device.signature)      │
│     → Reject: "signature verification failed"                        │
│                                                                      │
│  5. SHARED SECRET CHECK                                              │
│     safeEqualSecret(auth.token, GATEWAY_TOKEN)                       │
│     Uses constant-time comparison (no timing attacks)                │
│     → Reject: "token_mismatch"                                       │
│                                                                      │
│  6. PAIRING CHECK                                                    │
│     Look up device.id in paired.json                                 │
│     If paired: verify device token matches stored token              │
│     If not paired: create pairing request                            │
│       - Loopback connections: auto-approve (silent)                  │
│       - Remote connections: require admin approval                   │
│     → Reject: "pairing required"                                     │
│                                                                      │
│  7. ISSUE TOKEN                                                      │
│     On success: send hello-ok with device token                      │
│     Token = 32 random bytes, base64url-encoded (44 chars)            │
│     Stored in paired.json under device's role                        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Pairing Lifecycle

```text
┌─ New Device ──────────────────────────────────────────────────────────┐
│                                                                       │
│  STEP 1: Device connects for the first time                           │
│                                                                       │
│    Browser ──── WebSocket ────> Gateway                               │
│    (new keypair, no token)      "pairing required" ──> disconnect     │
│                                                                       │
│  STEP 2: Pairing request created                                      │
│                                                                       │
│    Gateway stores pending request:                                    │
│    {                                                                  │
│      requestId: "<uuid>",                                             │
│      deviceId:  "<sha256-of-pubkey>",                                 │
│      publicKey: "<full-public-key>",                                  │
│      platform:  "macos",                                              │
│      clientId:  "control-ui",                                         │
│      role:      "operator",                                           │
│      scopes:    ["operator.admin", "operator.approvals", ...],        │
│      remoteIp:  "203.0.113.42",                                       │
│      ts:        1707123456789                                         │
│    }                                                                  │
│    TTL: 5 minutes (request expires if not approved)                   │
│                                                                       │
│  STEP 3: Admin approves via CLI or Control UI                         │
│                                                                       │
│    $ openclaw devices approve <requestId>                             │
│                                                                       │
│    Gateway generates role token:                                      │
│      token = randomBytes(32).toString("base64url")                    │
│                                                                       │
│    Writes to paired.json:                                             │
│    {                                                                  │
│      "<deviceId>": {                                                  │
│        deviceId, publicKey, role, roles, scopes,                      │
│        tokens: {                                                      │
│          "operator": {                                                │
│            token: "<44-char-base64url>",                              │
│            role: "operator",                                          │
│            scopes: ["operator.admin", ...],                           │
│            createdAtMs: 1707123456789                                 │
│          }                                                            │
│        }                                                              │
│      }                                                                │
│    }                                                                  │
│                                                                       │
│  STEP 4: Device reconnects, receives token                            │
│                                                                       │
│    Browser ──── WebSocket ────> Gateway                               │
│    (same keypair, no token)     Paired! Issue token in hello-ok       │
│                                                                       │
│    Browser stores token in localStorage:                              │
│    key: "openclaw.device.auth.v1"                                     │
│    val: {                                                             │
│      version: 1,                                                      │
│      deviceId: "<sha256>",                                            │
│      tokens: {                                                        │
│        "operator": { token: "<44-chars>", role, scopes, updatedAtMs } │
│      }                                                                │
│    }                                                                  │
│                                                                       │
│  STEP 5: Subsequent connections use stored token                      │
│                                                                       │
│    Browser ──── WebSocket ────> Gateway                               │
│    (keypair + token in payload) Verified! Full access granted         │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Key Storage Locations

| What | Where | Format |
|------|-------|--------|
| Device keypair (browser) | `localStorage["openclaw-device-identity-v1"]` | JSON: `{ deviceId, publicKey, privateKey }` |
| Device token (browser) | `localStorage["openclaw.device.auth.v1"]` | JSON: `{ deviceId, tokens: { role: { token } } }` |
| Device keypair (CLI/server) | `~/.openclaw/identity/device.json` | JSON, mode `0600` |
| Paired devices (gateway) | `~/.openclaw/devices/paired.json` | JSON object keyed by deviceId |
| Gateway shared secret | `OPENCLAW_GATEWAY_TOKEN` env var | 64-char hex string |

---

## Dashboard Authentication

The dashboard (`deploy/openclaw-stack/dashboard/server.mjs`) serves browser session UIs (noVNC), media files, and future dashboard features. It enforces two authentication layers:

### Request Flow

```text
Browser                     CF Edge                  Dashboard Server
   |                           |                           |
   |── GET /dashboard/ ───────>|                           |
   |                           |                           |
   |   CF Access check:        |                           |
   |   - IdP login if needed   |                           |
   |   - Set JWT cookie        |                           |
   |   - Inject JWT header     |                           |
   |                           |                           |
   |                           |── Forward + JWT ─────────>|
   |                           |                           |
   |                           |   LAYER 1: Verify JWT     |
   |                           |   - Check exp, iss, aud   |
   |                           |   - Verify RSA-SHA256 sig |
   |                           |   - Fetch CF public keys  |
   |                           |   ❌ fail → 403           |
   |                           |                           |
   |                           |   LAYER 2: Device pairing |
   |                           |   - Check session cookie  |
   |                           |   ❌ no cookie → auth gate|
   |                           |   ✅ valid → serve page   |
   |                           |                           |
   |<── Dashboard HTML ────────|<──────────────────────────|
```

### Auth Gate Flow (First Visit)

When a user has no valid session cookie, the dashboard serves an auth gate page that automatically authenticates using the device token stored by the gateway Control UI:

```text
Browser                              Dashboard Server
   |                                       |
   |── GET /dashboard/ ─────────────────>  |
   |                                       |
   |   No session cookie found             |
   |                                       |
   |  <──── Auth gate HTML+JS ─────────────|
   |                                       |
   |  JS executes:                         |
   |  1. Read localStorage                 |
   |     "openclaw.device.auth.v1"         |
   |                                       |
   |  ┌─ No token found? ──────────┐       |
   |  │ Show "Not Paired" message  │       |
   |  │ Link to Gateway Control UI │       |
   |  └────────────────────────────┘       |
   |                                       |
   |  ┌─ Token found? ─────────────┐       |
   |  │ Extract first role token   │       |
   |  │ from tokens object         │       |
   |  └──────────────┬─────────────┘       |
   |                 |                     |
   |── POST /_auth ──┘                     |
   |   { deviceId: "6ead...",              |
   |     token: "hM81Mf..." }              |
   |                                ──────>|
   |                                       |
   |                 Validate token against|
   |                 paired.json in-memory |
   |                 cache                 |
   |                                       |
   |  ┌─ 403: Token invalid ───────┐       |
   |  │ Show "Device Not           │       |
   |  │ Recognized" error          │<──────|
   |  └────────────────────────────┘       |
   |                                       |
   |  ┌─ 200: Token valid ─────────┐       |
   |  │ Set-Cookie:                │       |
   |  │   openclaw-dashboard=      │<──────|
   |  │   <deviceId>.<ts>.<hmac>;  │       |
   |  │   HttpOnly; SameSite=Strict│       |
   |  │                            │       |
   |  │ JS reloads page            │       |
   |  └──────────────┬─────────────┘       |
   |                 |                     |
   |── GET /dashboard/ (with cookie) ────> |
   |                                       |
   |   Cookie verified ✅                  |
   |                                       |
   |  <──── Dashboard page ────────────────|
```

### Session Cookie

The dashboard uses stateless HMAC-signed cookies — no server-side session storage needed.

**Cookie format:**

```
<deviceId>.<timestampMs>.<hmac-sha256-hex>
```

**Signing:**

```
HMAC-SHA256(
  key:  OPENCLAW_GATEWAY_TOKEN,
  data: "<deviceId>.<timestampMs>"
) → hex
```

**Verification:**

```text
┌─ verifySessionCookie(cookieValue) ───────────────────────┐
│                                                          │
│  1. Split by "." → [deviceId, ts, hmac]                  │
│     Reject if not exactly 3 parts                        │
│                                                          │
│  2. Check expiry                                         │
│     elapsed = now - parseInt(ts)                         │
│     Reject if elapsed > SESSION_MAX_AGE (default 24h)    │
│     Reject if elapsed < 0 (future timestamp)             │
│                                                          │
│  3. Recompute HMAC                                       │
│     expected = HMAC-SHA256(GATEWAY_TOKEN, deviceId.ts)   │
│                                                          │
│  4. Constant-time compare                                │
│     timingSafeEqual(expected, hmac)                      │
│     Reject if mismatch                                   │
│                                                          │
│  5. Return { deviceId } on success                       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Cookie attributes:**

| Attribute | Value | Purpose |
|-----------|-------|---------|
| `HttpOnly` | Yes | Not accessible to JavaScript (XSS protection) |
| `SameSite` | `Strict` | Not sent on cross-origin requests (CSRF protection) |
| `Path` | `/dashboard` | Scoped to dashboard routes only |
| `Max-Age` | `86400` (24h) | Browser-enforced expiry (server also checks) |

### Paired Device Sync

The dashboard watches `paired.json` for real-time changes when devices are paired or revoked:

```text
Gateway                          paired.json                    Dashboard
   |                                  |                             |
   |  Admin approves device           |                             |
   |──── Write new entry ───────────> |                             |
   |                                  |                             |
   |                                  |──── inotify/poll ─────────> |
   |                                  |                             |
   |                                  |     loadPairedDevices()     |
   |                                  |     - Read file             |
   |                                  |     - Compare content hash  |
   |                                  |     - Parse if changed      |
   |                                  |     - Build Map<id, tokens> |
   |                                  |                             |
   |  Admin revokes device            |                             |
   |──── Remove entry ──────────────> |                             |
   |                                  |                             |
   |                                  |──── inotify/poll ─────────> |
   |                                  |                             |
   |                                  |     Device removed from map |
   |                                  |     New auth attempts fail  |
   |                                  |     (existing cookies valid |
   |                                  |      until expiry — CF      |
   |                                  |      Access is the primary  |
   |                                  |      perimeter)             |
```

**Two watchers for reliability:**

- `fs.watch()` — inotify-based, immediate but may miss events on some filesystems
- `fs.watchFile()` — stat-based polling every 5 seconds, always reliable
- Both debounced at 500ms to coalesce rapid writes

### Graceful Degradation

If `OPENCLAW_GATEWAY_TOKEN` is not set, the entire device pairing auth layer is disabled:

```
OPENCLAW_GATEWAY_TOKEN=""  →  PAIRING_AUTH_ENABLED = false

- No /_auth routes registered
- No session cookie checks
- No paired.json watching
- Dashboard protected by CF Access JWT only
- Log: "[dashboard] OPENCLAW_GATEWAY_TOKEN not set — device pairing auth disabled"
```

### WebSocket Protection

noVNC browser sessions use WebSocket connections that are also protected by both auth layers:

```
Browser                              Dashboard Server
   |                                       |
   |══ WS Upgrade /dashboard/browser/<agent>/websockify ══>
   |                                       |
   |   1. Verify CF Access JWT header      |
   |      ❌ → socket.destroy()            |
   |                                       |
   |   2. Verify session cookie            |
   |      (from Cookie header on upgrade)  |
   |      ❌ → socket.destroy()            |
   |                                       |
   |   3. Look up agent in browsers.json   |
   |      ❌ → socket.destroy()            |
   |                                       |
   |   4. TCP connect to noVNC container   |
   |      ❌ → socket.destroy()            |
   |                                       |
   |<══ Bidirectional pipe ═══════════════>|═══> noVNC container
```

---

## Host Security

### Two-User Model

| User | UID | SSH | Sudo | Purpose |
|------|-----|-----|------|---------|
| `adminclaw` | 1001 | Key-only, port 222 | Passwordless | System administration |
| `openclaw` | 1002 | None | None | Application runtime |

If `openclaw` is compromised, the attacker cannot escalate to root. All Docker commands run as `openclaw`; system administration requires `adminclaw`.

### Container Isolation

```text
┌─ VPS Host ──────────────────────────────────────────────────┐
│                                                             │
│  adminclaw (admin)        openclaw (runtime)                │
│       |                        |                            │
│       |                  ┌─────┴──────────┐                 │
│       |                  │ Sysbox Runtime │                 │
│       |                  │ (uid remapping)│                 │
│       |                  └─────┬──────────┘                 │
│       |                        |                            │
│       |              ┌─────────┴──────────────┐             │
│       |              │ Gateway Container      │             │
│       |              │ (root inside = uid     │             │
│       |              │  1002 on host via      │             │
│       |              │  Sysbox remap)         │             │
│       |              │                        │             │
│       |              │  ┌──────────────────┐  │             │
│       |              │  │ Nested Docker    │  │             │
│       |              │  │                  │  │             │
│       |              │  │ ┌──────────────┐ │  │             │
│       |              │  │ │ Sandbox      │ │  │             │
│       |              │  │ │ - read-only  │ │  │             │
│       |              │  │ │ - cap DROP   │ │  │             │
│       |              │  │ │ - no network │ │  │             │
│       |              │  │ │ - tmpfs home │ │  │             │
│       |              │  │ └──────────────┘ │  │             │
│       |              │  │ ┌──────────────┐ │  │             │
│       |              │  │ │ Browser      │ │  │             │
│       |              │  │ │ Sandbox      │ │  │             │
│       |              │  │ │ - bridge net │ │  │             │
│       |              │  │ └──────────────┘ │  │             │
│       |              │  └──────────────────┘  │             │
│       |              └────────────────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

### Sandbox Security Properties

| Property | Setting | Purpose |
|----------|---------|---------|
| Filesystem | `readOnlyRoot: true` | Prevents persistent malware |
| Home directory | `tmpfs` (ephemeral) | No persistent state |
| Capabilities | `capDrop: ["ALL"]` | Minimal Linux privileges |
| Network | `none` (default) | No outbound internet access |
| Network (browser) | `bridge` (per-agent override) | Only agents needing CDP/internet |

---

## Cryptographic Inventory

| Purpose | Algorithm | Key Size | Where |
|---------|-----------|----------|-------|
| Device identity | Ed25519 | 256-bit | Browser localStorage, server `device.json` |
| DeviceId derivation | SHA-256 | 256-bit | Hash of Ed25519 public key |
| Challenge nonce | UUID v4 | 128-bit | Generated per WebSocket connection |
| Device token | `randomBytes` | 256-bit (32 bytes) | `paired.json`, base64url-encoded |
| Gateway shared secret | Hex string | 256-bit (32 bytes) | `.env` / `openclaw.json` |
| Dashboard session cookie | HMAC-SHA256 | 256-bit key | Keyed on `GATEWAY_TOKEN` |
| CF Access JWT | RSA-SHA256 | 2048+ bit | Cloudflare-managed keys |
| Secret comparison | Constant-time | N/A | `timingSafeEqual` / `safeEqualSecret` |

---

## Threat Model

### What's Protected

- **Browser sessions**: Live noVNC streams of agent browser activity
- **Media files**: Screenshots, PDFs, downloads generated by agents
- **Gateway control**: Agent management, configuration, chat sessions
- **Agent sandboxes**: Isolated execution environments with tool access

### Attack Vectors and Mitigations

| Vector | Mitigation |
|--------|------------|
| Direct port scanning | Cloudflare Tunnel (no exposed ports) |
| Stolen CF Access credentials | Device pairing required (second factor) |
| XSS on gateway domain | `HttpOnly` + `SameSite=Strict` cookies |
| Replay attacks | Nonce-based challenge (v2 protocol) + 10-min timestamp skew |
| Timing attacks on secrets | `timingSafeEqual` for all comparisons |
| Brute force pairing tokens | 256-bit random tokens (2^256 search space) |
| Compromised sandbox | Read-only filesystem, dropped capabilities, network isolation |
| Compromised `openclaw` user | No sudo, no SSH — cannot escalate to root |
