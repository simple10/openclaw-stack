// auth.mjs — Two-layer authentication for the OpenClaw dashboard.
// Layer 1: Cloudflare Access JWT — cryptographic signature verification
// Layer 2: Gateway device pairing — HMAC-signed stateless session cookies
// Also manages the effective base path state shared by all dashboard modules.

import { readFileSync, watch, watchFile } from 'node:fs'
import { createPublicKey, verify as cryptoVerify, createHmac, timingSafeEqual } from 'node:crypto'

// ── Base path state ──────────────────────────────────────────────────
// DASHBOARD_BASE_PATH is set when dashboard runs behind a URL subpath (e.g. "/dashboard").
// effectiveBP may also be auto-detected from the first incoming request if not configured.
const RAW_BASE = process.env.DASHBOARD_BASE_PATH || ''
const BASE_PATH = RAW_BASE === '/' ? '' : RAW_BASE.replace(/\/+$/, '')
const BP = BASE_PATH && !BASE_PATH.startsWith('/') ? `/${BASE_PATH}` : BASE_PATH

let effectiveBP = BP

export function getEffectiveBP() { return effectiveBP }
export function setEffectiveBP(bp) { effectiveBP = bp }
export function getConfiguredBP() { return BP }

// ── Gateway device pairing constants ─────────────────────────────────
const PAIRED_JSON = '/home/node/.openclaw/devices/paired.json'
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || ''
const SESSION_MAX_AGE = parseInt(process.env.DASHBOARD_SESSION_MAX_AGE || '86400', 10)
const SESSION_COOKIE = 'openclaw-dashboard'
export const PAIRING_AUTH_ENABLED = !!GATEWAY_TOKEN

let pairedDevices = new Map()
let lastPairedJson = ''

// ── Cloudflare Access JWT verification ──────────────────────────────
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || ''
let cfKeysCache = null
let cfKeysCacheExpiry = 0

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function decodeJwt(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return {
      header: JSON.parse(base64urlDecode(parts[0])),
      payload: JSON.parse(base64urlDecode(parts[1])),
      signatureB64: parts[2],
      signedPart: `${parts[0]}.${parts[1]}`,
    }
  } catch {
    return null
  }
}

async function fetchCfKeys(issuer) {
  const now = Date.now()
  if (cfKeysCache && now < cfKeysCacheExpiry) return cfKeysCache
  const url = `${issuer}/cdn-cgi/access/certs`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  cfKeysCache = data.public_certs || []
  cfKeysCacheExpiry = now + 3600000
  return cfKeysCache
}

async function verifyCfAccess(req) {
  const token = req.headers['cf-access-jwt-assertion']
  if (!token) return { valid: false, reason: 'Missing Cf-Access-Jwt-Assertion header' }

  const decoded = decodeJwt(token)
  if (!decoded) return { valid: false, reason: 'Malformed JWT' }

  const { payload, signatureB64, signedPart } = decoded

  const now = Math.floor(Date.now() / 1000)
  if (!payload.exp || payload.exp < now) {
    return { valid: false, reason: 'Token expired' }
  }

  if (!payload.iss || !payload.iss.includes('.cloudflareaccess.com')) {
    return { valid: false, reason: 'Invalid issuer' }
  }

  if (CF_ACCESS_AUD) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.includes(CF_ACCESS_AUD)) {
      return { valid: false, reason: 'Audience mismatch' }
    }
  }

  let certs
  try {
    certs = await fetchCfKeys(payload.iss)
  } catch (err) {
    return { valid: false, reason: `Key fetch failed: ${err.message}` }
  }

  if (!certs || certs.length === 0) {
    return { valid: false, reason: 'No public keys available' }
  }

  const sigBuf = base64urlDecode(signatureB64)
  for (const cert of certs) {
    try {
      const pubKey = createPublicKey(cert.cert)
      if (cryptoVerify('RSA-SHA256', Buffer.from(signedPart), pubKey, sigBuf)) {
        return { valid: true, email: payload.email }
      }
    } catch {
      continue
    }
  }

  return { valid: false, reason: 'Signature verification failed' }
}

function accessDeniedPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Access Denied</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; text-align: center; }
    h1 { color: #f44336; font-size: 2em; margin-bottom: 10px; }
    p { color: #aaa; line-height: 1.6; }
    .lock { font-size: 4em; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="lock">&#128274;</div>
  <h1>Access Denied</h1>
  <p>This service requires authentication through Cloudflare Access.</p>
  <p>If you should have access, ensure you are accessing this service<br>through the configured domain and have completed authentication.</p>
</body>
</html>`
}

// ── Paired device loading + file watching ────────────────────────────

function loadPairedDevices() {
  try {
    const raw = readFileSync(PAIRED_JSON, 'utf8')
    if (raw === lastPairedJson) return
    lastPairedJson = raw
    const data = JSON.parse(raw)
    const map = new Map()
    for (const [id, entry] of Object.entries(data)) {
      if (!entry.tokens) continue
      const tokenSet = new Set()
      for (const roleEntry of Object.values(entry.tokens)) {
        if (roleEntry.token) tokenSet.add(roleEntry.token)
      }
      if (tokenSet.size > 0) map.set(id, tokenSet)
    }
    pairedDevices = map
    console.log(`[dashboard] Loaded ${map.size} paired device(s)`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.log(`[dashboard] Error reading paired.json: ${err.message}`)
    }
    lastPairedJson = ''
    pairedDevices = new Map()
  }
}

function watchPairedDevices() {
  let debounceTimer = null
  const reload = () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => loadPairedDevices(), 500)
  }
  try {
    watch(PAIRED_JSON, reload)
  } catch {
    /* file may not exist yet */
  }
  watchFile(PAIRED_JSON, { interval: 5000 }, reload)
}

function isDeviceTokenValid(deviceId, token) {
  const tokens = pairedDevices.get(deviceId)
  return !!tokens && tokens.has(token)
}

// ── Session cookie (HMAC-signed, stateless) ──────────────────────────

function signSessionCookie(deviceId) {
  const ts = Date.now().toString()
  const hmac = createHmac('sha256', GATEWAY_TOKEN).update(`${deviceId}.${ts}`).digest('hex')
  return `${deviceId}.${ts}.${hmac}`
}

function verifySessionCookie(cookieValue) {
  // Split from the right: HMAC is always 64 hex chars, timestamp is numeric.
  // This safely handles device IDs that contain dots.
  const lastDot = cookieValue.lastIndexOf('.')
  if (lastDot === -1) return null
  const secondLastDot = cookieValue.lastIndexOf('.', lastDot - 1)
  if (secondLastDot === -1) return null
  const deviceId = cookieValue.slice(0, secondLastDot)
  const ts = cookieValue.slice(secondLastDot + 1, lastDot)
  const hmac = cookieValue.slice(lastDot + 1)
  if (!deviceId || !ts || !hmac) return null

  const elapsed = Date.now() - parseInt(ts, 10)
  if (isNaN(elapsed) || elapsed < 0 || elapsed > SESSION_MAX_AGE * 1000) return null

  const expected = createHmac('sha256', GATEWAY_TOKEN).update(`${deviceId}.${ts}`).digest('hex')
  if (expected.length !== hmac.length) return null
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(hmac, 'hex')
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  return { deviceId }
}

function getSessionCookie(req) {
  const header = req.headers.cookie || ''
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=')
  }
  return null
}

function sessionCookieHeader(value) {
  const cookiePath = effectiveBP || '/'
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${SESSION_MAX_AGE}`
}

// ── Auth gate page ───────────────────────────────────────────────────

export function authGatePage() {
  const gatewayUrl = effectiveBP ? effectiveBP.replace(/\/[^/]+$/, '/') || '/' : '/'
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dashboard — Device Pairing Required</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; text-align: center; }
    h1 { color: #f0f0f0; font-size: 1.6em; margin-bottom: 10px; }
    p { color: #aaa; line-height: 1.6; }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .icon { font-size: 4em; margin-bottom: 20px; }
    .status { margin-top: 20px; padding: 12px; border-radius: 6px; }
    .status.checking { background: #1a2a3e; color: #64b5f6; }
    .status.error { background: #2e1a1a; color: #f44336; }
    .status.not-paired { background: #2e2a1a; color: #ffa726; }
  </style>
</head>
<body>
  <div class="icon">&#128279;</div>
  <h1>Device Pairing Required</h1>
  <div id="status" class="status checking">Checking device pairing...</div>
  <script>
    (function() {
      var status = document.getElementById('status');
      var authKey = 'openclaw.device.auth.v1';
      var stored = null;
      try { stored = JSON.parse(localStorage.getItem(authKey)); } catch(e) {}

      var deviceToken = null;
      if (stored && stored.tokens) {
        var roles = Object.keys(stored.tokens);
        for (var i = 0; i < roles.length; i++) {
          if (stored.tokens[roles[i]] && stored.tokens[roles[i]].token) {
            deviceToken = stored.tokens[roles[i]].token;
            break;
          }
        }
      }

      if (!stored || !stored.deviceId || !deviceToken) {
        status.className = 'status not-paired';
        status.innerHTML = '<p>No paired device found.</p>' +
          '<p>Pair a device with the gateway first, then revisit this page.</p>' +
          '<p><a href="${gatewayUrl}">Go to Gateway Control UI</a></p>';
        return;
      }

      status.textContent = 'Authenticating with gateway...';

      fetch('${effectiveBP}/_auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: stored.deviceId, token: deviceToken }),
        credentials: 'same-origin'
      }).then(function(res) {
        if (res.ok) {
          window.location.reload();
        } else if (res.status === 403) {
          status.className = 'status error';
          status.innerHTML = '<p>Device not recognized. Your device may have been revoked.</p>' +
            '<p>Re-pair with the gateway and try again.</p>' +
            '<p><a href="${gatewayUrl}">Go to Gateway Control UI</a></p>';
        } else {
          status.className = 'status error';
          status.innerHTML = '<p>Authentication error (HTTP ' + res.status + '). Try refreshing.</p>';
        }
      }).catch(function(err) {
        status.className = 'status error';
        status.innerHTML = '<p>Network error: ' + err.message + '</p>';
      });
    })();
  </script>
</body>
</html>`
}

// ── Auth endpoint handler ────────────────────────────────────────────

export function handleAuthPost(req, res) {
  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 4096) {
      aborted = true
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request too large' }))
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const { deviceId, token } = parsed
    if (!deviceId || !token) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing deviceId or token' }))
      return
    }

    if (!isDeviceTokenValid(deviceId, token)) {
      console.log(`[dashboard] Auth failed: device ${deviceId} not found or token mismatch`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Device not recognized' }))
      return
    }

    const cookie = signSessionCookie(deviceId)
    console.log(`[dashboard] Auth success: device ${deviceId}`)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader(cookie),
    })
    res.end(JSON.stringify({ ok: true }))
  })
}

// ── CF Access check (Layer 1) ────────────────────────────────────────
// Returns false and writes 403 response if access denied.

export async function checkCfAccess(req, res) {
  const auth = await verifyCfAccess(req)
  if (!auth.valid) {
    console.log(`[dashboard] Access denied: ${auth.reason} (${req.socket.remoteAddress})`)
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(accessDeniedPage())
    return false
  }
  return true
}

// ── Session cookie check (Layer 2) ───────────────────────────────────
// Returns false and writes auth gate page if no valid session.

export function checkSession(req, res) {
  const cookieVal = getSessionCookie(req)
  const session = cookieVal ? verifySessionCookie(cookieVal) : null
  if (!session) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(authGatePage())
    return false
  }
  return true
}

// ── WebSocket auth check (both layers) ───────────────────────────────

export async function checkWs(req, socket) {
  const auth = await verifyCfAccess(req)
  if (!auth.valid) {
    console.log(`[dashboard] WS access denied: ${auth.reason} (${req.socket.remoteAddress})`)
    socket.destroy()
    return false
  }

  if (PAIRING_AUTH_ENABLED) {
    const cookieVal = getSessionCookie(req)
    const session = cookieVal ? verifySessionCookie(cookieVal) : null
    if (!session) {
      console.log(`[dashboard] WS pairing auth denied: no valid session cookie (${req.socket.remoteAddress})`)
      socket.destroy()
      return false
    }
  }

  return true
}

// ── Initialization ───────────────────────────────────────────────────

export function init() {
  if (PAIRING_AUTH_ENABLED) {
    loadPairedDevices()
    watchPairedDevices()
  } else {
    console.log('[dashboard] OPENCLAW_GATEWAY_TOKEN not set — device pairing auth disabled')
  }
}
