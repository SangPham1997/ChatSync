// ==UserScript==
// @name         ChatSync for DeepSeek ↔ VSCode
// @namespace    https://github.com/local/chatsync
// @version      0.2.0
// @description  Live VSCode context in your prompt + AI code applied back into the editor. Auto-attach on Enter, auto-apply code blocks that declare a file path, and an automatic error loop: after an apply the bridge waits for VSCode to finish analysing and posts the new problems straight back into the chat. Talks to the ChatSync extension over http://127.0.0.1:3847.
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

  // port + token are rewritten automatically by the VSCode command
  // "ChatSync: Save userscript into workspace", so a fresh install just works.
  const DEFAULTS = { port: 3847, token: '' };

  const SETTINGS_KEY = 'chatsync.settings.v2';
  const POLL_MS = 15000;
  const STABLE_MS = 1200; // a code block must be unchanged this long before it counts as "done"
  const MARKER = '## Active file:'; // used to detect already-attached context

  /** Behaviour toggles — all editable from the panel ⚙ Settings. */
  const BEHAVIOUR_DEFAULTS = {
    // (1) auto attach
    autoAttachOnEnter: true, // intercept Enter in the composer and attach first
    autoSendAfterAttach: true, // and then actually send the message
    attachScope: 'auto', // auto | selection | activeFile | none
    attachErrors: 'ifAny', // always | ifAny | never
    // (2) error loop
    errorLoop: 'attach', // send | attach | ask | off  (what to do with NEW errors)
    errorLoopRecheckMs: 6000, // re-check once more if the analyser was not done
    errorLoopMaxChecks: 3,
    // (3) auto apply
    autoApply: true, // apply code blocks that name a file, as soon as streaming ends
    autoApplyPreview: 'auto', // auto | true (always diff) | false (never diff)
    // general
    settleMs: 1200,
    quickKeys: true,
  };

  const state = Object.assign(
    {
      base: '',
      token: '',
      preview: true,
      autoSave: false,
      insertMode: 'replace',
      online: false,
      health: null,
      lastHoveredBlock: null,
      busy: false,
      lastApply: null, // { applyId, batchId, path, diff }
      attachedOnceForThisSend: false,
      sendingNow: false,
      reportedErrorKeys: new Set(),
      autoAppliedKeys: new Set(),
      pendingAutoBlocks: [],
      autoFlushTimer: null,
    },
    BEHAVIOUR_DEFAULTS,
  );

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(gmGet(SETTINGS_KEY, '{}') || '{}');
    } catch (_) {
      saved = {};
    }
    state.base = saved.base || `http://127.0.0.1:${saved.port || DEFAULTS.port}`;
    state.token = saved.token || DEFAULTS.token || '';
    state.preview = saved.preview !== false;
    state.autoSave = saved.autoSave === true;
    state.insertMode = saved.insertMode || 'replace';
    Object.keys(BEHAVIOUR_DEFAULTS).forEach((k) => {
      if (saved[k] !== undefined) {
        state[k] = saved[k];
      }
    });
  }

  function saveSettings() {
    let base = state.base;
    try {
      const url = new URL(state.base.startsWith('http') ? state.base : `http://${state.base}`);
      base = `${url.protocol}//${url.hostname}:${url.port || 3847}`;
    } catch (_) {
      /* keep as typed */
    }
    const out = {
      base,
      token: state.token,
      preview: state.preview,
      autoSave: state.autoSave,
      insertMode: state.insertMode,
    };
    Object.keys(BEHAVIOUR_DEFAULTS).forEach((k) => (out[k] = state[k]));
    gmSet(SETTINGS_KEY, JSON.stringify(out));
    state.base = base;
  }

  /* ================================================================== *
   * 1. Userscript API shim + HTTP
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
   * GM_xmlhttpRequest runs in the extension sandbox: no CORS, no page CSP,
   * no mixed-content block for http://127.0.0.1. fetch() is the fallback.
   */
  function request(method, path, body, opts) {
    const url = `${state.base}${path}`;
    const headers = { 'X-ChatSync-Token': state.token || '', 'X-ChatSync-Client': 'userscript' };
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = (opts && opts.timeout) || 25000;

    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: payload,
          timeout,
          onload: (r) => resolve(parseResponse(r.status, r.responseText)),
          onerror: () => resolve({ ok: false, status: 0, error: 'network error — ChatSync extension không chạy?' }),
          ontimeout: () => resolve({ ok: false, status: 0, error: `timeout ${timeout}ms` }),
        });
        return;
      }
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeout) : null;
      fetch(url, { method, headers, body: payload, signal: ac ? ac.signal : undefined })
        .then(async (r) => {
          if (timer) clearTimeout(timer);
          resolve(parseResponse(r.status, await r.text()));
        })
        .catch((e) => {
          if (timer) clearTimeout(timer);
          resolve({ ok: false, status: 0, error: String((e && e.message) || e) });
        });
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
    errors: (params) => request('GET', `/context/errors?${params || 'minSeverity=Warning&limit=100'}`),
    tabs: () => request('GET', '/tabs'),
    workspace: () => request('GET', '/context/workspace'),
    file: (p, extra) => request('GET', `/file?path=${encodeURIComponent(p)}${extra || ''}`),
    apply: (payload, opts) => request('POST', '/apply', payload, opts),
    applyBatch: (applies, batchId) => request('POST', '/apply/batch', { applies, batchId }, { timeout: 60000 }),
    confirm: (id) => request('POST', '/apply/confirm', { applyId: id }),
    cancel: (id) => request('POST', '/apply/cancel', { applyId: id }),
    applyErrors: (params) => request('GET', `/apply/errors?${params}`, undefined, { timeout: 60000 }),
    applyUndo: (payload) => request('POST', '/apply/undo', payload),
    applyHistory: () => request('GET', '/apply/history'),
  };

  /* ================================================================== *
   * 2. Styles
   * ================================================================== */

  const CSS = `
  .cs-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
    background:#4d6bfe;color:#fff;border:0;cursor:pointer;font-size:20px;box-shadow:0 6px 20px rgba(0,0,0,.35);
    display:flex;align-items:center;justify-content:center;transition:transform .12s ease}
  .cs-fab:hover{transform:scale(1.07)}
  .cs-fab .cs-dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#888;border:2px solid #fff}
  .cs-fab.cs-on .cs-dot{background:#2ecc71}
  .cs-fab.cs-err .cs-dot{background:#e74c3c}

  .cs-panel{position:fixed;right:18px;bottom:74px;z-index:2147483001;width:352px;max-height:78vh;overflow:auto;
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
  .cs-check{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:#c8ccd2;cursor:pointer;margin:4px 0}
  .cs-check input{margin-top:2px;flex:0 0 auto}
  .cs-legend{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#6f757c;margin:10px 0 4px}

  .cs-toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483100;display:flex;
    flex-direction:column;gap:8px;align-items:center;pointer-events:none}
  .cs-toast{background:#1b1c1f;color:#fff;border:1px solid #3a3d44;border-left:4px solid #4d6bfe;border-radius:8px;
    padding:9px 14px;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);
    max-width:560px;white-space:pre-wrap;animation:csIn .18s ease}
  .cs-toast.ok{border-left-color:#2ecc71}
  .cs-toast.err{border-left-color:#e74c3c}
  .cs-toast.warn{border-left-color:#f1c40f}
  .cs-toast.cs-actions{pointer-events:auto}
  @keyframes csIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

  .cs-block-tools{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}
  .cs-chip{background:#2b2d33;color:#e8e8e8;border:1px solid #3a3d44;border-radius:999px;padding:3px 10px;
    cursor:pointer;font:11px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}
  .cs-chip:hover{border-color:#4d6bfe;background:#34373f}
  .cs-chip.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
  .cs-chip.done{border-color:#2ecc71;color:#2ecc71}
  .cs-chip:disabled{opacity:.45;cursor:progress}
  .cs-meta{font-size:11px;color:#7f858c}

  .cs-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.55);display:flex;align-items:center;
    justify-content:center;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .cs-modal-card{background:#1b1c1f;color:#e8e8e8;border:1px solid #2f3136;border-radius:12px;padding:16px;width:min(580px,92vw);
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
   * 3. Toasts (optionally with action buttons)
   * ================================================================== */

  let toastHost;
  function host() {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el('div', { class: 'cs-toasts' });
      document.body.appendChild(toastHost);
    }
    return toastHost;
  }

  function toast(message, kind, ms, actions) {
    const node = el('div', { class: `cs-toast ${kind || ''}${actions ? ' cs-actions' : ''}` }, el('div', { text: message }));
    if (actions && actions.length) {
      const bar = el('div', { style: 'display:flex;gap:6px;margin-top:6px' });
      actions.forEach((a) => {
        bar.appendChild(
          el('button', {
            class: `cs-chip ${a.primary ? 'primary' : ''}`,
            text: a.label,
            onclick: (e) => {
              if (e && e.target) e.target.disabled = true;
              Promise.resolve(a.onClick())
                .then(() => node.remove())
                .catch(() => {
                  node.textContent = 'Lỗi: ' + String(a);
                });
            },
          }),
        );
      });
      node.appendChild(bar);
    }
    host().appendChild(node);
    if (!actions) {
      setTimeout(() => {
        node.style.opacity = '0';
        node.style.transition = 'opacity .25s';
        setTimeout(() => node.remove(), 260);
      }, ms || 3200);
    } else {
      setTimeout(() => node.remove(), ms || 90000);
    }
    return node;
  }

  /* ================================================================== *
   * 4. Composer: find it, write to it, send it
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

  const SEND_SELECTORS = [
    'button[aria-label*="Send" i]:not([disabled])',
    'button[aria-label*="Gửi" i]:not([disabled])',
    'button[data-testid="send-button"]',
    'button[title*="Send" i]:not([disabled])',
    'form button[type="submit"]:not([disabled])',
    '[role="button"][aria-label*="Send" i]',
    // plain fallbacks (also work on engines/hosts without :not() or the i flag)
    'button[aria-label*="Send"]',
    'button[aria-label*="Gửi"]',
    'button[title*="Send"]',
    'form button[type="submit"]',
  ];

  function findComposer() {
    for (const sel of INPUT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel));
      const visible = nodes.filter((n) => n.offsetParent !== null || n === document.activeElement);
      const pool = visible.length ? visible : nodes;
      if (pool.length) {
        pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return pool[0];
      }
    }
    return null;
  }

  function composerText() {
    const node = findComposer();
    if (!node) return '';
    return node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' ? node.value || '' : node.textContent || '';
  }

  function findSendButton() {
    for (const sel of SEND_SELECTORS) {
      const btn = Array.from(document.querySelectorAll(sel)).find((b) => b.offsetParent !== null && !b.disabled);
      if (btn) return btn;
    }
    return null;
  }

  function insertIntoComposer(text, { replace = false, focus = true } = {}) {
    const node = findComposer();
    if (!node) {
      toast('Không tìm thấy ô nhập chat. Click vào ô nhập rồi thử lại.', 'err', 5000);
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
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    if (focus) node.focus();
    return true;
  }

  /**
   * Ask the chat UI to send. We try the real send button first (safest), then
   * fall back to re-dispatching Enter on the composer with our hook armed off.
   * Returns true if a send was very likely triggered.
   */
  async function sendChat() {
    const before = composerText();
    if (!before.trim()) return false;

    const btn = findSendButton();
    if (btn) {
      btn.click();
      await sleep(320);
      if (composerText().trim() === '' || composerText().length < before.length * 0.6) return true;
    }

    const node = findComposer();
    if (!node) return false;
    state.sendingNow = true;
    try {
      node.focus();
      const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
      node.dispatchEvent(new KeyboardEvent('keydown', init));
      node.dispatchEvent(new KeyboardEvent('keypress', init));
      node.dispatchEvent(new KeyboardEvent('keyup', init));
    } finally {
      setTimeout(() => (state.sendingNow = false), 400);
    }
    await sleep(320);
    return composerText().trim() === '' || composerText().length < before.length * 0.6;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ================================================================== *
   * 5. Building the context block
   * ================================================================== */

  /**
   * Which file does the user actually mean?
   *  - if the prompt mentions a path that exists in the workspace → that file
   *  - otherwise → the active editor
   */
  async function resolveTargetForPrompt(promptText) {
    const cands = [];
    const re = /([A-Za-z0-9_.@\-]+(?:\/[A-Za-z0-9_.@\-]+)*\.[A-Za-z0-9]{1,8})/g;
    let m;
    while ((m = re.exec(promptText || ''))) {
      if (!/^(https?|data|blob):/i.test(m[1]) && m[1].length < 120) cands.push(m[1]);
    }
    const unique = [...new Set(cands)].slice(-3);
    for (const cand of unique.reverse()) {
      const r = await api.file(cand, '&content=0');
      if (r.ok && r.body.ok) {
        return { path: r.body.path, exists: true };
      }
    }
    return unique.length ? { path: unique[0], exists: false } : { path: null, exists: false };
  }

  async function buildContext({ purpose = 'manual' } = {}) {
    const prompt = purpose === 'auto' ? composerText() : '';
    const parts = [];
    let meta = null;

    let targetPath = null;
    if (state.attachScope !== 'none') {
      if (state.attachScope === 'auto' && prompt) {
        const t = await resolveTargetForPrompt(prompt);
        if (t.path) targetPath = t.path;
      }
      if (state.attachScope === 'selection') {
        const sel = await api.contextFile('content=0&diagnostics=0');
        if (sel.ok && sel.body.hasEditor && sel.body.hasSelection) {
          parts.push(sel.body.contextText || '');
          meta = sel.body;
        }
      }
      if (!parts.length) {
        if (targetPath) {
          const f = await api.file(targetPath, '&diagnostics=1&content=1');
          if (f.ok && f.body.ok) {
            parts.push(formatFileBlock(f.body));
            meta = { relPath: f.body.path, lineCount: f.body.lineCount, hasSelection: false };
          }
        }
        if (!parts.length) {
          const r = await api.contextFile('content=1&diagnostics=1');
          if (!r.ok) return { ok: false, error: r };
          if (!r.body.hasEditor) {
            return { ok: false, error: r, empty: true };
          }
          const info = r.body;
          if (state.attachScope === 'activeFile' || !info.hasSelection) {
            parts.push(info.contextText || '');
          } else {
            parts.push(info.contextText || '');
          }
          meta = info;
        }
      }
    }

    // problems
    const wantErrors = state.attachErrors === 'always' || (state.attachErrors === 'ifAny');
    const alreadyHasDiags = meta && meta.diagnostics && meta.diagnostics.length;
    if (state.attachErrors !== 'never' && wantErrors && !alreadyHasDiags) {
      const e = await api.errors('minSeverity=Error&limit=40');
      if (e.ok && e.body.count > 0) {
        parts.push(`## Problems in VSCode (${e.body.count})\n\n${e.body.text}\n`);
      }
    }

    const text = parts.filter(Boolean).join('\n').trim();
    return { ok: true, text, meta };
  }

  function formatFileBlock(body) {
    return (
      `## File: ${body.path}\n\n` +
      `- language: ${body.languageId || 'unknown'}, lines: ${body.lineCount}, chars: ${body.charCount || (body.content || '').length}\n\n` +
      '```' + (body.languageId || '') + '\n' + body.content + '\n```\n' +
      (body.truncated ? '\n_(file bị cắt bớt vì quá dài)_\n' : '')
    );
  }

  /* ================================================================== *
   * 6. (1) Auto-attach
   * ================================================================== */

  async function attachNow({ send = false, withDiagnostics = true, quiet = false } = {}) {
    if (!state.online) {
      toast('ChatSync offline — mở VSCode và chắc chắn extension đang chạy.', 'err', 5000);
      return false;
    }
    setBusy(true);
    const built = await buildContext({ purpose: send ? 'auto' : 'manual' });
    setBusy(false);
    if (!built.ok) {
      if (!quiet) reportError('Attach', built.error);
      return false;
    }
    if (!built.text) {
      if (!quiet && !withDiagnostics) toast('Không có ngữ cảnh để chèn.', 'warn');
      return false;
    }
    insertIntoComposer(built.text);
    if (!quiet) {
      toast(
        `📎 Đã đính kèm ${built.meta && built.meta.relPath ? built.meta.relPath : 'ngữ cảnh'}${send ? ' và đang gửi…' : ''}`,
        'ok',
        2200,
      );
    }
    if (send) {
      const sent = await sendChat();
      if (!sent) {
        toast('Đã chèn ngữ cảnh nhưng không gửi được — bấm Enter để gửi tay.', 'warn', 6000);
      }
      return sent;
    }
    return true;
  }

  /** Enter in the composer → attach first, then let the message go. */
  function onComposerKeydown(ev) {
    if (!state.quickKeys) return;
    if (ev.defaultPrevented) return; // Ctrl+Shift+Enter already handled it
    if (state.sendingNow) return; // our own synthetic Enter
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    const explicit = ev.ctrlKey || ev.metaKey; // Ctrl/Cmd+Enter always means "attach + send"
    if (!explicit && !state.autoAttachOnEnter) return;
    if (!state.online) return; // never break plain chat when the bridge is down
    const target = ev.target;
    if (!isComposer(target)) return;
    const text = composerText();
    if (!text.trim() || text.includes(MARKER) || text.includes('## File:')) {
      return; // already carrying context — send as-is
    }
    ev.preventDefault();
    ev.stopPropagation();
    void (async () => {
      const autoSend = explicit ? true : state.autoSendAfterAttach;
      await attachNow({ send: autoSend, quiet: true });
    })();
  }

  function isComposer(node) {
    if (!node) return false;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return true;
    if (node.isContentEditable) return true;
    const comp = findComposer();
    return Boolean(comp && (node === comp || comp.contains(node)));
  }

  /* ================================================================== *
   * 7. (2) Error loop: apply → wait for the analyser → post back
   * ================================================================== */

  function diffSummary(diff) {
    if (!diff) return '';
    const n = diff.newErrors ? diff.newErrors.length : 0;
    const f = diff.fixedErrors ? diff.fixedErrors.length : 0;
    return `+${n} lỗi mới / -${f} lỗi cũ${diff.settled ? '' : ' (chưa ổn định)'}`;
  }

  /** Decide what to do with the errors an apply produced. */
  async function followUpOnError(diff, ctx) {
    if (!diff || state.errorLoop === 'off') return;
    const newErrors = diff.newErrors || [];
    if (!newErrors.length) {
      if (diff.fixedErrors && diff.fixedErrors.length) {
        toast(`✔ ${ctx} — ${diff.fixedErrors.length} lỗi cũ đã được sửa, không phát sinh lỗi mới.`, 'ok', 3500);
      }
      return;
    }
    const key = newErrors.map((e) => `${e.file}:${e.message}`).join('|').slice(0, 400);
    if (state.reportedErrorKeys.has(key)) {
      toast(`(bỏ qua — đã báo lỗi này cho chat rồi) ${diffSummary(diff)}`, 'warn', 2500);
      return;
    }

    const text =
      diff.followUpText ||
      `VSCode báo ${newErrors.length} lỗi mới sau khi apply ${ctx}:\n` +
        newErrors.map((e) => `- ${e.file}:${e.line} ${e.message}`).join('\n');

    if (state.errorLoop === 'send') {
      state.reportedErrorKeys.add(key);
      insertIntoComposer('\n\n' + text);
      const sent = await sendChat();
      toast(sent ? `🩺 Đã gửi ${newErrors.length} lỗi mới cho AI` : 'Không gửi tự động được — đã chèn vào ô nhập.', sent ? 'ok' : 'warn', 4000);
      return;
    }
    if (state.errorLoop === 'attach') {
      state.reportedErrorKeys.add(key);
      insertIntoComposer('\n\n' + text);
      toast(`🩺 ${diffSummary(diff)} — đã chèn vào ô nhập (Enter để gửi)`, 'warn', 4500);
      return;
    }
    // 'ask'
    toast(`${diffSummary(diff)} — gửi lại cho AI?`, 'warn', 0, [
      {
        label: 'Gửi ngay',
        primary: true,
        onClick: async () => {
          state.reportedErrorKeys.add(key);
          insertIntoComposer('\n\n' + text);
          await sendChat();
        },
      },
      { label: 'Bỏ qua', onClick: () => undefined },
    ]);
  }

  /**
   * The language server may still be working when /apply returns.
   * Re-query /apply/errors until it settles or we hit the cap.
   */
  async function recheckErrors(applyId) {
    if (state.errorLoop === 'off' || !applyId) return;
    for (let i = 0; i < Math.max(0, state.errorLoopMaxChecks); i++) {
      await sleep(state.errorLoopRecheckMs || 6000);
      const r = await api.applyErrors(`applyId=${encodeURIComponent(applyId)}`);
      if (!r.ok) return;
      const diff = r.body.diagnosticsDiff;
      if (!diff) return;
      if (diff.settled || (diff.newErrors && diff.newErrors.length)) {
        await followUpOnError(diff, r.body.path || applyId);
        return;
      }
    }
  }

  async function reportApplyOutcome(res, label) {
    const b = res.body || {};
    const diff = b.diagnosticsDiff;
    if (b.applied) {
      state.lastApply = { applyId: b.applyId, batchId: b.batchId, path: b.path, diff };
      const extra = diff ? ` · ${diffSummary(diff)}` : '';
      const hasNew = Boolean(diff && diff.newErrors && diff.newErrors.length);
      if (hasNew && state.errorLoop !== 'off') {
        await followUpOnError(diff, label || b.path || 'file');
      } else {
        toast(`✔ ${b.message || `Applied → ${b.path}`}${extra}`, diff && !diff.settled ? 'warn' : 'ok', 4000);
      }
      // A clean-looking apply is exactly when a slow tsserver surprises us,
      // so re-check once (or errorLoopMaxChecks times) unless it already spoke up.
      if (state.errorLoop !== 'off' && (!diff || !diff.settled || !diff.newErrors.length)) {
        void recheckErrors(b.applyId);
      }
      return;
    }
    if (b.preview && b.applyId) {
      toast(`Đã mở diff trong VSCode cho ${b.path}.\nBấm Apply trong VSCode, hoặc xác nhận ở đây…`, 'ok', 6000);
      offerConfirmInChat(b.applyId, b.path);
      return;
    }
    toast(b.message || 'Không có thay đổi nào.', 'warn');
  }

  function offerConfirmInChat(applyId, filePath) {
    toast(`Diff đang chờ xác nhận: ${filePath}`, 'ok', 0, [
      {
        label: 'Confirm từ đây',
        primary: true,
        onClick: async () => {
          const r = await api.confirm(applyId);
          if (!r.ok) return reportError('Confirm', r);
          await reportApplyOutcome(r, filePath);
        },
      },
      {
        label: 'Discard',
        onClick: async () => {
          const r = await api.cancel(applyId);
          toast(r.ok ? 'Đã huỷ thay đổi.' : `Huỷ thất bại: ${r.status}`, r.ok ? 'warn' : 'err');
        },
      },
    ]);
  }

  async function undoLastApply() {
    const id = state.lastApply && (state.lastApply.applyId || state.lastApply.batchId);
    if (!id) {
      toast('Không có apply nào để undo trong phiên này.', 'warn');
      return;
    }
    const payload = state.lastApply.applyId ? { applyId: id } : { batchId: id };
    const r = await api.applyUndo(payload);
    if (!r.ok) return reportError('Undo', r);
    toast(`⟲ ${r.body.message}`, 'ok', 5000);
    state.lastApply = null;
  }

  /* ================================================================== *
   * 8. Apply actions
   * ================================================================== */

  /**
   * Guess a target path from the text right BEFORE a code block (a caption such
   * as "Update `src/app.ts`:"). Deliberately conservative: as soon as we meet
   * another code block, or anything long, we give up — a block must never
   * inherit a neighbour's path, that would write into the wrong file.
   */
  function detectPathNearBlock(block) {
    let node = block;
    for (let depth = 0; depth < 3 && node; depth++) {
      let prev = node.previousElementSibling;
      for (let i = 0; i < 2 && prev; i++) {
        const text = (prev.textContent || '').trim();
        if (prev.querySelector('pre, code') || text.length > 160 || text.indexOf('```') >= 0) {
          return '';
        }
        const m = /([A-Za-z0-9_.@\-/][A-Za-z0-9_./\-]*\.[A-Za-z0-9]{1,8})/.exec(text);
        if (m && !/\s/.test(m[1]) && !/^https?:/i.test(m[1])) return m[1];
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
    const parsed = stripFence(codeText);
    const code = parsed.code;
    const suggestedPath = parsed.pathHint || detectPathNearBlock(block) || (state.health && state.health.activeFile) || '';

    const pathInput = el('input', { type: 'text', value: suggestedPath, placeholder: 'src/app.ts (để trống = file đang active)' });
    const modeSelect = el(
      'select',
      {},
      ...[
        ['replace', 'replace — ghi đè toàn bộ file'],
        ['replaceSelection', 'replaceSelection — thay thế vùng đang bôi đen'],
        ['insert', 'insert — chèn tại con trỏ'],
        ['append', 'append — thêm vào cuối file'],
        ['insertAtLine', 'insertAtLine — chèn trước dòng N'],
        ['lines', 'lines — thay thế từ dòng N đến M'],
        ['newFile', 'newFile — tạo file mới'],
        ['patch', 'patch — search & replace (cần chọn text)'],
      ].map(([v, label]) => el('option', { value: v }, label)),
    );
    modeSelect.value = state.insertMode;

    const lineInput = el('input', { type: 'number', min: '1', value: '1', style: 'display:none' });
    const endLineInput = el('input', { type: 'number', min: '1', value: '1', style: 'display:none' });
    const searchInput = el('textarea', {
      rows: '3',
      placeholder: 'Đoạn text cần tìm trong file…',
      style: 'display:none;width:100%;box-sizing:border-box;background:#111214;color:#e8e8e8;border:1px solid #3a3d44;border-radius:6px;padding:6px 8px;font-family:ui-monospace,monospace;font-size:12px',
    });

    const sync = () => {
      const mode = modeSelect.value;
      lineInput.style.display = mode === 'insertAtLine' || mode === 'lines' ? '' : 'none';
      endLineInput.style.display = mode === 'lines' ? '' : 'none';
      searchInput.style.display = mode === 'patch' ? '' : 'none';
      if (mode === 'patch' && !searchInput.value) {
        searchInput.value = code.split('\n').slice(0, Math.min(6, code.length)).join('\n');
      }
    };
    modeSelect.addEventListener('change', sync);
    sync();

    const previewCheck = el('input', { type: 'checkbox' });
    previewCheck.checked = state.preview;
    const saveCheck = el('input', { type: 'checkbox' });
    saveCheck.checked = state.autoSave;
    const errCheck = el('input', { type: 'checkbox' });
    errCheck.checked = state.errorLoop !== 'off';

    const preview = el('pre', {
      style: 'max-height:26vh;overflow:auto;background:#111214;border:1px solid #2f3136;border-radius:8px;padding:10px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;margin:8px 0',
      text: code.length > 4000 ? `${code.slice(0, 4000)}\n\n… (${code.length - 4000} ký tự nữa)` : code,
    });

    openModal(
      `Apply → VSCode ${parsed.language ? `(${parsed.language}, ${code.split('\n').length} dòng)` : ''}`,
      [
        el('div', { class: 'cs-fields' },
          el('label', {}, 'File (tương đối workspace / tuyệt đối / tên file)'),
          pathInput,
          el('label', {}, 'Chế độ ghi'),
          modeSelect,
          el('label', {}, 'Dòng bắt đầu'),
          lineInput,
          el('label', {}, 'Dòng kết thúc'),
          endLineInput,
          el('label', {}, 'Đoạn text cần tìm (patch)'),
          searchInput),
        el('label', { class: 'cs-check' }, previewCheck, ' Xem diff trong VSCode trước khi ghi'),
        el('label', { class: 'cs-check' }, saveCheck, ' Lưu file sau khi ghi'),
        el('label', { class: 'cs-check' }, errCheck, ' Gửi lỗi mới của VSCode trở lại chat sau khi apply'),
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
              line: Number(lineInput.value) || undefined,
              endLine: Number(endLineInput.value) || undefined,
              search: modeSelect.value === 'patch' ? searchInput.value : undefined,
              preview: previewCheck.checked,
              save: saveCheck.checked,
              label: `userscript:${location.hostname}`,
            };
            state.preview = previewCheck.checked;
            state.autoSave = saveCheck.checked;
            state.insertMode = modeSelect.value;
            state.errorLoop = errCheck.checked ? (state.errorLoop === 'off' ? 'attach' : state.errorLoop) : 'off';
            saveSettings();
            close();
            await doApply(payload);
          },
        },
      ],
    );
  }

  async function doApply(payload) {
    payload.settleMs = payload.settleMs || state.settleMs;
    payload.settleTimeoutMs = payload.settleTimeoutMs || 12000;
    setBusy(true);
    const r = await api.apply(payload, { timeout: 60000 });
    setBusy(false);
    if (!r.ok) {
      reportError('Apply', r);
      return r;
    }
    await reportApplyOutcome(r, payload.path);
    return r;
  }

  /* ------------------------------------------------------------------ *
   * (3) Auto-apply: code blocks that name a file get applied by themselves
   * ------------------------------------------------------------------ */

  function queueAutoApply(block) {
    state.pendingAutoBlocks.push(block);
    clearTimeout(state.autoFlushTimer);
    // give the rest of the answer a moment to finish rendering, then batch
    state.autoFlushTimer = setTimeout(flushAutoApply, 900);
  }

  async function flushAutoApply() {
    const queue = state.pendingAutoBlocks.splice(0);
    if (!queue.length || state.busy) return;
    const items = [];
    const sigs = [];
    for (const b of queue) {
      const parsed = stripFence(b.code);
      const path = parsed.pathHint || b.pathHint;
      if (!path) continue;
      const sig = `${path}::${parsed.code.length}:${simpleHash(parsed.code)}`;
      if (state.autoAppliedKeys.has(sig)) continue;
      state.autoAppliedKeys.add(sig);
      sigs.push(sig);
      items.push({
        path,
        content: parsed.code,
        mode: 'replace',
        preview: state.autoApplyPreview === 'auto' ? 'auto' : state.autoApplyPreview === true,
        save: state.autoSave,
        settleMs: state.settleMs,
        label: 'auto-apply',
      });
      b.autoSig = sig;
    }
    if (!items.length) return;

    setBusy(true);
    let res;
    if (items.length === 1) {
      res = await api.apply(items[0], { timeout: 60000 });
    } else {
      res = await api.applyBatch(items);
      if (res.ok && res.body.batchId) {
        state.lastApply = { batchId: res.body.batchId, diff: res.body.diagnosticsDiff };
      }
    }
    setBusy(false);

    if (!res.ok) {
      // do not silently drop the work: forget the signatures so the chips still work
      sigs.forEach((sig) => state.autoAppliedKeys.delete(sig));
      reportError('Auto-apply', res);
      return;
    }
    const label = items.length === 1 ? items[0].path : `${items.length} files`;
    toast(`🤖 Auto-apply → ${label}`, 'ok', 3000);
    markAuto(queue);
    if (items.length === 1) {
      await reportApplyOutcome(res, label);
    } else {
      await followUpOnError(res.body.diagnosticsDiff, label);
      toastBatchResults(res.body);
    }
  }

  function markAuto(queue) {
    queue.forEach((b) => {
      const bar = b.element && b.element.csToolbar;
      const chip = bar && bar.querySelector('[data-cs-auto]');
      if (chip) {
        chip.classList.add('done');
        chip.textContent = '✅ auto-applied';
        const undo = bar.querySelector('[data-cs-undo]');
        if (undo) undo.style.display = '';
      }
    });
  }

  function toastBatchResults(body) {
    const results = (body && body.results) || [];
    const details = results
      .map((r) => `${(r.body && r.body.applied) ? '✔' : '·'} ${r.path}`)
      .join('\n');
    if (details) toast(`Batch apply:\n${details}`, body.failed ? 'warn' : 'ok', 6000);
  }

  async function applyAllBlocks() {
    const blocks = collectCodeBlocks().filter((b) => b.code.trim().length > 0);
    if (!blocks.length) {
      toast('Không tìm thấy code block nào trong trang.', 'warn');
      return;
    }
    const ctx = await api.contextFile('content=0');
    const activePath = ctx.ok && ctx.body.hasEditor ? ctx.body.relPath : '';
    const applies = blocks.map((b) => {
      const parsed = stripFence(b.code);
      return {
        path: parsed.pathHint || b.pathHint || activePath || undefined,
        mode: 'replace',
        content: parsed.code,
        preview: state.autoApplyPreview === 'auto' ? 'auto' : state.preview,
        save: state.autoSave,
        settleMs: state.settleMs,
        label: 'apply-all',
      };
    });
    if (!confirm(`Ghi ${applies.length} code block vào VSCode (preview=auto: nhỏ → ghi trực tiếp, lớn/file mới → diff)?`)) return;
    setBusy(true);
    const r = await api.applyBatch(applies);
    setBusy(false);
    if (!r.ok) return reportError('Apply all', r);
    toast(`Batch: ${r.body.count - r.body.failed}/${r.body.count} thành công · ${diffSummary(r.body.diagnosticsDiff)}`, r.body.failed ? 'warn' : 'ok', 6000);
    state.lastApply = { batchId: r.body.batchId };
    await followUpOnError(r.body.diagnosticsDiff, 'apply all');
  }

  function simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* ================================================================== *
   * 9. Code block scanning (MutationObserver, streaming-safe)
   * ================================================================== */

  const processed = new WeakSet();
  const lastChange = new WeakMap();

  function collectCodeBlocks() {
    const seen = new Set();
    const out = [];
    for (const sel of ['pre code', 'pre', 'div.code-block code']) {
      document.querySelectorAll(sel).forEach((node) => {
        const pre = node.tagName === 'PRE' ? node : node.closest('pre');
        const codeEl = node.tagName === 'CODE' ? node : pre ? pre.querySelector('code') : null;
        const target = pre || node;
        if (!target || seen.has(target)) return;
        if (!target.offsetParent && target.getClientRects().length === 0) return;
        const text = (codeEl || target).innerText || (codeEl || target).textContent || '';
        if (!text.trim()) return;
        seen.add(target);
        const parsed = stripFence(text);
        out.push({
          element: target,
          codeEl: codeEl || target,
          code: text,
          language: codeEl ? detectLanguage(codeEl) : '',
          pathHint: parsed.pathHint || detectPathNearBlock(target),
        });
      });
    }
    return out;
  }

  function isStreaming() {
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
        }
        continue;
      }
      if (!ready) continue;

      processed.add(block.element);
      const parsed = stripFence(block.code);
      const bar = el('div', { class: 'cs-block-tools' });
      const label = parsed.pathHint || block.pathHint || parsed.language || `${block.code.split('\n').length} dòng`;
      bar.appendChild(el('span', { class: 'cs-meta', text: label }));

      const quick = el('button', {
        class: 'cs-chip primary',
        text: '⚡ Apply to VSCode',
        title: 'Ghi vào file đang active (hoặc file nêu trong code block)',
        'data-cs-needs-ready': true,
        onclick: async () => {
          quick.disabled = true;
          const ctx = await api.contextFile('content=0');
          quick.disabled = false;
          if (!ctx.ok) return reportError('Apply', ctx);
          if (!ctx.body.hasEditor && !block.pathHint) {
            toast('Không có file active trong VSCode — dùng ⚙ Options để chỉ định file.', 'err', 5000);
            return;
          }
          await doApply({
            path: block.pathHint || ctx.body.relPath,
            mode: ctx.body.hasSelection && !block.pathHint ? 'replaceSelection' : 'replace',
            content: parsed.code,
            preview: state.preview,
            save: state.autoSave,
            label: 'quick-apply',
          });
        },
      });
      const auto = el('button', {
        class: 'cs-chip',
        text: parsed.pathHint || block.pathHint ? `🤖 Auto → ${parsed.pathHint || block.pathHint}` : '🤖 Auto-apply',
        title: parsed.pathHint || block.pathHint
          ? 'Áp dụng ngay theo đường dẫn nêu trong block'
          : 'Block không nêu đường dẫn file — bật auto-apply vẫn bỏ qua nó',
        disabled: !parsed.pathHint && !block.pathHint,
        onclick: () => queueAutoApply(block),
      });
      const detailed = el('button', { class: 'cs-chip', text: '⚙ Options', title: 'Chọn file / chế độ ghi / patch', onclick: () => openApplyModal(block.code, block.element) });
      const copy = el('button', {
        class: 'cs-chip',
        text: '⧉ Copy',
        onclick: () => {
          gmCopy(parsed.code);
          toast('Đã copy code.', 'ok', 1500);
        },
      });
      const undoChip = el('button', {
        class: 'cs-chip',
        text: '⟲ Undo',
        title: 'Khôi phục nội dung trước khi apply (10 phút)',
        style: 'display:none',
        'data-cs-undo': '1',
        onclick: undoLastApply,
      });
      if (parsed.pathHint || block.pathHint) auto.setAttribute('data-cs-auto', '1');
      bar.append(quick, auto, detailed, copy, undoChip);
      block.element.csToolbar = bar;
      block.element.addEventListener('mouseenter', () => (state.lastHoveredBlock = block));

      const anchor =
        block.element.parentElement && /code-block|highlight|markdown|message/i.test(block.element.parentElement.className || '')
          ? block.element.parentElement
          : block.element;
      if (anchor.parentElement) anchor.insertAdjacentElement('afterend', bar);
      else anchor.appendChild(bar);

      // (3) fire-and-forget auto apply for blocks that declare a path
      if (state.autoApply && (parsed.pathHint || block.pathHint)) {
        queueAutoApply(block);
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
   * 10. Panel
   * ================================================================== */

  let fab, panel, statusBox, settingsBox;

  function checkbox(key, label, extraHint) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(state[key]);
    input.addEventListener('change', () => {
      state[key] = input.checked;
      saveSettings();
    });
    const wrap = el('label', { class: 'cs-check' }, input, ' ' + label);
    if (extraHint) wrap.appendChild(el('span', { class: 'cs-hint', text: ' — ' + extraHint }));
    return wrap;
  }

  function select(key, label, options) {
    const s = el('select', {});
    options.forEach(([v, text]) => s.appendChild(el('option', { value: v }, text)));
    s.value = state[key];
    s.addEventListener('change', () => {
      state[key] = s.value;
      saveSettings();
    });
    return el('div', {}, el('label', { class: 'cs-hint', text: label }), s);
  }

  function buildPanel() {
    statusBox = el('div', { class: 'cs-status', text: 'đang kiểm tra kết nối…' });

    const btnSend = el('button', {
      class: 'cs-btn primary',
      text: '📎 Attach + Gửi (Ctrl+Shift+↩)',
      title: 'Chèn ngữ cảnh rồi gửi luôn tin nhắn',
      onclick: () => attachNow({ send: true }),
    });
    const btnAttach = el('button', { class: 'cs-btn', text: '📎 Chỉ chèn ngữ cảnh', onclick: () => attachNow({ send: false }) });
    const btnErrors = el('button', { class: 'cs-btn', text: '🐞 Attach Problems', onclick: () => attachErrors('Warning') });
    const btnTabs = el('button', { class: 'cs-btn', text: '🗂 Chọn file…', onclick: openTabsModal });
    const btnApplyAll = el('button', { class: 'cs-btn', text: '⚡ Apply all blocks', onclick: applyAllBlocks });
    const btnRecheck = el('button', {
      class: 'cs-btn',
      text: '🩺 Kiểm tra lỗi lại',
      title: 'Hỏi lại VSCode xem apply gần nhất còn lỗi gì',
      onclick: async () => {
        const id = state.lastApply && state.lastApply.applyId;
        if (!id) {
          const h = await api.applyHistory();
          if (h.ok && h.body.count) {
            toast(`Apply gần nhất: ${h.body.applies[0].path} (${h.body.applies[0].mode}) — bấm chip ⟲ Undo để hoàn tác.`, 'ok', 5000);
            state.lastApply = { applyId: h.body.applies[0].applyId, path: h.body.applies[0].path };
          } else {
            toast('Chưa có apply nào trong phiên này.', 'warn');
          }
          return;
        }
        const r = await api.applyErrors(`applyId=${encodeURIComponent(id)}`);
        if (!r.ok) return reportError('Recheck', r);
        const d = r.body.diagnosticsDiff;
        toast(
          d
            ? `${r.body.path}: ${diffSummary(d)}${d.newErrors && d.newErrors.length ? '\n' + d.newErrors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.message}`).join('\n') : ''}`
            : 'Không có diagnostics nào.',
          d && d.newErrors.length ? 'warn' : 'ok',
          6000,
        );
        await followUpOnError(d, r.body.path);
      },
    });
    const btnUndo = el('button', { class: 'cs-btn', text: '⟲ Undo apply cuối', title: 'Khôi phục nội dung trước apply', onclick: undoLastApply });
    const btnRefresh = el('button', { class: 'cs-btn', text: '🔄 Refresh', onclick: refreshStatus });
    const btnSettings = el('button', { class: 'cs-btn', text: '⚙ Settings', onclick: toggleSettings });

    settingsBox = el('div', { style: 'display:none' },
      el('div', { class: 'cs-sep' }),
      el('div', { class: 'cs-fields' },
        el('label', {}, 'Server URL'),
        el('input', {
          type: 'text',
          value: state.base,
          onchange: (e) => {
            state.base = e.target.value.trim().replace(/\/$/, '');
            saveSettings();
            refreshStatus();
          },
        }),
        el('label', {}, 'Token (X-ChatSync-Token)'),
        el('input', {
          type: 'text',
          value: state.token,
          placeholder: 'dán token từ VSCode',
          onchange: (e) => {
            state.token = e.target.value.trim();
            saveSettings();
            refreshStatus();
          },
        })),

      el('div', { class: 'cs-legend', text: '(1) Tự đính kèm ngữ cảnh' }),
      checkbox('autoAttachOnEnter', 'Chặn Enter để chèn ngữ cảnh trước khi gửi'),
      checkbox('autoSendAfterAttach', 'Tự bấm Gửi sau khi chèn'),
      select('attachScope', 'Phạm vi ngữ cảnh', [
        ['auto', 'auto — file được nhắc tới trong prompt, nếu không thì file active'],
        ['selection', 'chỉ vùng đang bôi đen'],
        ['activeFile', 'luôn là file đang active'],
        ['none', 'tắt (chỉ dùng nút)'],
      ]),
      select('attachErrors', 'Lỗi trong Problems', [
        ['ifAny', 'chỉ đính kèm khi file thật sự có lỗi'],
        ['always', 'luôn đính kèm'],
        ['never', 'không bao giờ'],
      ]),

      el('div', { class: 'cs-legend', text: '(2) Vòng lặp apply → lỗi → chat' }),
      select('errorLoop', 'Khi apply sinh lỗi mới', [
        ['send', 'tự gửi thẳng cho AI'],
        ['attach', 'chèn vào ô nhập (mình bấm Enter)'],
        ['ask', 'hỏi bằng toast trước'],
        ['off', 'tắt'],
      ]),
      el('div', { class: 'cs-fields' },
        el('label', {}, `Re-check sau (ms) — hạn ${state.errorLoopMaxChecks} lần`),
        el('input', {
          type: 'number',
          value: String(state.errorLoopRecheckMs),
          onchange: (e) => {
            state.errorLoopRecheckMs = Number(e.target.value) || 6000;
            saveSettings();
          },
        })),

      el('div', { class: 'cs-legend', text: '(3) Tự áp dụng code block' }),
      checkbox('autoApply', 'Tự apply block có ghi đường dẫn file', 'khi AI trả lời xong'),
      select('autoApplyPreview', 'An toàn khi auto-apply', [
        ['auto', 'auto — sửa nhỏ ghi thẳng, file mới/thay đổi lớn mở diff'],
        ['true', 'luôn mở diff trước khi ghi'],
        ['false', 'ghi thẳng (Ctrl+Z được)'],
      ]),

      el('div', { class: 'cs-sep' }),
      el('label', { class: 'cs-check' }, (() => {
        const c = el('input', { type: 'checkbox' });
        c.checked = state.preview;
        c.addEventListener('change', () => {
          state.preview = c.checked;
          saveSettings();
        });
        return c;
      })(), ' Nút ⚡ Apply mặc định xem diff trước'),
      el('label', { class: 'cs-check' }, (() => {
        const c = el('input', { type: 'checkbox' });
        c.checked = state.autoSave;
        c.addEventListener('change', () => {
          state.autoSave = c.checked;
          saveSettings();
        });
        return c;
      })(), ' Tự lưu file sau khi ghi'),
      checkbox('quickKeys', 'Phím tắt (Alt+Shift+V / A / U, Ctrl+Shift+↩)'),
      el('div', { class: 'cs-hint', text: 'Token: VSCode → Ctrl+Shift+P → "ChatSync: Show Connection Info".' }),
    );

    panel = el('div', { class: 'cs-panel' },
      el('h3', {}, '🔌 ChatSync', el('span', { class: 'cs-meta', text: 'VSCode bridge' })),
      statusBox,
      el('div', { class: 'cs-row' }, btnSend, btnAttach),
      el('div', { class: 'cs-row' }, btnErrors, btnTabs),
      el('div', { class: 'cs-row' }, btnApplyAll, btnRecheck, btnUndo),
      el('div', { class: 'cs-row' }, btnRefresh, btnSettings),
      settingsBox,
    );

    fab = el('button', { class: 'cs-fab', title: 'ChatSync — kết nối VSCode', onclick: togglePanel },
      el('span', { text: '⌘' }),
      el('span', { class: 'cs-dot' }));

    document.body.append(fab, panel);

    document.addEventListener('keydown', (e) => {
      if (!state.quickKeys) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void attachNow({ send: true, quiet: false });
        return;
      }
      if (!e.altKey || !e.shiftKey) {
        if (e.key === 'Escape' && panel.classList.contains('cs-open')) togglePanel();
        return;
      }
      const k = (e.key || '').toLowerCase();
      if (k === 'v') {
        e.preventDefault();
        void attachNow({ send: false });
      } else if (k === 'a') {
        e.preventDefault();
        const b = state.lastHoveredBlock || collectCodeBlocks().slice(-1)[0];
        if (!b) return toast('Không có code block nào.', 'warn');
        openApplyModal(b.code, b.element);
      } else if (k === 'u') {
        e.preventDefault();
        void undoLastApply();
      }
    }, true);

    // capture-phase: intercept Enter from the composer itself
    document.addEventListener('keydown', onComposerKeydown, true);
  }

  async function attachErrors(minSeverity) {
    setBusy(true);
    const r = await api.errors(`minSeverity=${minSeverity || 'Warning'}&limit=100`);
    setBusy(false);
    if (!r.ok) return reportError('Problems', r);
    if (!r.body.count) {
      toast('Không có lỗi/cảnh báo nào trong Problems panel.', 'ok');
      return false;
    }
    insertIntoComposer(`## Problems in VSCode (${r.body.count})\n\n${r.body.text}\n`);
    toast(`Đã chèn ${r.body.count} diagnostics.`, 'ok');
    return true;
  }

  function openTabsModal() {
    (async () => {
      setBusy(true);
      const r = await api.tabs();
      setBusy(false);
      if (!r.ok) return reportError('Tabs', r);
      const tabs = r.body.tabs || [];
      if (!tabs.length) {
        toast('Không có tab nào đang mở.', 'warn');
        return;
      }
      let selected = null;
      const list = el('div', { class: 'cs-list' });
      tabs.forEach((t) => {
        const item = el('div', {
          class: `cs-list-item${t.isActive ? ' cs-sel' : ''}`,
          onclick: () => {
            list.querySelectorAll('.cs-list-item').forEach((n) => n.classList.remove('cs-sel'));
            item.classList.add('cs-sel');
            selected = t;
          },
        },
          el('span', { text: t.path, style: 'flex:1;overflow:hidden;text-overflow:ellipsis' }),
          t.isDirty ? el('span', { class: 'cs-meta', text: '●' }) : null,
          t.isActive ? el('span', { class: 'cs-meta', text: 'active' }) : null);
        if (t.isActive) selected = t;
        list.appendChild(item);
      });
      openModal(`Open tabs (${tabs.length})`, [list, el('div', { class: 'cs-hint', text: 'Chọn 1 file để chèn vào prompt.' })], [
        { label: 'Đóng' },
        {
          label: 'Chèn nội dung',
          primary: true,
          onClick: async (close) => {
            if (!selected) {
              toast('Chưa chọn file nào.', 'warn');
              return;
            }
            close();
            setBusy(true);
            const f = await api.file(selected.path, '&content=1');
            setBusy(false);
            if (!f.ok) return reportError('Read file', f);
            insertIntoComposer(formatFileBlock(f.body));
            toast(`Đã chèn ${f.body.path} (${f.body.lineCount} dòng).`, 'ok');
          },
        },
      ]);
    })();
  }

  function reportError(label, r) {
    const msg = (r.body && (r.body.error || r.body.hint)) || r.error || `HTTP ${r.status}`;
    if (r.status === 0) {
      setOnline(false);
      toast(`${label}: không kết nối được ChatSync (VSCode đã mở chưa? extension đã activate chưa?)`, 'err', 6000);
    } else if (r.status === 401) {
      toast(`${label}: sai token — mở ⚙ Settings và dán token (lệnh "ChatSync: Show Connection Info").`, 'err', 8000);
      openSettingsSection();
    } else if (r.status === 410) {
      toast(`${label}: ${msg}`, 'warn', 6000);
    } else {
      toast(`${label}: ${msg}`, 'err', 6000);
    }
    console.warn('[ChatSync]', label, r);
  }

  function togglePanel() {
    panel.classList.toggle('cs-open');
    if (panel.classList.contains('cs-open')) refreshStatus();
  }

  function openSettingsSection() {
    panel.classList.add('cs-open');
    settingsBox.style.display = '';
  }

  function toggleSettings() {
    settingsBox.style.display = settingsBox.style.display === 'none' ? '' : 'none';
  }

  function setOnline(on) {
    state.online = on;
    fab.classList.toggle('cs-on', on);
    fab.classList.toggle('cs-err', !on);
  }

  function setBusy(busy) {
    state.busy = busy;
    if (fab) fab.style.opacity = busy ? '0.6' : '';
  }

  async function refreshStatus() {
    const r = await api.health();
    if (!r.ok || !r.body.ok) {
      setOnline(false);
      state.health = null;
      statusBox.innerHTML = '';
      statusBox.append(
        el('div', {}, '❌ Không kết nối được ', el('b', { text: state.base })),
        el('div', { class: 'cs-hint', text: (r.body && r.body.error) || 'Mở VSCode — status bar góc phải phải hiện "ChatSync :cổng".' }),
      );
      return;
    }
    setOnline(true);
    state.health = r.body;
    if (!state.token && r.body.token) {
      state.token = r.body.token; // /health is loopback-only and public → auto-pair
      saveSettings();
      const inputs = settingsBox.querySelectorAll('input[type="text"]');
      if (inputs[1]) inputs[1].value = state.token;
    }
    statusBox.innerHTML = '';
    statusBox.append(
      el('div', {}, '✅ ', el('b', { text: `:${r.body.port}` }), ` · v${r.body.version} · VSCode ${r.body.vscodeVersion}`),
      el('div', { class: 'cs-hint', text: `workspace: ${r.body.workspace || '(chưa mở folder nào)'}` }),
      el('div', { class: 'cs-hint', text: `active: ${r.body.activeFile || '—'} · applyMode: ${r.body.applyMode} · settle: ${r.body.diagnosticsSettleMs}ms` }),
      el('div', {
        class: 'cs-hint',
        text: `tự động: attach=${state.autoAttachOnEnter ? 'bật' : 'tắt'} · errorLoop=${state.errorLoop} · autoApply=${state.autoApply ? state.autoApplyPreview : 'tắt'}`,
      }),
    );
  }

  /* ================================================================== *
   * 11. Modal
   * ================================================================== */

  function openModal(title, contentNodes, actions) {
    const card = el('div', { class: 'cs-modal-card' }, el('h4', { text: title }));
    contentNodes.forEach((n) => card.appendChild(n));
    const bar = el('div', { class: 'cs-modal-actions' });
    const overlay = el('div', { class: 'cs-modal' }, card);
    const close = () => overlay.remove();
    (actions || [{ label: 'Đóng' }]).forEach((a) => {
      bar.appendChild(
        el('button', { class: `cs-btn ${a.primary ? 'primary' : ''}`, text: a.label, onclick: () => (a.onClick ? a.onClick(close) : close()) }),
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
   * 12. Boot
   * ================================================================== */

  function boot() {
    if (window.top !== window.self) return;
    if (document.querySelector('.cs-fab')) return;
    injectStyles();
    loadSettings();
    buildPanel();
    refreshStatus();

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
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(schedule, 1500);
    setInterval(refreshStatus, POLL_MS);
    window.addEventListener('focus', refreshStatus);

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('ChatSync: Attach context + Send', () => attachNow({ send: true }));
      GM_registerMenuCommand('ChatSync: Attach active file', () => attachNow({ send: false }));
      GM_registerMenuCommand('ChatSync: Attach problems', () => attachErrors('Warning'));
      GM_registerMenuCommand('ChatSync: Apply all code blocks', applyAllBlocks);
      GM_registerMenuCommand('ChatSync: Re-check errors of last apply', () => {
        const id = state.lastApply && state.lastApply.applyId;
        if (!id) return toast('Chưa có apply nào.', 'warn');
        void api.applyErrors(`applyId=${encodeURIComponent(id)}`).then((r) => r.ok && followUpOnError(r.body.diagnosticsDiff, r.body.path));
      });
      GM_registerMenuCommand('ChatSync: Undo last apply', undoLastApply);
      GM_registerMenuCommand('ChatSync: Toggle auto-apply', () => {
        state.autoApply = !state.autoApply;
        saveSettings();
        toast(`Auto-apply ${state.autoApply ? 'BẬT' : 'TẮT'}`, 'ok', 2500);
      });
      GM_registerMenuCommand('ChatSync: Settings', openSettingsSection);
    }

    console.info('[ChatSync] userscript v0.2.0 →', state.base, {
      autoAttachOnEnter: state.autoAttachOnEnter,
      errorLoop: state.errorLoop,
      autoApply: state.autoApply,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
