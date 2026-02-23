# Plan: Add Gateway Device Pairing Auth to Dashboard

## Context

The dashboard (browser sessions, media files) is currently protected only by Cloudflare Access JWT verification. We want a second auth layer: **only users who have paired a device with the OpenClaw gateway can access the dashboard**. This prevents rogue CF Access users (e.g., shared team accounts) from seeing browser sessions or media without completing the gateway pairing flow.

The dashboard runs as a child process inside the gateway container (`entrypoint-gateway.sh` section 2b), so it has direct filesystem access to the gateway's device registry at `/home/node/.openclaw/devices/paired.json`. The `OPENCLAW_GATEWAY_TOKEN` env var is available in the container.

## Architecture

```
Browser                           Dashboard Server                    Gateway
  │                                    │                                │
  ├─ CF Access JWT ────────────────────┤                                │
  │                                    │                                │
  ├─ GET /dashboard/ ──────────────────┤                                │
  │                              check session cookie                   │
  │                              ❌ no cookie                           │
  │  ◄──── auth gate HTML ────────────┤                                │
  │                                    │                                │
  │  JS reads localStorage             │                                │
  │  (openclaw.device.auth.v1)         │                                │
  │                                    │                                │
  ├─ POST /_auth {deviceId, token} ───►│                                │
  │                              validate token against                 │
  │                              paired.json (in-memory cache)          │
  │                              ✅ match                               │
  │  ◄──── 200 + Set-Cookie ──────────┤                                │
  │                                    │                                │
  ├─ GET /dashboard/ (with cookie) ───►│                                │
  │                              ✅ valid cookie                        │
  │  ◄──── normal dashboard ──────────┤                                │
```

**Real-time updates**: `fs.watch` on `paired.json` reloads the in-memory device set whenever devices are paired or revoked — equivalent to a WebSocket event push but with zero protocol complexity.

**Same-domain requirement**: Auth gate JS reads `localStorage` set by the gateway's Control UI (same origin). Cross-domain would need a redirect-based flow (future work, not in scope).

## Changes — `deploy/dashboard.mjs`

All changes in this single file (~120 lines of new code). Zero new dependencies.

### 1. New constants and state

```javascript
const PAIRED_JSON = '/home/node/.openclaw/devices/paired.json';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const SESSION_MAX_AGE = parseInt(process.env.DASHBOARD_SESSION_MAX_AGE || '86400', 10);
const SESSION_COOKIE = 'openclaw-dashboard';

// Map<deviceId, Map<role, tokenString>> — loaded from paired.json
let pairedDevices = new Map();
```

### 2. Paired device loading + file watching

- `loadPairedDevices()` — reads `paired.json`, builds `Map<deviceId, Map<role, token>>`
- `watchPairedDevices()` — `fs.watch` with 500ms debounce; `fs.watchFile` fallback for reliability
- `isDeviceTokenValid(deviceId, token)` — checks token against any role entry for that deviceId
- Called at startup before `server.listen()`

### 3. Session cookie (HMAC-signed, stateless)

- Format: `<deviceId>.<timestampMs>.<hmac-hex>`
- HMAC: `createHmac('sha256', GATEWAY_TOKEN).update(deviceId + '.' + timestampMs).digest('hex')`
- Verify: split, check `(now - timestamp) < SESSION_MAX_AGE * 1000`, recompute HMAC, constant-time compare
- Attributes: `HttpOnly; SameSite=Strict; Path=<base_path_or_/>; Max-Age=<SESSION_MAX_AGE>`

### 4. Auth gate page

Served when user has no valid session cookie. Small inline HTML+JS:

1. Reads `openclaw.device.auth.v1` from `localStorage`
2. If not found → shows "Not Paired" message with link to gateway (`/` on same domain)
3. If found → POSTs `{ deviceId, token }` to `/_auth` (relative to dashboard base path)
4. 200 → reloads (cookie set, normal dashboard loads)
5. 403 → shows "Device Not Recognized" message
6. Error → shows generic error

Styled consistently with existing dashboard pages (same `CSS` variable).

### 5. `/_auth` endpoint

After base path stripping (so real URL is `/dashboard/_auth`), before cookie check:

- `POST /_auth` — validate `{ deviceId, token }` against paired devices map. 200 + Set-Cookie if valid, 403 if not.
- `GET /_auth` — serve auth gate page (for direct navigation)

### 6. Modified request flow

```
1. CF Access JWT check (existing, unchanged)
2. Base path stripping (existing, unchanged)
3. /_auth routes → handle auth (exempt from cookie check)    ← NEW
4. Session cookie check                                       ← NEW
   - Valid → continue to step 5
   - Invalid → serve auth gate page
5. Normal routing: /, /media/*, /<agent>/* (existing, unchanged)
```

WebSocket upgrades also check the session cookie from the upgrade request headers.

### 7. Graceful degradation

If `OPENCLAW_GATEWAY_TOKEN` is empty:

- Skip all pairing auth (no cookie check, no `/_auth` routes)
- Log: `[dashboard] OPENCLAW_GATEWAY_TOKEN not set — device pairing auth disabled`
- Dashboard works exactly as before (CF Access only)

## Files Modified

| File | Changes |
|------|---------|
| `deploy/dashboard.mjs` | Add pairing auth (~120 lines new code) |

No other files need changes.

## Verification

1. **No pairing**: Clear `localStorage`, visit dashboard → auth gate with "Not Paired"
2. **After pairing**: Pair via gateway Control UI, visit dashboard → auto-authenticates, cookie set
3. **Subsequent visits**: Cookie present → dashboard loads directly (no auth gate)
4. **Cookie tampering**: Edit cookie → rejected → auth gate
5. **Device revoked**: Edit `paired.json` to remove device → new auth attempts fail (existing cookies valid until expiry — acceptable since CF Access is the primary perimeter)
6. **No gateway token**: Unset env var → pairing auth disabled, dashboard works as before
7. **WebSocket (noVNC)**: Verify unpaired user's VNC WebSocket is rejected
8. **Media files**: Verify unpaired user can't browse `/media/`
