// theme-engine.js — Shared theme management for the OpenClaw dashboard.
// Loaded as a module by the layout chrome. Fetches theme definitions from
// the stats API, applies CSS custom properties, and renders the picker UI.
// Attaches functions to window for onclick handlers in the layout HTML.

const BASE = window.__DASHBOARD_BASE || '';
let THEMES = {}, currentTheme = 'midnight';

async function loadThemes() {
  try {
    const r = await fetch(BASE + '/stats/themes.json?t=' + Date.now());
    THEMES = await r.json();
  } catch (e) {
    console.warn('themes.json not found, using defaults');
    return;
  }
  const saved = localStorage.getItem('ocDashTheme');
  if (saved && THEMES[saved]) currentTheme = saved;
  applyTheme(currentTheme);
  renderThemeMenu();
}

function applyTheme(id) {
  const t = THEMES[id];
  if (!t) return;
  currentTheme = id;
  const root = document.documentElement;
  const c = t.colors;
  root.style.setProperty('--bg', c.bg);
  root.style.setProperty('--surface', c.surface);
  root.style.setProperty('--surfaceHover', c.surfaceHover);
  root.style.setProperty('--border', c.border);
  root.style.setProperty('--accent', c.accent);
  root.style.setProperty('--accent2', c.accent2);
  root.style.setProperty('--green', c.green);
  root.style.setProperty('--yellow', c.yellow);
  root.style.setProperty('--red', c.red);
  root.style.setProperty('--orange', c.orange);
  root.style.setProperty('--purple', c.purple);
  root.style.setProperty('--text', c.text);
  root.style.setProperty('--textStrong', c.textStrong);
  root.style.setProperty('--muted', c.muted);
  root.style.setProperty('--dim', c.dim);
  root.style.setProperty('--darker', c.darker);
  root.style.setProperty('--tableBg', c.tableBg);
  root.style.setProperty('--tableHover', c.tableHover);
  root.style.setProperty('--scrollThumb', c.scrollThumb);
  localStorage.setItem('ocDashTheme', id);
  renderThemeMenu();
}

function safeColor(v) {
  return /^#[0-9a-fA-F]{3,8}$/.test(v || '') ? v : '#888888';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderThemeMenu() {
  const menu = document.getElementById('themeMenu');
  if (!menu) return;
  const darkThemes = Object.entries(THEMES).filter(([, t]) => t.type === 'dark');
  const lightThemes = Object.entries(THEMES).filter(([, t]) => t.type === 'light');
  let html = '<div class="theme-menu-label">Dark Themes</div>';
  darkThemes.forEach(([id, t]) => {
    const accent = safeColor(t.colors && t.colors.accent ? t.colors.accent : '#888888');
    html += `<button class="theme-opt${id === currentTheme ? ' active' : ''}" onclick="applyTheme('${esc(id)}');event.stopPropagation()"><span class="theme-opt-icon">${esc(t.icon)}</span><span>${esc(t.name)}</span><span class="theme-opt-swatch" style="background:${accent};margin-left:auto"></span></button>`;
  });
  html += '<div class="theme-menu-label" style="margin-top:4px">Light Themes</div>';
  lightThemes.forEach(([id, t]) => {
    const accent = safeColor(t.colors && t.colors.accent ? t.colors.accent : '#888888');
    html += `<button class="theme-opt${id === currentTheme ? ' active' : ''}" onclick="applyTheme('${esc(id)}');event.stopPropagation()"><span class="theme-opt-icon">${esc(t.icon)}</span><span>${esc(t.name)}</span><span class="theme-opt-swatch" style="background:${accent};margin-left:auto"></span></button>`;
  });
  menu.innerHTML = html;
}

function toggleThemeMenu() {
  const menu = document.getElementById('themeMenu');
  menu.classList.toggle('open');
}

// Close theme menu when clicking outside
document.addEventListener('click', e => {
  const picker = document.querySelector('.theme-picker');
  if (picker && !picker.contains(e.target)) {
    document.getElementById('themeMenu').classList.remove('open');
  }
});

// Auto-initialize on module load
loadThemes();

// Expose to window for onclick handlers in layout chrome
window.applyTheme = applyTheme;
window.toggleThemeMenu = toggleThemeMenu;
window.loadThemes = loadThemes;
