#!/usr/bin/env node

// Dashboard server — browser sessions, media files, and future log viewer.
// Routes browser sandbox noVNC UIs, serves agent-generated media files,
// and will host additional dashboard features on a fixed port.
// Reads browsers.json on each request to discover sandbox containers and
// their dynamically-mapped noVNC ports. Zero dependencies (Node.js built-ins only).
//
// Security: All requests must pass Cloudflare Access JWT verification.
// The JWT signature is cryptographically verified against Cloudflare's
// published public keys. Requests without a valid JWT are rejected with 403.
//
// URL routing (all paths below are relative to DASHBOARD_BASE_PATH if set):
//   GET /                     → index page listing active sessions + dashboard links
//   GET /media/               → directory listing of media files
//   GET /media/<path>         → serve static file from ~/.openclaw/media/
//   GET /<agent-id>/          → redirect to noVNC client
//   GET /<agent-id>/*         → proxy to browser container's noVNC
//   WS  /<agent-id>/websockify → WebSocket proxy for VNC stream

import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, createReadStream, readdirSync, lstatSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve, extname, join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const PORT = 6090;
const BROWSERS_JSON = '/home/node/.openclaw/sandbox/browsers.json';
const MEDIA_ROOT = '/home/node/.openclaw/media';

// Base path for running behind a Cloudflare Tunnel path prefix (e.g., "/dashboard").
// When set, all incoming requests must start with this prefix (stripped before routing)
// and all generated URLs include it.
const RAW_BASE = process.env.DASHBOARD_BASE_PATH || '';
const BASE_PATH = RAW_BASE === '/' ? '' : RAW_BASE.replace(/\/+$/, '');
// Ensure it starts with / if non-empty
const BP = BASE_PATH && !BASE_PATH.startsWith('/') ? `/${BASE_PATH}` : BASE_PATH;

// Auto-detected base path — set on first request when BP is empty and
// the first path segment doesn't match any known agent or reserved route.
// Once detected, used for URL generation (links, redirects) in all responses.
let effectiveBP = BP;

// ── Cloudflare Access JWT verification ──────────────────────────────
// Every request (HTTP and WebSocket) must carry a valid Cf-Access-Jwt-Assertion
// header. The JWT signature is verified against Cloudflare's published public
// keys fetched from the issuer's /cdn-cgi/access/certs endpoint.
// Set CF_ACCESS_AUD to also verify the audience claim matches your application.
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || '';
let cfKeysCache = null;
let cfKeysCacheExpiry = 0;

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(base64urlDecode(parts[0])),
      payload: JSON.parse(base64urlDecode(parts[1])),
      signatureB64: parts[2],
      signedPart: `${parts[0]}.${parts[1]}`,
    };
  } catch {
    return null;
  }
}

async function fetchCfKeys(issuer) {
  const now = Date.now();
  if (cfKeysCache && now < cfKeysCacheExpiry) return cfKeysCache;
  const url = `${issuer}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cfKeysCache = data.public_certs || [];
  cfKeysCacheExpiry = now + 3600000; // Cache for 1 hour
  return cfKeysCache;
}

async function verifyCfAccess(req) {
  const token = req.headers['cf-access-jwt-assertion'];
  if (!token) return { valid: false, reason: 'Missing Cf-Access-Jwt-Assertion header' };

  const decoded = decodeJwt(token);
  if (!decoded) return { valid: false, reason: 'Malformed JWT' };

  const { header, payload, signatureB64, signedPart } = decoded;

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    return { valid: false, reason: 'Token expired' };
  }

  // Verify issuer is Cloudflare Access
  if (!payload.iss || !payload.iss.includes('.cloudflareaccess.com')) {
    return { valid: false, reason: 'Invalid issuer' };
  }

  // Check audience if configured
  if (CF_ACCESS_AUD) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(CF_ACCESS_AUD)) {
      return { valid: false, reason: 'Audience mismatch' };
    }
  }

  // Verify signature against Cloudflare's published public keys
  let certs;
  try {
    certs = await fetchCfKeys(payload.iss);
  } catch (err) {
    return { valid: false, reason: `Key fetch failed: ${err.message}` };
  }

  if (!certs || certs.length === 0) {
    return { valid: false, reason: 'No public keys available' };
  }

  const sigBuf = base64urlDecode(signatureB64);
  for (const cert of certs) {
    try {
      const pubKey = createPublicKey(cert.cert);
      if (cryptoVerify('RSA-SHA256', Buffer.from(signedPart), pubKey, sigBuf)) {
        return { valid: true, email: payload.email };
      }
    } catch {
      continue;
    }
  }

  return { valid: false, reason: 'Signature verification failed' };
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
</html>`;
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function readBrowsers() {
  try {
    const data = readFileSync(BROWSERS_JSON, 'utf8');
    return JSON.parse(data).entries || [];
  } catch {
    return [];
  }
}

function findEntry(agentId) {
  const entries = readBrowsers();
  return entries.find(e => e.sessionKey === `agent:${agentId}`);
}

// Quick TCP probe — resolves true if port accepts connections, false otherwise
function isPortOpen(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

const CSS = `
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #f0f0f0; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #333; }
    th { color: #aaa; font-weight: 600; }
    a { color: #64b5f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { color: #888; margin-top: 30px; }
    .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
    .status.up { background: #4caf50; }
    .status.down { background: #f44336; }
    .note { color: #888; font-size: 0.85em; margin-top: 16px; }
    .dl { font-size: 1.2em; padding: 2px 6px; }
`;

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <meta http-equiv="refresh" content="10">
  <style>${CSS}</style>
</head>
<body>
  ${body}
</body>
</html>`;
}

async function indexPage() {
  const entries = readBrowsers();
  const mediaLink = `<p style="margin-top: 16px;"><a href="${effectiveBP}/media/">&#128196; Media Files</a> — screenshots, PDFs, and downloads from agents</p>`;
  if (entries.length === 0) {
    return htmlPage('OpenClaw Dashboard',
      `<h1>OpenClaw Dashboard</h1>
       <p class="empty">No active browser sessions. Browser containers are created on-demand when agents use the browser tool.</p>
       ${mediaLink}`);
  }

  // Strip leading / from effectiveBP for the WebSocket path param (noVNC expects a relative path)
  const wsPrefix = effectiveBP.startsWith('/') ? effectiveBP.slice(1) : effectiveBP;
  const rows = await Promise.all(entries.map(async (e) => {
    const id = e.sessionKey.replace('agent:', '');
    const up = await isPortOpen(e.noVncPort);
    const statusDot = `<span class="status ${up ? 'up' : 'down'}"></span>`;
    const link = up
      ? `<a href="${effectiveBP}/${id}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${id}/websockify">${id}</a>`
      : `${id}`;
    return `<tr>
      <td>${statusDot}${link}</td>
      <td>${e.containerName}</td>
      <td>${up ? 'Running' : 'Stopped'}</td>
    </tr>`;
  }));

  return htmlPage('OpenClaw Dashboard',
    `<h1>OpenClaw Dashboard</h1>
     <table>
       <thead><tr><th>Agent</th><th>Container</th><th>Status</th></tr></thead>
       <tbody>${rows.join('\n')}</tbody>
     </table>
     <p class="note">Page auto-refreshes every 10 seconds.</p>
     ${mediaLink}`);
}

function containerDownPage(agentId) {
  return htmlPage(`Browser Session — ${agentId}`,
    `<h1>Browser Not Running</h1>
     <p>The browser container for agent <strong>"${agentId}"</strong> is registered but not currently running.</p>
     <p>Browser containers are started on-demand when an agent uses the browser tool and are stopped when the session ends or the gateway restarts.</p>
     <p>Send a browser task to the agent to start a new session, then refresh this page.</p>
     <p style="margin-top: 24px;"><a href="${effectiveBP}/">&larr; Back to sessions</a></p>`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaDirectoryPage(dirPath, urlPath) {
  let entries;
  try {
    entries = readdirSync(dirPath).map(name => {
      try {
        const stat = lstatSync(join(dirPath, name));
        if (stat.isSymbolicLink()) return null;
        return { name, isDir: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return null;
  }

  // Directories first, then files — both sorted newest-first
  const dirs = entries.filter(e => e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const files = entries.filter(e => !e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const prefix = urlPath.endsWith('/') ? urlPath : urlPath + '/';
  const rows = [
    ...dirs.map(e => `<tr><td>&#128193; <a href="${prefix}${e.name}/">${e.name}/</a></td><td>&mdash;</td><td></td></tr>`),
    ...files.map(e => `<tr><td>&#128196; <a href="${prefix}${e.name}">${e.name}</a></td><td>${formatSize(e.size)}</td><td><a href="${prefix}${e.name}" download class="dl">&#8681;</a></td></tr>`),
  ];

  const mediaRoot = effectiveBP + '/media';
  const parentLink = urlPath === mediaRoot ? `${effectiveBP}/` : urlPath.replace(/\/[^/]+\/?$/, '/');
  const body = `<h1>Media Files &mdash; ${urlPath.replace(mediaRoot, '') || '/'}</h1>
     <p><a href="${parentLink}">&larr; Back</a></p>
     ${rows.length === 0
       ? '<p class="empty">No files yet. Media files appear here when agents capture screenshots or download files.</p>'
       : `<table>
       <thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>
       <tbody>${rows.join('\n')}</tbody>
     </table>`}`;

  return htmlPage('Media Files', body);
}

function handleMediaRequest(req, res, path) {
  // Strip effectiveBP + /media prefix to get relative path for filesystem access
  const mediaPrefix = effectiveBP + '/media';
  const relPath = decodeURIComponent(path.slice(mediaPrefix.length)) || '/';
  const resolved = resolve(MEDIA_ROOT, relPath.startsWith('/') ? relPath.slice(1) : relPath);

  // Path traversal protection
  if (!resolved.startsWith(MEDIA_ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    // If the media root itself doesn't exist, show a friendly empty page
    if (resolved === MEDIA_ROOT || resolved.startsWith(MEDIA_ROOT + '/')) {
      const html = htmlPage('Media Files',
        `<h1>Media Files</h1>
         <p><a href="${effectiveBP}/">&larr; Back to sessions</a></p>
         <p class="empty">No media files yet. Media files appear here when agents capture screenshots or download files.</p>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  // Reject symlinks
  if (stat.isSymbolicLink()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Directory listing
  if (stat.isDirectory()) {
    const html = mediaDirectoryPage(resolved, path.replace(/\/+$/, ''));
    if (!html) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading directory');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Serve file
  const mime = MIME_TYPES[extname(resolved).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(resolved).pipe(res);
}

const server = createServer(async (req, res) => {
  // ── Cloudflare Access gate ─────────────────────────────────────────
  const auth = await verifyCfAccess(req);
  if (!auth.valid) {
    console.log(`[dashboard] Access denied: ${auth.reason} (${req.socket.remoteAddress})`);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(accessDeniedPage());
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = url.pathname;

  // Base path handling: the proxy may receive requests with or without the
  // prefix depending on how the upstream reverse proxy (e.g., Cloudflare Tunnel)
  // is configured. Accept both forms and strip the prefix if present.
  if (BP) {
    if (path === BP) {
      // Redirect /browser → /browser/
      res.writeHead(302, { Location: `${BP}/` });
      res.end();
      return;
    }
    if (path.startsWith(BP + '/')) {
      // Upstream preserved the prefix — strip it for internal routing
      path = path.slice(BP.length);
    }
    // If path doesn't start with BP, the upstream already stripped it.
    // Route as-is — internal routing is the same either way.
  }

  // Auto-detect base path when DASHBOARD_BASE_PATH is not set.
  // If the first path segment isn't a known agent or "media", treat it as
  // a base path prefix — strip it for routing. This handles the case where
  // Cloudflare Tunnel sends /dashboard/... but DASHBOARD_BASE_PATH wasn't configured.
  if (!BP) {
    const seg = path.match(/^\/([^/]+)(\/.*)?$/);
    if (seg && seg[1] !== 'media' && !findEntry(seg[1])) {
      const detected = `/${seg[1]}`;
      if (!effectiveBP) {
        effectiveBP = detected;
        console.log(`[dashboard] Auto-detected base path: ${effectiveBP} (set DASHBOARD_BASE_PATH=${effectiveBP} to make this explicit)`);
      }
      if (effectiveBP === detected) {
        if (!seg[2]) {
          // Bare /prefix → redirect to /prefix/
          res.writeHead(302, { Location: `${detected}/` });
          res.end();
          return;
        }
        path = seg[2]; // Strip prefix, continue routing remainder
      }
    }
  }

  // Index page
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await indexPage());
    return;
  }

  // Media file serving
  if (path === '/media' || path.startsWith('/media/')) {
    // Pass the effectiveBP-prefixed path so directory listings generate correct links
    const mediaPath = path === '/media' ? '/media/' : path;
    handleMediaRequest(req, res, effectiveBP + mediaPath);
    return;
  }

  // Parse /<agent-id>/... pattern
  const match = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const agentId = match[1];
  const subPath = match[2] || '/';

  // Bare /<agent-id> or /<agent-id>/ → redirect to vnc.html
  if (subPath === '/') {
    // WebSocket path param is relative (no leading /) — include effectiveBP without leading /
    const wsPrefix = effectiveBP.startsWith('/') ? effectiveBP.slice(1) : effectiveBP;
    res.writeHead(302, { Location: `${effectiveBP}/${agentId}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${agentId}/websockify` });
    res.end();
    return;
  }

  const entry = findEntry(agentId);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Not Found',
      `<h1>Session Not Found</h1>
       <p>No browser session for agent <strong>"${agentId}"</strong>.</p>
       <p><a href="${effectiveBP}/">&larr; Back to sessions</a></p>`));
    return;
  }

  // Check if container is reachable before proxying
  const up = await isPortOpen(entry.noVncPort);
  if (!up) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(containerDownPage(agentId));
    return;
  }

  // Proxy HTTP request to browser container's noVNC
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: entry.noVncPort,
      path: subPath + url.search,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(containerDownPage(agentId));
    }
  });
  req.pipe(proxyReq);
});

// WebSocket upgrade handler
server.on('upgrade', async (req, socket, head) => {
  // ── Cloudflare Access gate ─────────────────────────────────────────
  const auth = await verifyCfAccess(req);
  if (!auth.valid) {
    console.log(`[dashboard] WS access denied: ${auth.reason} (${req.socket.remoteAddress})`);
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let wsPath = url.pathname;

  // Strip base path prefix for WebSocket routing (accept with or without prefix)
  if (BP && wsPath.startsWith(BP + '/')) {
    wsPath = wsPath.slice(BP.length);
  } else if (!BP && effectiveBP && wsPath.startsWith(effectiveBP + '/')) {
    wsPath = wsPath.slice(effectiveBP.length);
  }

  const match = wsPath.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const agentId = match[1];
  const subPath = match[2] || '/';
  const entry = findEntry(agentId);
  if (!entry) {
    socket.destroy();
    return;
  }

  // Connect to backend noVNC WebSocket
  const backend = connect(entry.noVncPort, '127.0.0.1', () => {
    // Forward the original HTTP upgrade request
    const reqLine = `${req.method} ${subPath + url.search} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    backend.write(reqLine + headers + '\r\n\r\n');
    if (head.length > 0) backend.write(head);
    // Pipe both directions
    socket.pipe(backend);
    backend.pipe(socket);
  });

  backend.on('error', () => socket.destroy());
  socket.on('error', () => backend.destroy());
});

server.listen(PORT, () => {
  console.log(`[dashboard] Listening on port ${PORT}${BP ? `, base path: ${BP}` : ' (no base path — will auto-detect from first request if needed)'}`);
});
