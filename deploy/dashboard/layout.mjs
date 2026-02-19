// layout.mjs — Shared page chrome for the OpenClaw dashboard.
// Wraps page-specific body HTML in a consistent shell: header with nav,
// CSS/theme imports, and footer. All pages call renderPage() to generate
// the full HTML response.

import { getEffectiveBP } from './auth.mjs'

const CONTROL_UI_BASE = process.env.OPENCLAW_DOMAIN_PATH || ''

export function renderPage({ title, bodyHtml, headExtra = '', basePath }) {
  const bp = basePath ?? getEffectiveBP()
  const cui = CONTROL_UI_BASE

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title || 'OpenClaw Dashboard'}</title>
<link rel="stylesheet" href="${bp}/public/dashboard.css">
<script>window.__DASHBOARD_BASE="${bp}";</script>
<script type="module" src="${bp}/public/theme-engine.js"></script>
<script type="module" src="${bp}/public/charts.js"></script>
${headExtra}
</head>
<body>
<div class="container">

<div class="header">
  <div class="header-left">
    <div class="avatar">⚡</div>
    <div>
      <a href="${bp}/" class="header-title-link">OpenClaw Dashboard</a>
      <div class="header-nav">
        <a href="${bp}/">Home</a>
        <a href="${bp}/stats/">Stats</a>
        <a href="${bp}/media/">Media</a>
        <span class="nav-sep">|</span>
        <a href="${cui}/" class="nav-ext">Chat</a>
        <a href="${cui}/config" class="nav-ext">Config</a>
        <a href="${cui}/logs" class="nav-ext">Logs</a>
      </div>
    </div>
  </div>
  <div class="header-right">
    <span class="countdown" id="countdown">—</span>
    <span class="last-update" id="lastUpdate"></span>
    <div class="theme-picker">
      <button class="theme-btn" id="themeBtn" onclick="toggleThemeMenu()" title="Change theme">🎨</button>
      <div class="theme-menu" id="themeMenu"></div>
    </div>
    <button class="refresh-btn" onclick="loadData()">↻ Refresh</button>
  </div>
</div>

${bodyHtml}

</div>
<div style="text-align:center;padding:12px;font-size:10px;color:var(--darker)">OpenClaw Dashboard · Auto-refresh 60s</div>
</body>
</html>`
}
