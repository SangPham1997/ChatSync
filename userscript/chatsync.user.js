// ==UserScript==
// @name         ChatSync for DeepSeek ↔ VSCode
// @namespace    https://github.com/local/chatsync
// @version      0.1.0
// @description  Attach live VSCode context (active file / selection / problems) to the chat prompt and apply AI code blocks back into your editor. Talks to the ChatSync extension over http://127.0.0.1:7123.
// @author       ChatSync
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @connect      ::1
// @noframes
// ==/UserScript==

/* eslint-env browser */
(function () {
  'use strict';

  /* ================================================================== *
   * 0. Config
   * ================================================================== */

  // These two values are rewritten automatically by the VSCode command
  // "ChatSync: Save userscript into workspace" so you don't have to type them.
  const DEFAULTS = { port: 7123, token: '' };

  const SETTINGS_KEY = 'chatsync.settings.v1';
  const POLL_MS = 15000;
  const STABLE_MS = 1200; // a code block must be unchanged this long before Apply is enabled

  const state = {
    base: '',
    token: '',
    preview: true, // ask VSCode for a diff preview before writing
    autoSave: false,
    insertMode: 'replace', // default apply mode for "Apply to VSCode"
    health: null,
    lastHoveredBlock: null,
  };

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(gmGet(SETTINGS_KEY, '{}') || '{}');
    } catch (_) {
      saved = {};
    }
    let port = saved.port || DEFAULTS.port;
    if (port === 3847) port = DEFAULTS.port;
    let base = saved.base || `http://127.0.0.1:${port}`;
    if (base.includes(':3847')) base = base.replace(':3847', `:${DEFAULTS.port}`);
    state.base = base;
    state.token = saved.token || DEFAULTS.token || '';
    state.preview = saved.preview !== false;
    state.autoSave = saved.autoSave === true;
    state.insertMode = saved.insertMode || 'replace';
  }

  function saveSettings() {
    const url = new URL(state.base.startsWith('http') ? state.base : `http://${state.base}`);
    gmSet(
      SETTINGS_KEY,
      JSON.stringify({
        base: `${url.protocol}//${url.hostname}:${url.port || 7123}`,
        token: state.token,
        preview: state.preview,
        autoSave: state.autoSave,
        insertMode: state.insertMode,
      }),
    );
  }

  /* ================================================================== *
   * 1. Tiny abstraction over the userscript APIs (Tampermonkey/Violentmonkey)
   * ================================================================== */

  function gmGet(key, dflt) {
    if (typeof GM_getValue === 'function') return GM_getValue(key, dflt);
    try {
      const raw = localStorage.getItem(`__chatsync_${key}`);
      return raw === null ? dflt : raw;
    } catch (_) {
      return dflt;
    }
  }

  function gmSet(key, value) {
    if (typeof GM_setValue === 'function') return GM_setValue(key, value);
    try {
      localStorage.setItem(`__chatsync_${key}`, String(value));
    } catch (_) {
      /* ignore */
    }
  }

  function gmCopy(text) {
    if (typeof GM_setClipboard === 'function') return GM_setClipboard(text);
    try {
      navigator.clipboard.writeText(text);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * HTTP via GM_xmlhttpRequest → runs in the extension sandbox, so CORS,
   * the page CSP and mixed-content rules do not apply.
   * Falls back to plain fetch() if no GM API is available.
   */
  function request(method, path, body) {
    const url = `${state.base}${path}`;
    const headers = { 'X-ChatSync-Token': state.token || '', 'X-ChatSync-Client': 'userscript' };
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: payload,
          timeout: 20000,
          onload: (r) => resolve(parseResponse(r.status, r.responseText)),
          onerror: () => resolve({ ok: false, status: 0, error: 'network error — is the ChatSync extension running?' }),
          ontimeout: () => resolve({ ok: false, status: 0, error: 'timeout (20s)' }),
        });
        return;
      }
      fetch(url, { method, headers, body: payload })
        .then(async (r) => resolve(parseResponse(r.status, await r.text())))
        .catch((e) => resolve({ ok: false, status: 0, error: String(e && e.message ? e.message : e) }));
    });
  }

  function parseResponse(status, text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { raw: text };
    }
    return { ok: status >= 200 && status < 300 && json && json.ok !== false, status, body: json };
  }

  const api = {
    health: () => request('GET', '/health'),
    contextFile: (params) => request('GET', `/context/file?${params || 'diagnostics=1'}`),
    errors: (min) => request('GET', `/context/errors?minSeverity=${min || 'Warning'}&limit=100`),
    tabs: () => request('GET', '/tabs'),
    file: (p) => request('GET', `/file?path=${encodeURIComponent(p)}`),
    folder: (p, opts) => { const params = new URLSearchParams({ path: p }); if (opts) for (const k of Object.keys(opts)) { const v = opts[k]; if (v !== undefined && v !== null) params.set(k, String(v)); } return request('GET', '/folder?' + params.toString()); },
    skillsList: () => request('GET', '/skills'),
    skillGet: (slug, raw) => request('GET', '/skills/get?slug=' + encodeURIComponent(slug) + (raw ? '&raw=1' : '')),
    skillsReload: () => request('POST', '/skills/reload', {}),
    apply: (payload) => request('POST', '/apply', payload),
    confirm: (id) => request('POST', '/apply/confirm', { applyId: id }),
    cancel: (id) => request('POST', '/apply/cancel', { applyId: id }),
  };

  /* ================================================================== *
   * 2. Styles + floating panel (site-independent, so UI changes can't break it)
   * ================================================================== */

  const CSS = `
  .cs-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
    background:#4d6bfe;color:#fff;border:0;cursor:pointer;font-size:20px;box-shadow:0 6px 20px rgba(0,0,0,.35);
    display:flex;align-items:center;justify-content:center;transition:transform .12s ease}
  .cs-fab:hover{transform:scale(1.07)}
  .cs-fab .cs-dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#888;border:2px solid #fff}
  .cs-fab.cs-on .cs-dot{background:#2ecc71}
  .cs-fab.cs-err .cs-dot{background:#e74c3c}

  .cs-panel{position:fixed;right:18px;bottom:74px;z-index:2147483001;width:340px;max-height:70vh;overflow:auto;
    background:#1b1c1f;color:#e8e8e8;border:1px solid #2f3136;border-radius:12px;padding:14px;
    font:13px/1.5 -apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.5);display:none}
  .cs-panel.cs-open{display:block}
  .cs-panel h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px}
  .cs-row{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  .cs-btn{flex:1 1 auto;background:#2b2d33;color:#e8e8e8;border:1px solid #3a3d44;border-radius:8px;
    padding:7px 9px;cursor:pointer;font-size:12px;text-align:left;white-space:nowrap}
  .cs-btn:hover{background:#34373f;border-color:#4d6bfe}
  .cs-btn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
  .cs-btn:disabled{opacity:.5;cursor:not-allowed}
  .cs-status{font-size:12px;color:#9aa0a6;padding:6px 8px;background:#212226;border-radius:8px;margin-bottom:8px;word-break:break-all}
  .cs-status b{color:#fff}
  .cs-fields{display:grid;gap:6px;margin:8px 0}
  .cs-fields label{font-size:11px;color:#9aa0a6;display:block;margin-bottom:2px}
  .cs-fields input,.cs-fields select{width:100%;box-sizing:border-box;background:#111214;color:#e8e8e8;
    border:1px solid #3a3d44;border-radius:6px;padding:6px 8px;font-size:12px}
  .cs-sep{height:1px;background:#2f3136;margin:10px 0}
  .cs-hint{font-size:11px;color:#7f858c}
  .cs-check{display:flex;align-items:center;gap:6px;font-size:12px;color:#c8ccd2;cursor:pointer}

  .cs-toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483100;display:flex;
    flex-direction:column;gap:8px;align-items:center;pointer-events:none}
  .cs-toast{background:#1b1c1f;color:#fff;border:1px solid #3a3d44;border-left:4px solid #4d6bfe;border-radius:8px;
    padding:9px 14px;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);
    max-width:520px;white-space:pre-wrap;animation:csIn .18s ease}
  .cs-toast.ok{border-left-color:#2ecc71}
  .cs-toast.err{border-left-color:#e74c3c}
  .cs-toast.warn{border-left-color:#f1c40f}
  @keyframes csIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

  .cs-block-tools{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}
  .cs-chip{background:#2b2d33;color:#e8e8e8;border:1px solid #3a3d44;border-radius:999px;padding:3px 10px;
    cursor:pointer;font:11px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}
  .cs-chip:hover{border-color:#4d6bfe;background:#34373f}
  .cs-chip.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
  .cs-chip:disabled{opacity:.45;cursor:progress}
  .cs-meta{font-size:11px;color:#7f858c}

  .cs-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.55);display:flex;align-items:center;
    justify-content:center;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .cs-modal-card{background:#1b1c1f;color:#e8e8e8;border:1px solid #2f3136;border-radius:12px;padding:16px;width:min(560px,92vw);
    max-height:86vh;overflow:auto}
  .cs-modal-card h4{margin:0 0 10px;font-size:14px}
  .cs-modal-card .cs-fields{margin:10px 0}
  .cs-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
  .cs-list{max-height:44vh;overflow:auto;border:1px solid #2f3136;border-radius:8px}
  .cs-list-item{padding:7px 10px;border-bottom:1px solid #26282c;cursor:pointer;display:flex;gap:8px;align-items:center}
  .cs-list-item:last-child{border-bottom:0}
  .cs-list-item:hover,.cs-list-item.cs-sel{background:#262a3d}
  `;

  function injectStyles() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
      return;
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    children.flat().forEach((c) => c && node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  /* ================================================================== *
   * 3. Toasts
   * ================================================================== */

  let toastHost;
  function toast(message, kind, ms) {
    if (!toastHost) {
      toastHost = el('div', { class: 'cs-toasts' });
      document.body.appendChild(toastHost);
    }
    const node = el('div', { class: `cs-toast ${kind || ''}`, text: message });
    toastHost.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(() => node.remove(), 260);
    }, ms || 3200);
    return node;
  }

  /* ================================================================== *
   * 4. Chat input helpers (site-agnostic)
   * ================================================================== */

  const INPUT_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    '#chat-input[contenteditable="true"]',
    'div#chat-input',
    'textarea[data-id="root"]',
    'form textarea',
    'div[contenteditable="true"]',
    'textarea',
  ];

  const _composerCache = { node: null, at: 0 };
  function findComposer() {
    const now = Date.now();
    if (now - _composerCache.at < 100 && _composerCache.node && document.contains(_composerCache.node)) {
      return _composerCache.node;
    }
    for (const sel of INPUT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel));
      const visible = nodes.filter((n) => n.offsetParent !== null || n === document.activeElement);
      const pool = visible.length ? visible : nodes;
      if (pool.length) {
        pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        _composerCache.node = pool[0];
        _composerCache.at = now;
        return pool[0];
      }
    }
    _composerCache.node = null;
    _composerCache.at = now;
    return null;
  }

  function insertIntoComposer(text, { replace = false, focus = true } = {}) {
    const node = findComposer();
    if (!node) {
      toast('Không tìm thấy ô nhập chat. Hãy click vào ô nhập rồi thử lại.', 'err', 5000);
      return false;
    }
    if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
      const value = replace ? text : `${node.value}${node.value && !node.value.endsWith('\n') ? '\n\n' : ''}${text}`;
      const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable (DeepSeek / ChatGPT use ProseMirror-like editors)
      if (focus) node.focus();
      if (replace) {
        node.textContent = '';
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) {
        const sel = window.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0) : document.createRange();
        if (!sel || !sel.rangeCount) {
          range.selectNodeContents(node);
          range.collapse(false);
        }
        const frag = document.createDocumentFragment();
        text.split('\n').forEach((line, i) => {
          if (i > 0) frag.appendChild(document.createElement('br'));
          frag.appendChild(document.createTextNode(line));
        });
        range.deleteContents();
        range.insertNode(frag);
        if (sel) {
          sel.removeAllRanges();
          const r2 = document.createRange();
          r2.selectNodeContents(node);
          r2.collapse(false);
          sel.addRange(r2);
        }
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    if (focus) node.focus();
    return true;
  }

  /* ================================================================== *
   * 5. Context actions
   * ================================================================== */

  async function attachActiveFile({ withDiagnostics = true } = {}) {
    setBusy(true);
    const r = await api.contextFile(`diagnostics=${withDiagnostics ? 1 : 0}&content=1`);
    setBusy(false);
    if (!r.ok) return reportError('Attach file', r);
    const info = r.body;
    if (!info.hasEditor) {
      toast('VSCode không có file nào đang mở.', 'warn');
      return;
    }
    const text = info.contextText || '';
    if (insertIntoComposer(text)) {
      const sel = info.selections && info.selections.find((s) => !s.isCursor);
      toast(
        `Đã chèn ${sel ? `selection L${sel.startLine}-${sel.endLine}` : 'toàn bộ file'} của ${info.relPath || info.fileName}` +
          (info.truncated ? ' (đã cắt bớt)' : ''),
        'ok',
      );
    }
  }


  async function attachErrors(minSeverity) {
    setBusy(true);
    const r = await api.errors(minSeverity || 'Warning');
    setBusy(false);
    if (!r.ok) return reportError('Problems', r);
    if (!r.body.count) {
      toast('Không có lỗi/cảnh báo nào trong Problems panel.', 'ok');
      return;
    }
    const text = `## Problems in VSCode (${r.body.count})\n\n${r.body.text}\n`;
    insertIntoComposer(text);
    toast(`Đã chèn ${r.body.count} diagnostics.`, 'ok');
  }

  async function attachFolder() {
    const p = prompt('Folder path (relative to workspace):', 'extension/src');
    if (!p) return;
    const depthStr = prompt('Max depth (default 2, 0-5):', '2');
    const depth = depthStr ? parseInt(depthStr, 10) : 2;
    setBusy(true);
    const r = await api.folder(p, { depth, includeContent: 1 });
    setBusy(false);
    if (!r.ok) return reportError('Attach folder', r);
    const b = r.body;
    insertIntoComposer(b.contextText);
    toast('Đã chèn folder ' + b.root + ': ' + b.filesWithContent + '/' + b.fileCount + ' file (' + b.totalChars + ' chars)', 'ok');
  }

  async function attachSkill(slug) {
    setBusy(true);
    const r = await api.skillGet(slug, false);
    setBusy(false);
    if (!r.ok) return reportError('Attach skill', r);
    const b = r.body;
    insertIntoComposer(b.combinedText);
    toast('Skill "' + b.name + '": ' + b.attachResolved + '/' + b.attachRequested + ' attachments (' + b.combinedText.length + ' chars)', 'ok');
  }

  async function loadSkillsIntoSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    selectEl.appendChild(el('option', { value: '' }, '📋 loading...'));
    setBusy(true);
    const r = await api.skillsList();
    setBusy(false);
    selectEl.innerHTML = '';
    if (!r.ok) {
      selectEl.appendChild(el('option', { value: '' }, '❌ /skills error ' + r.status));
      return;
    }
    const skills = r.body.skills || [];
    if (!skills.length) {
      selectEl.appendChild(el('option', { value: '' }, '📋 no skills (create .chatsync/skills/*.md)'));
      return;
    }
    selectEl.appendChild(el('option', { value: '' }, '📋 Skills (' + skills.length + ')...'));
    for (const s of skills) {
      const label = s.name + (s.description ? ' — ' + s.description.slice(0, 40) : '');
      selectEl.appendChild(el('option', { value: s.slug, title: s.description || '' }, label));
    }
  }

  async function reloadSkills(selectEl) {
    setBusy(true);
    const r = await api.skillsReload();
    setBusy(false);
    if (!r.ok) { toast('Skills reload: lỗi ' + r.status, 'err'); return; }
    toast('Đã reload: ' + r.body.count + ' skill', 'ok', 2000);
    await loadSkillsIntoSelect(selectEl);
  }
  function reportError(label, r) {
    const msg = (r.body && (r.body.error || r.body.hint)) || r.error || `HTTP ${r.status}`;
    if (r.status === 0) {
      setOnline(false);
      toast(`${label}: không kết nối được ChatSync. Mở VSCode và chắc chắn extension đang chạy.`, 'err', 6000);
    } else if (r.status === 401) {
      toast(`${label}: sai token. Mở ChatSync panel → Settings → dán token (lệnh "ChatSync: Show Connection Info").`, 'err', 8000);
      openSettingsSection();
    } else {
      toast(`${label}: ${msg}`, 'err', 6000);
    }
    console.warn('[ChatSync]', label, r);
  }

  /* ================================================================== *
   * 6. Apply actions
   * ================================================================== */

  const _EXT_WHITELIST = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|swift|kt|md|json|yaml|yml|toml|xml|html|htm|css|scss|sass|less|vue|svelte|astro|sh|bash|ps1|sql|graphql|gql)$/i;
  function detectPathNearBlock(block) {
    let node = block;
    for (let depth = 0; depth < 4 && node; depth++) {
      let prev = node.previousElementSibling;
      for (let i = 0; i < 3 && prev; i++) {
        const text = (prev.textContent || '').trim();
        const m = /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,8})/.exec(text);
        if (m && m[1].length < 120 && !/\s/.test(m[1])) {
          const p = m[1];
          if (p.includes('/') && _EXT_WHITELIST.test(p)) return p;
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function detectLanguage(codeEl) {
    const cls = `${codeEl.className || ''} ${codeEl.parentElement ? codeEl.parentElement.className : ''}`;
    const m = /language-([A-Za-z0-9_+-]+)/.exec(cls);
    return m ? m[1] : '';
  }

  function openApplyModal(codeText, block) {
    const { code, pathHint, language } = stripFence(codeText);
    const suggestedPath = pathHint || detectPathNearBlock(block) || (state.health && state.health.activeFile) || '';

    const pathInput = el('input', { type: 'text', value: suggestedPath, placeholder: 'src/app.ts (để trống = file đang active)' });
    const modeSelect = el('select', {}, ...[
      ['replace', 'replace — ghi đè toàn bộ file'],
      ['replaceSelection', 'replaceSelection — thay thế vùng đang bôi đen'],
      ['insert', 'insert — chèn tại con trỏ'],
      ['append', 'append — thêm vào cuối file'],
      ['newFile', 'newFile — tạo file mới'],
      ['patch', 'patch — search & replace (cần chọn text)'],
    ].map(([v, label]) => el('option', { value: v, selected: v === state.insertMode }, label)));
    modeSelect.value = state.insertMode;

    const searchInput = el('textarea', { rows: '3', placeholder: 'Đoạn text cần tìm trong file…', style: 'display:none;width:100%;box-sizing:border-box;background:#111214;color:#e8e8e8;border:1px solid #3a3d44;border-radius:6px;padding:6px 8px;font-family:ui-monospace,monospace;font-size:12px' });

    const sync = () => {
      const mode = modeSelect.value;
      searchInput.style.display = mode === 'patch' ? '' : 'none';
      if (mode === 'patch' && !searchInput.value) {
        const lines = code.split('\n');
        searchInput.value = lines.slice(0, Math.min(6, lines.length)).join('\n');
      }
    };
    modeSelect.addEventListener('change', sync);
    sync();

    const previewCheck = el('input', { type: 'checkbox' });
    previewCheck.checked = state.preview;
    const saveCheck = el('input', { type: 'checkbox' });
    saveCheck.checked = state.autoSave;

    const preview = el(
      'pre',
      {
        style:
          'max-height:26vh;overflow:auto;background:#111214;border:1px solid #2f3136;border-radius:8px;padding:10px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;margin:8px 0',
        text: code.length > 4000 ? `${code.slice(0, 4000)}\n\n… (${code.length - 4000} ký tự nữa)` : code,
      },
    );

    openModal(
      `Apply → VSCode ${language ? `(${language}, ${code.split('\n').length} dòng)` : ''}`,
      [
        el('div', { class: 'cs-fields' },
          el('label', {}, 'File (tương đối với workspace, hoặc đường dẫn tuyệt đối)'),
          pathInput,
          el('label', {}, 'Chế độ ghi'),
          modeSelect,
          el('label', {}, 'Đoạn text cần tìm (patch)'),
          searchInput,
        ),
        el('label', { class: 'cs-check' }, previewCheck, ' Xem diff trong VSCode trước khi ghi (preview)'),
        el('label', { class: 'cs-check' }, saveCheck, ' Lưu file sau khi ghi (save)'),
        el('div', { class: 'cs-hint', text: 'Code sẽ được gửi:' }),
        preview,
      ],
      [
        { label: 'Huỷ' },
        {
          label: 'Apply',
          primary: true,
          onClick: async (close) => {
            const payload = {
              path: pathInput.value.trim() || undefined,
              mode: modeSelect.value,
              content: code,
              search: modeSelect.value === 'patch' ? searchInput.value : undefined,
              preview: previewCheck.checked,
              save: saveCheck.checked,
              label: `userscript:${location.hostname}`,
            };
            state.preview = previewCheck.checked;
            state.autoSave = saveCheck.checked;
            state.insertMode = modeSelect.value;
            saveSettings();
            close();
            await doApply(payload);
          },
        },
      ],
    );
  }

  async function doApply(payload) {
    setBusy(true);
    const r = await api.apply(payload);
    setBusy(false);
    if (!r.ok) return reportError('Apply', r);
    const b = r.body;
    if (b.preview && b.applyId) {
      toast(`Đã mở diff trong VSCode cho ${b.path}.\nBấm "Apply" trong VSCode, hoặc chờ ở đây…`, 'ok', 6000);
      offerConfirmInChat(b.applyId, b.path);
      return;
    }
    if (b.applied) {
      const diags = b.diagnosticsAfter || [];
      toast(
        `✔ ${b.message || `Applied → ${b.path}`}` + (diags.length ? `\n⚠ ${diags.length} lỗi còn lại: ${diags[0].message}` : ''),
        diags.length ? 'warn' : 'ok',
        diags.length ? 8000 : 4000,
      );
    } else {
      toast(b.message || 'Không có thay đổi nào.', 'warn');
    }
  }

  function offerConfirmInChat(applyId, filePath) {
    const node = el(
      'div',
      { class: 'cs-toast', style: 'pointer-events:auto' },
      el('div', { text: `Diff đang chờ xác nhận: ${filePath}`, style: 'margin-bottom:6px' }),
      el('div', { style: 'display:flex;gap:6px' },
        el('button', {
          class: 'cs-chip primary',
          text: 'Confirm từ đây',
          onclick: async (e) => {
            e.target.disabled = true;
            const r = await api.confirm(applyId);
            node.remove();
            if (!r.ok) return reportError('Confirm', r);
            toast(`✔ ${r.body.message}`, 'ok');
          },
        }),
        el('button', {
          class: 'cs-chip',
          text: 'Discard',
          onclick: async (e) => {
            e.target.disabled = true;
            const r = await api.cancel(applyId);
            node.remove();
            toast(r.ok ? 'Đã huỷ thay đổi.' : `Huỷ thất bại: ${r.status}`, r.ok ? 'warn' : 'err');
          },
        })),
    );
    if (!toastHost) {
      toastHost = el('div', { class: 'cs-toasts' });
      document.body.appendChild(toastHost);
    }
    toastHost.appendChild(node);
    setTimeout(() => node.remove(), 5 * 60 * 1000);
  }

  /* ================================================================== *
   * 7. Code block scanning + injection (MutationObserver, streaming-safe)
   * ================================================================== */

  const CODE_BLOCK_SELECTORS = ['pre code', 'pre', 'div.code-block code'];
  const processed = new WeakSet();
  const lastChange = new WeakMap();

  function collectCodeBlocks() {
    const seen = new Set();
    const out = [];
    for (const sel of CODE_BLOCK_SELECTORS) {
      document.querySelectorAll(sel).forEach((node) => {
        if (node.closest('[data-cs-done]')) return;
        const pre = node.tagName === 'PRE' ? node : node.closest('pre');
        const codeEl = node.tagName === 'CODE' ? node : pre ? pre.querySelector('code') : null;
        const target = pre || node;
        if (!target || seen.has(target)) return;
        if (!target.offsetParent && target.getClientRects().length === 0) return; // hidden
        const text = (codeEl || target).innerText || (codeEl || target).textContent || '';
        if (!text.trim()) return;
        seen.add(target);
        out.push({
          element: target,
          codeEl: codeEl || target,
          code: text,
          language: codeEl ? detectLanguage(codeEl) : '',
          pathHint: detectPathNearBlock(target),
        });
      });
    }
    return out;
  }

  function isStreaming() {
    // heuristic: a visible "stop generating" control means the answer is still streaming
    const candidates = document.querySelectorAll('[class*="stop" i], [aria-label*="stop" i], [data-testid*="stop" i]');
    for (const c of candidates) {
      if (c.offsetParent !== null) return true;
    }
    return false;
  }

  function decorateBlocks() {
    const now = Date.now();
    const streaming = isStreaming();
    for (const block of collectCodeBlocks()) {
      const prev = lastChange.get(block.element);
      const hash = `${block.code.length}:${block.code.slice(-40)}`;
      if (prev !== hash) {
        lastChange.set(block.element, hash);
        block.element.dataset.csStableAt = String(now);
      }
      const stableFor = now - Number(block.element.dataset.csStableAt || now);
      const ready = !streaming && stableFor >= STABLE_MS;

      if (processed.has(block.element)) {
        const bar = block.element.csToolbar;
        if (bar) {
          bar.querySelectorAll('[data-cs-needs-ready]').forEach((btn) => {
            btn.disabled = !ready;
            btn.title = ready ? '' : 'Đang chờ AI trả lời xong…';
          });
          const meta = bar.querySelector('.cs-meta');
          if (meta) meta.textContent = ready ? meta.dataset.readyText || '' : 'đang stream…';
        }
        continue;
      }
      if (!ready) continue;

      processed.add(block.element);
      block.element.dataset.csDone = '1';
      const bar = el('div', { class: 'cs-block-tools' });
      const lang = block.language || (block.pathHint ? '' : '');
      bar.appendChild(
        el('span', {
          class: 'cs-meta',
          text: lang || block.pathHint || `${block.code.split('\n').length} dòng`,
          'data-ready-text': lang || block.pathHint || `${block.code.split('\n').length} dòng`,
        }),
      );
      const quick = el('button', {
        class: 'cs-chip primary',
        text: '⚡ Apply to VSCode',
        title: 'Ghi vào file đang active trong VSCode',
        onclick: async () => {
          quick.disabled = true;
          const ctx = await api.contextFile('content=0');
          quick.disabled = false;
          if (!ctx.ok) return reportError('Apply', ctx);
          if (!ctx.body.hasEditor) {
            toast('Không có file nào đang active trong VSCode.', 'err');
            return;
          }
          await doApply({
            path: ctx.body.relPath,
            mode: ctx.body.hasSelection ? 'replaceSelection' : 'replace',
            content: block.code,
            preview: state.preview,
            save: state.autoSave,
            label: 'quick-apply',
          });
        },
      });
      const detailed = el('button', {
        class: 'cs-chip',
        text: '⚙ Options',
        title: 'File / chế độ ghi / patch',
        onclick: () => openApplyModal(block.code, block.element),
      });
      const newFile = el('button', {
        class: 'cs-chip',
        text: '＋ New file',
        title: 'Tạo file mới trong workspace',
        onclick: () => {
          const p = prompt('Đường dẫn file mới (tương đối với workspace):', block.pathHint || 'src/new-file.ts');
          if (!p) return;
          const stripped = stripFence(block.code);
          doApply({ path: p, mode: 'newFile', content: stripped.code, open: true, label: 'new-file' });
        },
      });
      const copy = el('button', { class: 'cs-chip', text: '⧉ Copy', onclick: () => { gmCopy(stripFence(block.code).code); toast('Đã copy code.', 'ok', 1500); } });
      bar.append(quick, detailed, newFile, copy);
      block.element.csToolbar = bar;
      block.element.addEventListener('mouseenter', () => (state.lastHoveredBlock = block));

      // insert the toolbar right after the <pre> (or inside its wrapper)
      const anchor = block.element.parentElement && /code-block|highlight|markdown|message/i.test(block.element.parentElement.className || '')
        ? block.element.parentElement
        : block.element;
      if (anchor.parentElement) {
        anchor.insertAdjacentElement('afterend', bar);
      } else {
        anchor.appendChild(bar);
      }
    }
  }

  function stripFence(text) {
    let code = text.replace(/\r\n/g, '\n');
    let language;
    let pathHint;
    const m = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/.exec(code.trim());
    if (m) {
      const parts = m[1].trim().split(/\s+/);
      language = parts[0] || undefined;
      const rest = parts.slice(1).join(' ').trim();
      if (rest) pathHint = rest.replace(/^file:?\s*/i, '');
      code = m[2];
    }
    const lines = code.split('\n');
    const cm = /^\s*(?:\/\/|#|<!--|;)\s*(?:file\s*[:=]\s*)?([^\s:*?"<>|]+\.[A-Za-z0-9]{1,8})\s*(?:-->)?\s*$/.exec(lines[0] || '');
    if (cm && lines.length > 1) {
      pathHint = pathHint || cm[1];
      code = lines.slice(1).join('\n');
    }
    return { code: code.replace(/\n$/, ''), language, pathHint };
  }

  /* ================================================================== *
   * 8. Panel UI
   * ================================================================== */

  let fab, panel, statusBox, settingsBox;

  function buildPanel() {
    statusBox = el('div', { class: 'cs-status', text: 'đang kiểm tra kết nối…' });

    const btnAttach = el('button', { class: 'cs-btn primary', text: '📎 Attach file đang mở', onclick: () => attachActiveFile({ withDiagnostics: false }) });
    const btnAttachDiag = el('button', { class: 'cs-btn', text: '📎 File + Problems', onclick: () => attachActiveFile({ withDiagnostics: true }) });
    const btnErrors = el('button', { class: 'cs-btn', text: '🐞 Attach Problems', onclick: () => attachErrors('Warning') });
    const btnFolder = el('button', { class: 'cs-btn', text: '📁 Attach folder…', onclick: attachFolder });
    const skillSelect = el('select', { style: 'flex:2 1 auto;background:#2b2d33;color:#e8e8e8;border:1px solid #3a3d44;border-radius:8px;padding:6px 8px;font-size:12px' }, el('option', { value: '' }, '📋 Skills (click ↻)'));
    const btnSkillApply = el('button', { class: 'cs-btn', text: 'Add skill', onclick: () => { const v = skillSelect.value; if (!v) return toast('Chọn skill trước', 'warn'); attachSkill(v); } });
    const btnSkillRefresh = el('button', { class: 'cs-btn', text: '↻', title: 'Reload skills', onclick: () => reloadSkills(skillSelect), style: 'flex:0 0 auto;min-width:36px' });
    const btnRefresh = el('button', { class: 'cs-btn', text: '🔄 Refresh', onclick: refreshStatus });
    const btnSettings = el('button', { class: 'cs-btn', text: '⚙ Settings', onclick: toggleSettings });

    settingsBox = el('div', { style: 'display:none' },
      el('div', { class: 'cs-sep' }),
      el('div', { class: 'cs-fields' },
        el('label', {}, 'Server URL'),
        el('input', {
          type: 'text',
          value: state.base,
          onchange: (e) => { state.base = e.target.value.trim().replace(/\/$/, ''); saveSettings(); refreshStatus(); },
        }),
        el('label', {}, 'Token (X-ChatSync-Token)'),
        el('input', {
          type: 'text',
          value: state.token,
          placeholder: 'dán token từ VSCode',
          onchange: (e) => { state.token = e.target.value.trim(); saveSettings(); refreshStatus(); },
        }),
        el('label', {}, 'Apply mode mặc định'),
        (() => {
          const s = el('select', { onchange: (e) => { state.insertMode = e.target.value; saveSettings(); } },
            ...['replace', 'replaceSelection', 'insert', 'append', 'newFile', 'patch'].map((v) => el('option', { value: v }, v)));
          s.value = state.insertMode;
          return s;
        })(),
      ),
      el('label', { class: 'cs-check' }, (() => { const c = el('input', { type: 'checkbox', onchange: (e) => { state.preview = e.target.checked; saveSettings(); } }); c.checked = state.preview; return c; })(), ' Luôn xem diff trong VSCode trước khi ghi'),
      el('label', { class: 'cs-check' }, (() => { const c = el('input', { type: 'checkbox', onchange: (e) => { state.autoSave = e.target.checked; saveSettings(); } }); c.checked = state.autoSave; return c; })(), ' Tự động lưu file sau khi ghi'),
      el('div', { class: 'cs-hint', text: 'Lấy token: VSCode → Ctrl+Shift+P → "ChatSync: Show Connection Info".' }),
    );

    panel = el('div', { class: 'cs-panel' },
      el('h3', {}, '🔌 ChatSync', el('span', { class: 'cs-meta', text: 'VSCode bridge' })),
      statusBox,
      el('div', { class: 'cs-row' }, btnAttach, btnAttachDiag),
      el('div', { class: 'cs-row' }, btnErrors, btnFolder),
      el('div', { class: 'cs-row' }, skillSelect, btnSkillApply, btnSkillRefresh),
      el('div', { class: 'cs-row' }, btnRefresh, btnSettings),
      settingsBox,
    );

    fab = el('button', { class: 'cs-fab', title: 'ChatSync — kết nối VSCode', onclick: togglePanel },
      el('span', { text: '⌘' }),
      el('span', { class: 'cs-dot' }));

    document.body.append(fab, panel);

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        attachActiveFile({ withDiagnostics: true });
      } else if (e.altKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        const b = state.lastHoveredBlock || collectCodeBlocks().slice(-1)[0];
        if (!b) return toast('Không có code block nào.', 'warn');
        openApplyModal(b.code, b.element);
      } else if (e.key === 'Escape' && panel.classList.contains('cs-open')) {
        togglePanel();
      }
    });
  }

  let _skillsLoaded = false;
  function togglePanel() {
    panel.classList.toggle('cs-open');
    if (panel.classList.contains('cs-open')) {
      refreshStatus();
      if (!_skillsLoaded) {
        _skillsLoaded = true;
        const sel = panel.querySelector('select');
        if (sel) loadSkillsIntoSelect(sel);
      }
    }
  }

  function openSettingsSection() {
    panel.classList.add('cs-open');
    settingsBox.style.display = '';
  }

  function toggleSettings() {
    settingsBox.style.display = settingsBox.style.display === 'none' ? '' : 'none';
  }

  function setOnline(on) {
    fab.classList.toggle('cs-on', on);
    fab.classList.toggle('cs-err', !on);
  }

  function setBusy(busy) {
    fab.style.opacity = busy ? '0.6' : '';
  }

  async function refreshStatus() {
    const r = await api.health();
    if (!r.ok || !r.body.ok) {
      setOnline(false);
      state.health = null;
      statusBox.innerHTML = '';
      statusBox.append(
        el('div', {}, '❌ Không kết nối được ', el('b', { text: state.base })),
        el('div', { class: 'cs-hint', text: r.body && r.body.error ? r.body.error : 'Mở VSCode, chắc chắn extension ChatSync đã activate (status bar góc phải).' }),
      );
      return;
    }
    setOnline(true);
    state.health = r.body;
    if (!state.token && r.body.token) {
      // /health is public on localhost → auto-configure the token once
      state.token = r.body.token;
      saveSettings();
      const input = settingsBox.querySelector('input[type="text"]:nth-of-type(2)');
      if (input) input.value = state.token;
    }
    statusBox.innerHTML = '';
    statusBox.append(
      el('div', {}, '✅ ', el('b', { text: `:${r.body.port}` }), ` · v${r.body.version} · VSCode ${r.body.vscodeVersion}`),
      el('div', { class: 'cs-hint', text: `workspace: ${r.body.workspace || '(không có folder nào được mở)'}` }),
      el('div', { class: 'cs-hint', text: `file active: ${r.body.activeFile || '—'} · applyMode: ${r.body.applyMode} · pending: ${r.body.pendingApplies}` }),
      state.token ? el('div', { class: 'cs-hint', text: `token: ${state.token.slice(0, 7)}…` }) : el('div', { class: 'cs-hint', style: 'color:#f1c40f', text: '⚠ chưa có token (server đang bật requireToken)' }),
    );
  }

  /* ================================================================== *
   * 9. Modal helper
   * ================================================================== */

  function openModal(title, contentNodes, actions) {
    const card = el('div', { class: 'cs-modal-card' }, el('h4', { text: title }));
    contentNodes.forEach((n) => card.appendChild(n));
    const bar = el('div', { class: 'cs-modal-actions' });
    const overlay = el('div', { class: 'cs-modal' }, card);
    const close = () => overlay.remove();
    (actions || [{ label: 'Đóng' }]).forEach((a) => {
      bar.appendChild(
        el('button', {
          class: `cs-btn ${a.primary ? 'primary' : ''}`,
          text: a.label,
          onclick: () => (a.onClick ? a.onClick(close) : close()),
        }),
      );
    });
    card.appendChild(bar);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    const first = card.querySelector('input,select,textarea');
    if (first) first.focus();
    return close;
  }

  /* ================================================================== *
   * 10. Boot
   * ================================================================== */

  function boot() {
    if (window.top !== window.self) return; // @noframes guard
    if (document.querySelector('.cs-fab')) return; // already injected
    injectStyles();
    loadSettings();
    buildPanel();
    refreshStatus();

    // watch the DOM: chat UIs re-render constantly, and new code blocks appear while streaming
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        try {
          decorateBlocks();
        } catch (e) {
          console.warn('[ChatSync] decorateBlocks failed', e);
        }
      }, 220);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    setInterval(() => { if (!document.hidden) schedule(); }, 1500); // skip when tab hidden
    setInterval(() => { if (!document.hidden) refreshStatus(); }, POLL_MS);
    window.addEventListener('focus', refreshStatus);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) schedule();
    });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('ChatSync: Attach active file', () => attachActiveFile({ withDiagnostics: true }));
      GM_registerMenuCommand('ChatSync: Attach problems', () => attachErrors('Warning'));
      GM_registerMenuCommand('ChatSync: Apply all code blocks', applyAllBlocks);
      GM_registerMenuCommand('ChatSync: Settings', openSettingsSection);
      GM_registerMenuCommand('ChatSync: Re-check connection', refreshStatus);
    }

    console.info('[ChatSync] userscript loaded →', state.base);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
