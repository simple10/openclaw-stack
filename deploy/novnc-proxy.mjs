#!/usr/bin/env node

// noVNC reverse proxy + media file server — routes browser sandbox noVNC UIs
// and serves agent-generated media files on a fixed port.
// Reads browsers.json on each request to discover sandbox containers and
// their dynamically-mapped noVNC ports. Zero dependencies (built-in http only).
//
// URL routing (all paths below are relative to NOVNC_BASE_PATH if set):
//   GET /                     → index page listing active sessions
//   GET /media/               → directory listing of media files
//   GET /media/<path>         → serve static file from ~/.openclaw/media/
//   GET /<agent-id>/          → redirect to noVNC client
//   GET /<agent-id>/*         → proxy to browser container's noVNC
//   WS  /<agent-id>/websockify → WebSocket proxy for VNC stream

import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, createReadStream, readdirSync, lstatSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve, extname, join } from 'node:path';

const PORT = 6090;
const BROWSERS_JSON = '/home/node/.openclaw/sandbox/browsers.json';
const MEDIA_ROOT = '/home/node/.openclaw/media';

// Base path for running behind a Cloudflare Tunnel path prefix (e.g., "/browser").
// When set, all incoming requests must start with this prefix (stripped before routing)
// and all generated URLs include it.
const RAW_BASE = process.env.NOVNC_BASE_PATH || '';
const BASE_PATH = RAW_BASE === '/' ? '' : RAW_BASE.replace(/\/+$/, '');
// Ensure it starts with / if non-empty
const BP = BASE_PATH && !BASE_PATH.startsWith('/') ? `/${BASE_PATH}` : BASE_PATH;

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
  const mediaLink = `<p style="margin-top: 16px;"><a href="${BP}/media/">&#128196; Media Files</a> — screenshots, PDFs, and downloads from agents</p>`;
  if (entries.length === 0) {
    return htmlPage('OpenClaw Browser Sessions',
      `<h1>OpenClaw Browser Sessions</h1>
       <p class="empty">No active browser sessions. Browser containers are created on-demand when agents use the browser tool.</p>
       ${mediaLink}`);
  }

  // Strip leading / from BP for the WebSocket path param (noVNC expects a relative path)
  const wsPrefix = BP.startsWith('/') ? BP.slice(1) : BP;
  const rows = await Promise.all(entries.map(async (e) => {
    const id = e.sessionKey.replace('agent:', '');
    const up = await isPortOpen(e.noVncPort);
    const statusDot = `<span class="status ${up ? 'up' : 'down'}"></span>`;
    const link = up
      ? `<a href="${BP}/${id}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${id}/websockify">${id}</a>`
      : `${id}`;
    return `<tr>
      <td>${statusDot}${link}</td>
      <td>${e.containerName}</td>
      <td>${up ? 'Running' : 'Stopped'}</td>
    </tr>`;
  }));

  return htmlPage('OpenClaw Browser Sessions',
    `<h1>OpenClaw Browser Sessions</h1>
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
     <p style="margin-top: 24px;"><a href="${BP}/">&larr; Back to sessions</a></p>`);
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
    ...dirs.map(e => `<tr><td>&#128193; <a href="${prefix}${e.name}/">${e.name}/</a></td><td>&mdash;</td></tr>`),
    ...files.map(e => `<tr><td>&#128196; <a href="${prefix}${e.name}">${e.name}</a></td><td>${formatSize(e.size)}</td></tr>`),
  ];

  const mediaRoot = BP + '/media';
  const parentLink = urlPath === mediaRoot ? `${BP}/` : urlPath.replace(/\/[^/]+\/?$/, '/');
  const body = `<h1>Media Files &mdash; ${urlPath.replace(mediaRoot, '') || '/'}</h1>
     <p><a href="${parentLink}">&larr; Back</a></p>
     ${rows.length === 0
       ? '<p class="empty">No files yet. Media files appear here when agents capture screenshots or download files.</p>'
       : `<table>
       <thead><tr><th>Name</th><th>Size</th></tr></thead>
       <tbody>${rows.join('\n')}</tbody>
     </table>`}`;

  return htmlPage('Media Files', body);
}

function handleMediaRequest(req, res, path) {
  // Strip BP + /media prefix to get relative path for filesystem access
  const mediaPrefix = BP + '/media';
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = url.pathname;

  // Base path enforcement: if BP is set, all requests must start with it
  if (BP) {
    if (path === BP) {
      // Redirect /browser → /browser/
      res.writeHead(302, { Location: `${BP}/` });
      res.end();
      return;
    }
    if (!path.startsWith(BP + '/')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // Strip the base path prefix for internal routing
    path = path.slice(BP.length);
  }

  // Index page
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await indexPage());
    return;
  }

  // Media file serving
  if (path === '/media' || path.startsWith('/media/')) {
    // Pass the BP-prefixed path so directory listings generate correct links
    const mediaPath = path === '/media' ? '/media/' : path;
    handleMediaRequest(req, res, BP + mediaPath);
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
    // WebSocket path param is relative (no leading /) — include BP without leading /
    const wsPrefix = BP.startsWith('/') ? BP.slice(1) : BP;
    res.writeHead(302, { Location: `${BP}/${agentId}/vnc.html?path=${wsPrefix ? wsPrefix + '/' : ''}${agentId}/websockify` });
    res.end();
    return;
  }

  const entry = findEntry(agentId);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Not Found',
      `<h1>Session Not Found</h1>
       <p>No browser session for agent <strong>"${agentId}"</strong>.</p>
       <p><a href="${BP}/">&larr; Back to sessions</a></p>`));
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
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let wsPath = url.pathname;

  // Strip base path prefix for WebSocket routing
  if (BP) {
    if (!wsPath.startsWith(BP + '/')) {
      socket.destroy();
      return;
    }
    wsPath = wsPath.slice(BP.length);
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
  console.log(`[novnc-proxy] Listening on port ${PORT}${BP ? `, base path: ${BP}` : ''}`);
});
