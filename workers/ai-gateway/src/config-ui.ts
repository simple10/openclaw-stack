/** Serve the self-service credential configuration page. */
export function serveConfigPage(): Response {
  return new Response(CONFIG_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

const CONFIG_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Gateway Config</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0c0c0c; --surface: #161616; --border: #2a2a2a;
    --text: #e0e0e0; --dim: #777; --accent: #3b82f6; --accent-hover: #2563eb;
    --danger: #ef4444; --danger-hover: #dc2626; --success: #22c55e;
    --radius: 8px; --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1rem; }
  label { display: block; font-size: 0.8rem; color: var(--dim); margin-bottom: 0.3rem; }
  input[type="text"], input[type="password"], textarea {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 0.6rem 0.75rem; font-family: var(--mono); font-size: 0.85rem;
    outline: none; transition: border-color 0.15s;
  }
  input:focus, textarea:focus { border-color: var(--accent); }
  input:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  textarea { resize: vertical; min-height: 80px; }
  .field { margin-bottom: 1rem; }
  .field:last-child { margin-bottom: 0; }
  .field-row { display: flex; gap: 0.5rem; align-items: flex-start; }
  .field-row input, .field-row textarea { flex: 1; }
  .hint { font-size: 0.75rem; color: var(--dim); margin-top: 0.25rem; }
  .existing { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
  .existing code { font-family: var(--mono); font-size: 0.8rem; background: var(--bg); padding: 0.2rem 0.5rem; border-radius: 4px; color: var(--success); }
  .existing .oauth-info { font-size: 0.8rem; color: var(--success); }
  .cleared-tag { font-size: 0.8rem; color: var(--danger); font-style: italic; }
  button {
    padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer;
    font-size: 0.85rem; font-weight: 500; transition: background 0.15s;
  }
  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); padding: 0.3rem 0.6rem; font-size: 0.75rem; }
  .btn-danger:hover { background: var(--danger); color: white; }
  .btn-small { background: transparent; color: var(--dim); border: 1px solid var(--border); padding: 0.3rem 0.6rem; font-size: 0.75rem; }
  .btn-small:hover { background: var(--border); color: var(--text); }
  .status { margin-top: 1rem; padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.85rem; display: none; }
  .status.error { display: block; background: #1a0505; border: 1px solid var(--danger); color: var(--danger); }
  .status.success { display: block; background: #051a0a; border: 1px solid var(--success); color: var(--success); }
  .provider-section { margin-bottom: 1.5rem; }
  .provider-section:last-child { margin-bottom: 0; }
  .provider-header { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  .actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 1.25rem; }
  #config-section { display: none; }
</style>
</head>
<body>
<div class="container">
  <h1>AI Gateway Configuration</h1>

  <div id="auth-section" class="card">
    <h2>Authenticate</h2>
    <div class="field">
      <label for="token-input">Gateway Token</label>
      <div class="field-row">
        <input type="password" id="token-input" placeholder="Enter your gateway auth token">
        <button class="btn-primary" id="auth-btn">Connect</button>
      </div>
    </div>
    <div id="auth-status" class="status"></div>
  </div>

  <div id="config-section">
    <div class="card">
      <h2>Provider Credentials</h2>

      <div class="provider-section">
        <div class="provider-header">Anthropic</div>
        <div class="field" data-field="anthropic.apiKey">
          <label>API Key <span class="hint">(sk-ant-api-*)</span></label>
          <div class="existing" style="display:none"></div>
          <div class="field-row">
            <input type="text" placeholder="sk-ant-api-..." autocomplete="off" spellcheck="false">
          </div>
          <div class="hint">Regular Anthropic API key</div>
        </div>
        <div class="field" data-field="anthropic.oauthToken">
          <label>OAuth Token <span class="hint">(sk-ant-oat-*) — takes priority over API key</span></label>
          <div class="existing" style="display:none"></div>
          <div class="field-row">
            <input type="text" placeholder="sk-ant-oat-..." autocomplete="off" spellcheck="false">
          </div>
          <div class="hint">Claude Code subscription token</div>
        </div>
      </div>

      <div class="provider-section">
        <div class="provider-header">OpenAI</div>
        <div class="field" data-field="openai.apiKey">
          <label>API Key</label>
          <div class="existing" style="display:none"></div>
          <div class="field-row">
            <input type="text" placeholder="sk-..." autocomplete="off" spellcheck="false">
          </div>
          <div class="hint">Static OpenAI API key</div>
        </div>
        <div class="field" data-field="openai.oauth">
          <label>Codex OAuth <span class="hint">— takes priority over API key</span></label>
          <div class="existing" style="display:none"></div>
          <div class="field-row">
            <textarea placeholder="Paste .codex/auth.json contents here..." spellcheck="false"></textarea>
          </div>
          <div class="hint">Paste the full JSON from ~/.codex/auth.json — we'll extract the tokens automatically</div>
        </div>
      </div>

      <details style="margin-top:1rem;">
        <summary style="cursor:pointer; font-size:0.95rem; font-weight:600; color:var(--dim); padding:0.5rem 0;">Additional Providers</summary>
        <div style="margin-top:0.75rem;">
          <div class="field" data-field="providers.cohere.apiKey">
            <label>Cohere API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.deepseek.apiKey">
            <label>DeepSeek API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.fireworks.apiKey">
            <label>Fireworks API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.groq.apiKey">
            <label>Groq API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.minimax.apiKey">
            <label>MiniMax API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.mistral.apiKey">
            <label>Mistral API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.moonshot.apiKey">
            <label>Moonshot API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.openrouter.apiKey">
            <label>OpenRouter API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.perplexity.apiKey">
            <label>Perplexity API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.together.apiKey">
            <label>Together API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
          <div class="field" data-field="providers.xai.apiKey">
            <label>xAI API Key</label>
            <div class="existing" style="display:none"></div>
            <div class="field-row"><input type="text" placeholder="API key" autocomplete="off" spellcheck="false"></div>
          </div>
        </div>
      </details>

      <div class="actions">
        <button class="btn-primary" id="save-btn">Save Changes</button>
      </div>
      <div id="save-status" class="status"></div>
    </div>

    <div id="codex-token-section" class="card" style="display:none">
      <h2>OpenClaw Codex Paste Token</h2>
      <p style="font-size:0.85rem; color:var(--dim); margin-bottom:1rem;">
        A gateway auth token was generated for OpenClaw. Run this in your OpenClaw container:
      </p>
      <pre style="background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:0.6rem 0.75rem; font-family:var(--mono); font-size:0.8rem; color:var(--accent); margin-bottom:1rem; overflow-x:auto;">openclaw models auth paste-token --provider openai-codex --expiresIn 999d</pre>
      <p style="font-size:0.85rem; color:var(--dim); margin-bottom:0.5rem;">Then paste this token when prompted:</p>
      <div class="field">
        <textarea id="codex-token-display" readonly style="min-height:60px; font-size:0.75rem; color:var(--success); cursor:text;"></textarea>
      </div>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
        <button class="btn-small" id="copy-codex-token">Copy Token</button>
        <button class="btn-small" id="regen-codex-token">Regenerate</button>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  const $ = s => document.querySelector(s);
  const authToken = () => sessionStorage.getItem('gw-token');

  // --- Auth ---
  $('#auth-btn').addEventListener('click', connect);
  $('#token-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect() });

  async function connect() {
    const token = $('#token-input').value.trim();
    if (!token) return;
    sessionStorage.setItem('gw-token', token);
    showStatus('#auth-status', '');

    try {
      const res = await api('GET', '/auth/creds');
      if (res.status === 401) {
        showStatus('#auth-status', 'Invalid token', 'error');
        return;
      }
      if (!res.ok) {
        showStatus('#auth-status', 'Error: ' + (await res.text()), 'error');
        return;
      }
      const creds = await res.json();
      $('#auth-section').style.display = 'none';
      $('#config-section').style.display = 'block';
      populateForm(creds);
    } catch (err) {
      showStatus('#auth-status', 'Connection failed: ' + err.message, 'error');
    }
  }

  // --- Populate form with masked creds ---
  const fieldState = {};

  function populateForm(creds) {
    document.querySelectorAll('[data-field]').forEach(el => {
      const path = el.dataset.field;
      const val = getNestedValue(creds, path);
      fieldState[path] = { existing: !!val, cleared: false };

      const existingEl = el.querySelector('.existing');
      const input = el.querySelector('input, textarea');

      if (val) {
        existingEl.style.display = 'flex';
        if (path === 'openai.oauth' && typeof val === 'object') {
          const exp = val.expiresAt ? new Date(val.expiresAt).toLocaleString() : 'unknown';
          existingEl.innerHTML =
            '<span class="oauth-info">Configured (expires ' + escapeHtml(exp) + ')</span> ' +
            '<button class="btn-danger" type="button">Clear</button>';
        } else {
          existingEl.innerHTML =
            '<code>' + escapeHtml(val) + '</code> ' +
            '<button class="btn-danger" type="button">Clear</button>';
        }
        existingEl.querySelector('.btn-danger').addEventListener('click', () => clearField(path));
      }
    });
  }

  function clearField(path) {
    const el = document.querySelector('[data-field="' + path + '"]');
    const existingEl = el.querySelector('.existing');
    existingEl.innerHTML = '<span class="cleared-tag">Will be removed on save</span> <button class="btn-small" type="button">Undo</button>';
    existingEl.querySelector('.btn-small').addEventListener('click', () => undoClear(path));
    fieldState[path].cleared = true;

    const input = el.querySelector('input, textarea');
    input.value = '';
    input.disabled = true;
  }

  function undoClear(path) {
    fieldState[path].cleared = false;
    // Re-fetch to restore the UI
    connect();
  }

  // --- Save ---
  $('#save-btn').addEventListener('click', save);

  async function save() {
    const btn = $('#save-btn');
    btn.disabled = true;
    showStatus('#save-status', '');

    try {
      const update = buildUpdate();
      if (!update) {
        btn.disabled = false;
        return;
      }
      if (Object.keys(update).length === 0) {
        showStatus('#save-status', 'No changes to save', 'error');
        btn.disabled = false;
        return;
      }

      const res = await api('PUT', '/auth/creds', update);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showStatus('#save-status', 'Error: ' + (body.error?.message || res.statusText), 'error');
        btn.disabled = false;
        return;
      }

      const updated = await res.json();
      showStatus('#save-status', 'Credentials saved', 'success');
      // Reset form with new masked values
      document.querySelectorAll('[data-field]').forEach(el => {
        el.querySelector('input, textarea').value = '';
        el.querySelector('input, textarea').disabled = false;
      });
      populateForm(updated);

      // Show codex paste token if generated
      if (updated.codexPasteToken) {
        showCodexToken(updated.codexPasteToken);
      }
    } catch (err) {
      showStatus('#save-status', 'Save failed: ' + err.message, 'error');
    }
    btn.disabled = false;
  }

  function buildUpdate() {
    const update = {};
    let hasError = false;

    document.querySelectorAll('[data-field]').forEach(el => {
      if (hasError) return;
      const path = el.dataset.field;
      const input = el.querySelector('input, textarea');
      const state = fieldState[path] || {};
      const newVal = input.value.trim();

      const segments = path.split('.');

      if (segments.length === 3) {
        // 3-segment path: providers.{name}.apiKey
        const [root, name, key] = segments;
        if (!update[root]) update[root] = {};
        if (!update[root][name]) update[root][name] = {};
        if (state.cleared) {
          update[root][name][key] = null;
        } else if (newVal) {
          update[root][name][key] = newVal;
        }
        // Clean up empty nested objects
        if (Object.keys(update[root][name]).length === 0) delete update[root][name];
        if (Object.keys(update[root]).length === 0) delete update[root];
      } else {
        // 2-segment path: {provider}.{key}
        const [provider, key] = segments;
        if (!update[provider]) update[provider] = {};

        if (state.cleared) {
          update[provider][key] = null;
        } else if (newVal) {
          if (path === 'openai.oauth') {
            const parsed = parseCodexAuth(newVal);
            if (parsed.error) {
              showStatus('#save-status', parsed.error, 'error');
              hasError = true;
              return;
            }
            update[provider][key] = parsed.value;
          } else {
            update[provider][key] = newVal;
          }
        }
      }
    });

    if (hasError) return null;

    // Remove provider keys with no actual changes
    for (const provider of Object.keys(update)) {
      if (typeof update[provider] === 'object' && Object.keys(update[provider]).length === 0) {
        delete update[provider];
      }
    }

    return update;
  }

  // --- Codex auth.json parser ---
  function parseCodexAuth(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { error: 'Invalid JSON in Codex OAuth field' };
    }

    // Support both direct { access_token } and nested { tokens: { access_token } }
    const tokens = data.tokens || data;

    if (!tokens.access_token || !tokens.refresh_token) {
      return { error: 'Codex JSON must contain access_token and refresh_token' };
    }

    // Decode JWT exp claim for expiresAt
    let expiresAt;
    try {
      const payload = JSON.parse(atob(tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      expiresAt = payload.exp * 1000; // JWT exp is epoch seconds → ms
    } catch {
      return { error: 'Could not decode expiry from access token JWT' };
    }

    return {
      value: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: expiresAt,
      }
    };
  }

  // --- Helpers ---
  function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer ' + authToken(), 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts);
  }

  function getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => o && o[k], obj);
  }

  function showStatus(selector, msg, type) {
    const el = $(selector);
    el.className = 'status' + (type ? ' ' + type : '');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // --- Codex paste token ---
  function showCodexToken(jwt) {
    $('#codex-token-display').value = jwt;
    $('#codex-token-section').style.display = 'block';
  }

  $('#copy-codex-token').addEventListener('click', () => {
    const token = $('#codex-token-display').value;
    navigator.clipboard.writeText(token).then(() => {
      const btn = $('#copy-codex-token');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Token'; }, 2000);
    });
  });

  $('#regen-codex-token').addEventListener('click', async () => {
    const btn = $('#regen-codex-token');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      const res = await api('POST', '/auth/codex-token');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showStatus('#save-status', 'Error: ' + (body.error?.message || res.statusText), 'error');
        return;
      }
      const data = await res.json();
      showCodexToken(data.codexPasteToken);
      showStatus('#save-status', 'New codex paste token generated', 'success');
    } catch (err) {
      showStatus('#save-status', 'Failed: ' + err.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Regenerate';
  });

  // Auto-connect if token stored
  if (authToken()) {
    $('#token-input').value = '••••••••';
    connect();
  }
})();
</script>
</body>
</html>`
