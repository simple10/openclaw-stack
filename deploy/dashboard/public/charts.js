// charts.js — Shared SVG chart renderers for the OpenClaw dashboard.
// Loaded as a module by the layout chrome. Renders cost trend, cost by model,
// and sub-agent activity charts. Attaches functions to window so page inline
// scripts can call them after data loads.

const $ = id => document.getElementById(id);
const COLORS = ['#6366f1', '#9333ea', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f87171', '#84cc16'];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderCostChart(id, data) {
  const W = 400, H = 300, P = { t: 20, r: 20, b: 40, l: 50 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const maxY = Math.max(...data.map(d => d.total)) || 1;
  const stepX = cw / (data.length - 1 || 1);
  let pts = data.map((d, i) => [P.l + i * stepX, P.t + ch - (d.total / maxY) * ch]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');
  const area = line + ` L${pts[pts.length - 1][0]},${P.t + ch} L${pts[0][0]},${P.t + ch} Z`;
  const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="var(--accent)"><title>${esc(data[i].label)}: $${data[i].total.toFixed(2)}</title></circle>`).join('');
  const yLabels = Array.from({ length: 5 }, (_, i) => { const v = maxY * i / 4; const y = P.t + ch - ch * i / 4; return `<text x="${P.l - 6}" y="${y + 3}" text-anchor="end" fill="var(--dim)" font-size="9">$${v.toFixed(0)}</text><line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="var(--border)" stroke-dasharray="2"/>` }).join('');
  const nth = Math.ceil(data.length / 7);
  const xLabels = data.map((d, i) => i % nth === 0 ? `<text x="${P.l + i * stepX}" y="${H - P.b + 16}" text-anchor="middle" fill="var(--dim)" font-size="9">${esc(d.label)}</text>` : '').join('');
  $(id).innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:350px">${yLabels}${xLabels}<path d="${area}" fill="var(--accent)" opacity="0.15"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}</svg>`;
}

function renderModelChart(id, data) {
  const W = 400, H = 300, P = { t: 20, r: 20, b: 55, l: 50 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const models = new Set(); data.forEach(d => { if (d.models) Object.keys(d.models).forEach(m => models.add(m)) });
  const mList = [...models];
  const maxY = Math.max(...data.map(d => Object.values(d.models || {}).reduce((a, v) => a + v, 0))) || 1;
  const barW = cw / data.length * 0.7, gap = cw / data.length * 0.3;
  let bars = '';
  data.forEach((d, i) => {
    let cum = 0; const x = P.l + i * (barW + gap) + gap / 2;
    mList.forEach((m, mi) => {
      const v = (d.models || {})[m] || 0; const h = (v / maxY) * ch;
      bars += `<rect x="${x}" y="${P.t + ch - cum - h}" width="${barW}" height="${h}" fill="${COLORS[mi % COLORS.length]}"><title>${esc(d.label)} ${esc(m)}: $${v.toFixed(2)}</title></rect>`;
      cum += h;
    });
  });
  const yLabels = Array.from({ length: 5 }, (_, i) => { const v = maxY * i / 4; const y = P.t + ch - ch * i / 4; return `<text x="${P.l - 6}" y="${y + 3}" text-anchor="end" fill="var(--dim)" font-size="9">$${v.toFixed(0)}</text><line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="var(--border)" stroke-dasharray="2"/>` }).join('');
  const nth = Math.ceil(data.length / 7);
  const xLabels = data.map((d, i) => i % nth === 0 ? `<text x="${P.l + i * (barW + gap) + gap / 2 + barW / 2}" y="${H - P.b + 16}" text-anchor="middle" fill="var(--dim)" font-size="9">${esc(d.label)}</text>` : '').join('');
  const legend = mList.map((m, i) => `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${COLORS[i % COLORS.length]}"></span>${esc(m)}</span>`).join('');
  $(id).innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:310px">${yLabels}${xLabels}${bars}</svg><div class="chart-legend">${legend}</div>`;
}

function renderSubagentChart(id, data) {
  const W = 400, H = 300, P = { t: 20, r: 50, b: 40, l: 50 };
  const cw = W - P.l - P.r, ch = H - P.t - P.b;
  const maxRuns = Math.max(...data.map(d => d.subagentRuns || 0)) || 1;
  const maxCost = Math.max(...data.map(d => d.subagentCost || 0)) || 1;
  const barW = cw / data.length * 0.6, gap = cw / data.length * 0.4;
  let bars = '', pts = [];
  data.forEach((d, i) => {
    const x = P.l + i * (barW + gap) + gap / 2;
    const h = ((d.subagentRuns || 0) / maxRuns) * ch;
    bars += `<rect x="${x}" y="${P.t + ch - h}" width="${barW}" height="${h}" fill="var(--purple)" opacity="0.6"><title>${esc(d.label)}: ${d.subagentRuns || 0} runs</title></rect>`;
    pts.push([x + barW / 2, P.t + ch - ((d.subagentCost || 0) / maxCost) * ch]);
  });
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="var(--accent)"><title>${esc(data[i].label)}: $${(data[i].subagentCost || 0).toFixed(2)}</title></circle>`).join('');
  const yL = Array.from({ length: 5 }, (_, i) => { const v = maxRuns * i / 4; const y = P.t + ch - ch * i / 4; return `<text x="${P.l - 6}" y="${y + 3}" text-anchor="end" fill="var(--dim)" font-size="9">${Math.round(v)}</text><line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="var(--border)" stroke-dasharray="2"/>` }).join('');
  const yR = Array.from({ length: 5 }, (_, i) => { const v = maxCost * i / 4; const y = P.t + ch - ch * i / 4; return `<text x="${W - P.r + 6}" y="${y + 3}" text-anchor="start" fill="var(--accent)" font-size="9">$${v.toFixed(0)}</text>` }).join('');
  const nth = Math.ceil(data.length / 7);
  const xLabels = data.map((d, i) => i % nth === 0 ? `<text x="${P.l + i * (barW + gap) + gap / 2 + barW / 2}" y="${H - P.b + 16}" text-anchor="middle" fill="var(--dim)" font-size="9">${esc(d.label)}</text>` : '').join('');
  $(id).innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:350px">${yL}${yR}${xLabels}${bars}<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}</svg><div class="chart-legend"><span class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--purple)"></span>Runs</span><span class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--accent)"></span>Cost</span></div>`;
}

// Expose to window for page inline scripts
window.renderCostChart = renderCostChart;
window.renderModelChart = renderModelChart;
window.renderSubagentChart = renderSubagentChart;
