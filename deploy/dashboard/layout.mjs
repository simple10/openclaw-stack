// layout.mjs — Shared page chrome for the OpenClaw dashboard.
// Wraps page-specific body HTML in a consistent shell: header with nav,
// CSS/theme imports, and footer. All pages call renderPage() to generate
// the full HTML response.

import { getEffectiveBP } from './auth.mjs'

const CONTROL_UI_BASE = process.env.OPENCLAW_DOMAIN_PATH || ''
const CACHE_BUST = Date.now()

export function renderPage({ title, bodyHtml, headExtra = '', basePath }) {
  const bp = basePath ?? getEffectiveBP()
  const cui = CONTROL_UI_BASE
  const v = CACHE_BUST

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title || 'OpenClaw Mission Control'}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg viewBox='0 0 120 120' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='lg' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23ff4d4d'/%3E%3Cstop offset='100%25' stop-color='%23991b1b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z' fill='url(%23lg)'/%3E%3Cpath d='M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z' fill='url(%23lg)'/%3E%3Cpath d='M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z' fill='url(%23lg)'/%3E%3Ccircle cx='45' cy='35' r='6' fill='%23050810'/%3E%3Ccircle cx='75' cy='35' r='6' fill='%23050810'/%3E%3Ccircle cx='46' cy='34' r='2.5' fill='%2300e5cc'/%3E%3Ccircle cx='76' cy='34' r='2.5' fill='%2300e5cc'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${bp}/public/dashboard.css?v=${v}">
<script>window.__DASHBOARD_BASE="${bp}";</script>
<script type="module" src="${bp}/public/theme-engine.js?v=${v}"></script>
<script type="module" src="${bp}/public/charts.js?v=${v}"></script>
${headExtra}
</head>
<body>
<div class="container">

<div class="header">
  <div class="header-left">
    <div class="avatar"><svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28"><defs><linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#lg)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#lg)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#lg)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg></div>
    <div>
      <a href="${bp}/" class="header-title-link">OpenClaw Mission Control</a>
      <div class="header-nav">
        <a href="${bp}/browsers/">Browsers</a>
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
<div style="text-align:center;padding:12px;font-size:10px;color:var(--darker)">OpenClaw Mission Control · Auto-refresh 60s</div>
</body>
</html>`
}
