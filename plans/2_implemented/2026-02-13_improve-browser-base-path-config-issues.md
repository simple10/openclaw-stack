# Plan: Fix noVNC Proxy Base Path Reliability

## Context

The noVNC proxy relies on `NOVNC_BASE_PATH` env var to know its URL prefix (e.g., `/browser`). This value flows through a fragile pipeline: `OPENCLAW_BROWSER_PUBLIC_URL` is parsed by bash in playbook 04 to extract the path component, written to `.env` on VPS, read by Docker Compose, and passed to the container. If any step breaks (container not restarted after `.env` update, bash parsing edge case), the proxy loses its base path and `/browser` gets treated as an agent session ID instead of the root.

Two complementary fixes:

1. **Simplify config** — split the URL into domain + path so `NOVNC_BASE_PATH` is a direct copy (no parsing)
2. **Auto-detect fallback** — proxy self-corrects when the first path segment isn't a known agent

---

## Change 1: Split `OPENCLAW_BROWSER_PUBLIC_URL` into domain + path

Mirrors the existing `OPENCLAW_DOMAIN` / `OPENCLAW_DOMAIN_PATH` pattern.

### `openclaw-config.env.example`

Replace:

```
OPENCLAW_BROWSER_PUBLIC_URL=openclaw.<example>.com/browser
# ^ Can be a subpath (domain.com/browser) or a separate subdomain (browser.domain.com)
# The path component (if any) is extracted and passed to the novnc-proxy as its base path.
# Cloudflare Tunnel should route this to http://localhost:6090
```

With:

```
OPENCLAW_BROWSER_DOMAIN=openclaw.<example>.com
OPENCLAW_BROWSER_DOMAIN_PATH=/browser    # noVNC proxy base path (e.g., /browser), leave blank if using a separate subdomain
# Cloudflare Tunnel should route this to http://localhost:6090
```

### `playbooks/04-vps1-openclaw.md`

**Section "Variables" (line 36):** Update variable name reference.

**Section 4.5 (lines 172-180):** Remove bash URL parsing block entirely. Replace with:

```bash
NOVNC_BASE_PATH="${OPENCLAW_BROWSER_DOMAIN_PATH:-}"
```

**Section 4.5 env file (line 200-202):** Update comment:

```
# noVNC proxy base path — from OPENCLAW_BROWSER_DOMAIN_PATH
# Empty = proxy serves at root (e.g., browser on a separate subdomain)
NOVNC_BASE_PATH=${NOVNC_BASE_PATH}
```

### `playbooks/08-post-deploy.md`

**Section 8.0b (lines 87-153):** Update all references:

- "Check if OPENCLAW_BROWSER_PUBLIC_URL has a placeholder" → check both new vars
- Parse step becomes simpler: user provides domain and path separately
- `sed` command updates `NOVNC_BASE_PATH` directly from `OPENCLAW_BROWSER_DOMAIN_PATH`
- Curl command uses `https://${OPENCLAW_BROWSER_DOMAIN}${OPENCLAW_BROWSER_DOMAIN_PATH}/`
- Update deployment report Browser VNC URL

### `playbooks/00-fresh-deploy-setup.md`

**Lines 7 and 146:** Update `OPENCLAW_BROWSER_PUBLIC_URL` references to the two new variable names.

### `deploy/openclaw.json` (line 94)

Update comment from `OPENCLAW_BROWSER_PUBLIC_URL` to `OPENCLAW_BROWSER_DOMAIN`.

### `deploy/docker-compose.override.yml` (lines 96-97)

Update comment: "Parsed from OPENCLAW_BROWSER_PUBLIC_URL" → "Set from OPENCLAW_BROWSER_DOMAIN_PATH".

### `docs/BROWSER-VNC.md`

Update the URL Configuration section — replace single-URL format with domain + path format. Update the table showing `NOVNC_BASE_PATH` derivation.

### `docs/CLOUDFLARE-TUNNEL.md`

Update config examples showing the new variable names. The tunnel routing itself doesn't change.

### `docs/TESTING.md` (line 117)

Update the curl/navigation URL to use new vars.

---

## Change 2: Auto-detect fallback in `novnc-proxy.mjs`

When `NOVNC_BASE_PATH` is empty (not set or misconfigured), the proxy should detect that the first path segment isn't a known agent and treat it as a base path prefix.

### Implementation in `deploy/novnc-proxy.mjs`

Add a module-level variable after `BP` is computed (after line 36):

```javascript
// Auto-detected base path — set on first request when BP is empty and
// the first path segment doesn't match any known agent or reserved route.
// Once detected, used for URL generation (links, redirects) in all responses.
let effectiveBP = BP;
```

**HTTP handler (after existing BP stripping, around line 402):** Add auto-detection block:

```javascript
// Auto-detect base path when NOVNC_BASE_PATH is not set.
// If the first path segment isn't a known agent or "media", treat it as
// a base path prefix — strip it for routing. This handles the case where
// Cloudflare Tunnel sends /browser/... but NOVNC_BASE_PATH wasn't configured.
if (!BP) {
  const seg = path.match(/^\/([^/]+)(\/.*)?$/);
  if (seg && seg[1] !== 'media' && !findEntry(seg[1])) {
    const detected = `/${seg[1]}`;
    if (!effectiveBP) {
      effectiveBP = detected;
      console.log(`[novnc-proxy] Auto-detected base path: ${effectiveBP} (set NOVNC_BASE_PATH=${effectiveBP} to make this explicit)`);
    }
    if (!seg[2]) {
      // Bare /prefix → redirect to /prefix/
      res.writeHead(302, { Location: `${detected}/` });
      res.end();
      return;
    }
    path = seg[2]; // Strip prefix, continue routing remainder
  }
}
```

**WebSocket handler (around line 494):** Same auto-detect for WS:

```javascript
if (!BP && effectiveBP && wsPath.startsWith(effectiveBP + '/')) {
  wsPath = wsPath.slice(effectiveBP.length);
}
```

**Replace all `BP` references with `effectiveBP`** in URL generation:

- `indexPage()` — line 222 (media link), lines 231-237 (wsPrefix and VNC links)
- `containerDownPage()` — line 262 (back link)
- `mediaDirectoryPage()` — lines 297-298 (mediaRoot and parentLink)
- `handleMediaRequest()` — line 313 (mediaPrefix)
- HTTP handler — line 390 (redirect), line 396 (strip check), line 434 (VNC redirect), line 445 (not found back link)
- WebSocket handler — line 494 (strip check)

All ~12 references to `BP` in URL generation and path handling change to `effectiveBP`.

---

## Files Modified

| File | Change |
|------|--------|
| `openclaw-config.env.example` | Replace `OPENCLAW_BROWSER_PUBLIC_URL` with two new vars |
| `deploy/novnc-proxy.mjs` | Add auto-detect fallback, replace `BP` → `effectiveBP` |
| `deploy/docker-compose.override.yml` | Update comment |
| `deploy/openclaw.json` | Update comment |
| `playbooks/04-vps1-openclaw.md` | Remove URL parsing, use `OPENCLAW_BROWSER_DOMAIN_PATH` directly |
| `playbooks/08-post-deploy.md` | Update variable references and instructions |
| `playbooks/00-fresh-deploy-setup.md` | Update variable references |
| `docs/BROWSER-VNC.md` | Update config documentation |
| `docs/CLOUDFLARE-TUNNEL.md` | Update config examples |
| `docs/TESTING.md` | Update URL references |

---

## Verification

1. **Proxy auto-detect test** (local): Set `NOVNC_BASE_PATH=` (empty), run the proxy, send requests to `/browser/` — should serve index page, not "Session Not Found"
2. **Proxy explicit test**: Set `NOVNC_BASE_PATH=/browser`, verify same behavior as before
3. **Config consistency**: Grep for any remaining `OPENCLAW_BROWSER_PUBLIC_URL` references — should be zero
4. **Playbook review**: Read through playbooks 04 and 08 to verify the simplified flow makes sense
