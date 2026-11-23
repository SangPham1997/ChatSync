/**
 * Userscript smoke test (v0.2 — auto-attach, error loop, auto-apply).
 *
 * Boots the REAL extension server (through the vscode stub) and runs the REAL
 * userscript in a fake DOM that talks to it over HTTP through a
 * GM_xmlhttpRequest shim.
 *
 *   npm run test:userscript
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createDocument, createWindow, DomEvent } = require('./dom-stub.cjs');
const { buildExtensionBundle } = require('./bundle-helper.cjs');

const PORT = Number(process.env.CHATSYNC_UITEST_PORT || 4899);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'CS-TEST-TOKEN-1234';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u001b[32m✔\u001b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  \u001b[31m✘\u001b[0m ${name}\n      ${String(e.message || e).split('\n').join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, timeout = 12000, label = 'condition') => {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (_) {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(70);
  }
};

/* ------------------------------------------------------------------ *
 * fixture workspace
 * ------------------------------------------------------------------ */

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsync-ui-'));
const appFile = path.join(ws, 'src', 'app.ts');
fs.mkdirSync(path.dirname(appFile), { recursive: true });
const APP_SOURCE = 'export const BEFORE = true;\nexport const keep = 1;\n';
fs.writeFileSync(appFile, APP_SOURCE, 'utf8');
fs.writeFileSync(path.join(ws, 'src', 'win.ts'), 'export const WIN = 1;\n', 'utf8');
const readApp = () => fs.readFileSync(appFile, 'utf8');
const rel = (p) => path.relative(ws, p).split(path.sep).join('/');

/* ------------------------------------------------------------------ *
 * fake browser factory
 * ------------------------------------------------------------------ */

function makeDom({ blocks = [] } = {}) {
  const document = createDocument();
  const window = createWindow(document);
  const store = new Map();
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  const form = document.createElement('form');
  const composer = document.createElement('textarea');
  composer.setAttribute('data-id', 'root');
  composer.setAttribute('placeholder', 'Message…');
  const sendBtn = document.createElement('button');
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.setAttribute('type', 'submit');
  const sent = [];
  sendBtn.addEventListener('click', () => {
    sent.push(composer.value);
    composer.value = '';
  });
  // emulate the site's own Enter-to-send (skipped when our capture hook prevented it)
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
      sendBtn.click();
    }
  });
  form.append(composer, sendBtn);
  document.body.appendChild(form);

  const message = document.createElement('div');
  message.className = 'ds-markdown message-content';
  document.body.appendChild(message);

  const addBlock = ({ lang, code, caption, path: p }) => {
    if (caption) {
      const para = document.createElement('p');
      para.textContent = caption;
      message.appendChild(para);
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.className = `language-${lang || 'text'}`;
    // the block carries an explicit target path — this is what feature 3 keys on
    const body = [p ? `// ${p}` : '', code].filter(Boolean).join('\n');
    codeEl.textContent = body;
    pre.appendChild(codeEl);
    wrapper.appendChild(pre);
    message.appendChild(wrapper);
    return { wrapper, pre, codeEl };
  };

  blocks.forEach(addBlock);

  const api = {
    document,
    window,
    composer,
    sendBtn,
    sent,
    message,
    addBlock,
    find: (sel) => document.querySelector(sel),
    all: (sel) => document.querySelectorAll(sel),
    text: (sel) => (document.querySelector(sel) ? document.querySelector(sel).textContent : ''),
    buttons: (root) => (root || document).querySelectorAll('button'),
    byLabel(label, root) {
      return (root || document).querySelectorAll('button').find((b) => (b.textContent || '').includes(label));
    },
    toasts: () => document.querySelectorAll('.cs-toast').map((t) => t.textContent).join(' | '),
    chipIn(label) {
      for (const bar of document.querySelectorAll('.cs-block-tools')) {
        const chip = bar.querySelectorAll('button').find((b) => (b.textContent || '').includes(label));
        if (chip) return { bar, chip };
      }
      return null;
    },
  };
  return api;
}

function makeGm(domRef, record) {
  const gmStore = new Map();
  const api = {
    GM_xmlhttpRequest(opts) {
      const headers = { ...(opts.headers || {}) };
      const init = { method: opts.method || 'GET', headers };
      if (opts.data !== undefined && opts.data !== null) init.body = opts.data;
      const timer = setTimeout(() => opts.ontimeout && opts.ontimeout({}), opts.timeout || 40000);
      record.requests.push({ method: opts.method, path: new URL(opts.url).pathname, at: Date.now() });
      fetch(opts.url, init)
        .then(async (r) => {
          clearTimeout(timer);
          const text = await r.text();
          opts.onload && opts.onload({ status: r.status, responseText: text, response: text, finalUrl: opts.url });
        })
        .catch((e) => {
          clearTimeout(timer);
          record.errors.push(`${opts.method} ${opts.url}: ${(e && e.message) || e}`);
          opts.onerror && opts.onerror({ error: String((e && e.message) || e) });
        });
    },
    GM_addStyle(css) {
      const style = domRef.window.document.createElement('style');
      style.textContent = css;
      domRef.window.document.head.appendChild(style);
      record.styles++;
      return style;
    },
    GM_getValue: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
    GM_setValue: (k, v) => gmStore.set(k, v),
    GM_setClipboard: (t) => (record.clipboard = t),
    GM_registerMenuCommand: (label, fn) => record.menus.push({ label, fn }),
    __gmStore: gmStore,
  };
  return api;
}

function makeSandbox(dom, gm) {
  const win = dom.window;
  const sandbox = {
    ...gm,
    window: win,
    document: win.document,
    navigator: win.navigator,
    location: win.location,
    localStorage: win.localStorage,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    fetch,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Proxy,
    Reflect,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    TextEncoder,
    TextDecoder,
    Event: DomEvent,
    KeyboardEvent: DomEvent,
    InputEvent: DomEvent,
    CustomEvent: DomEvent,
    MutationObserver: win.MutationObserver,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLInputElement: win.HTMLInputElement,
    getSelection: win.document.getSelection,
    prompt: () => null,
    confirm: () => true,
    alert: () => {},
    requestAnimationFrame: win.requestAnimationFrame,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  return sandbox;
}

const USERSCRIPT = path.resolve(__dirname, '..', '..', 'userscript', 'chatsync.user.js');

function runUserscript(sandbox, settings) {
  let source = fs.readFileSync(USERSCRIPT, 'utf8');
  const patched = source.replace(
    /(const DEFAULTS = \{ port: )\d+(, token: ')[^']*(' \};)/,
    `$1${PORT}$2${TOKEN}$3`,
  );
  assert.ok(patched.includes(`port: ${PORT}`) && patched.includes(TOKEN), 'DEFAULTS injection failed');
  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: 'chatsync.user.js' });
  void settings;
  void source;
}

/* ------------------------------------------------------------------ *
 * boot one userscript instance
 * ------------------------------------------------------------------ */

async function bootInstance(name, { blocks, settings } = {}) {
  const dom = makeDom({ blocks });
  const record = { requests: [], errors: [], styles: 0, menus: [], clipboard: null };
  const gm = makeGm(dom, record);
  const merged = Object.assign(
    {
      base: BASE,
      token: TOKEN,
      preview: true,
      autoSave: false,
      insertMode: 'replace',
      autoAttachOnEnter: false,
      autoSendAfterAttach: false,
      attachScope: 'activeFile',
      attachErrors: 'ifAny',
      errorLoop: 'off',
      autoApply: false,
      autoApplyPreview: 'auto',
      errorLoopRecheckMs: 200,
      errorLoopMaxChecks: 1,
      settleMs: 60,
      quickKeys: true,
    },
    settings || {},
  );
  const encoded = JSON.stringify(merged);
  // seed the settings store the script will read (GM storage + localStorage)
  const seedKey = 'chatsync.settings.v2';
  gm.GM_setValue(seedKey, encoded);
  dom.window.localStorage.setItem(`__chatsync_${seedKey}`, encoded);

  const sandbox = makeSandbox(dom, gm);
  runUserscript(sandbox);
  await waitUntil(() => /✅/.test(dom.text('.cs-status')), 8000, `${name} connects`);
  return { dom, record, sandbox, name };
}

/* ------------------------------------------------------------------ */

async function main() {
  const extBundlePath = await buildExtensionBundle(
    path.resolve(__dirname, 'smoke-entry.cjs'),
    path.resolve(__dirname, '.tmp/ui-extension-bundle.cjs'),
    path.resolve(__dirname, 'vscode-stub.js'),
  );
  const { vscode, ext } = require(extBundlePath);

  vscode.__state.root = ws;
  vscode.__state.config = {
    chatsync: {
      enabled: true,
      port: PORT,
      portFallbackRange: 0,
      host: '127.0.0.1',
      requireToken: true,
      token: TOKEN,
      allowedOrigins: ['https://chat.deepseek.com'],
      applyMode: 'diff',
      autoSave: false,
      previewTimeoutSeconds: 120,
      diagnosticsSettleMs: 300,
      diagnosticsMinWaitMs: 900,
      diagnosticsTimeoutMs: 4000,
      reportErrorDiff: true,
      errorFollowUpText: true,
      autoApplyMaxChars: 300,
      autoApplyUndoWindowMinutes: 10,
      rateLimitPerMinute: 5000,
      logRequests: Boolean(process.env.CHATSYNC_DEBUG),
      maxContextChars: 60000,
      maxFileSizeKB: 1024,
    },
  };
  await vscode.workspace.openTextDocument(appFile);
  vscode.__setActive(appFile, [new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0))]);
  vscode.__answerMessage(null); // never auto-click the VSCode notification

  const ctx = new vscode.ExtensionContext();
  await ext.activate(ctx);
  console.log(`\n\u001b[1mChatSync userscript test v0.2\u001b[0m — bridge ${BASE}, workspace ${ws}`);

  /* ================================================================ *
   * Instance 1 — manual flows, auto-attach, error loop
   * ================================================================ */

  const A = await bootInstance('A', {
    blocks: [
      { lang: 'typescript', code: 'export const FROM_AI = true;\nexport const extra = 2;\n', path: 'src/app.ts', caption: 'Sửa `src/app.ts`:' },
      { lang: 'python', code: 'print("hello")' },
    ],
    settings: { autoAttachOnEnter: true, autoSendAfterAttach: true, attachScope: 'auto', errorLoop: 'attach' },
  });
  const dom = A.dom;

  console.log('\n\u001b[1mBoot & panel\u001b[0m');

  await test('floating button, panel and CSS are injected', () => {
    assert.ok(dom.find('.cs-fab'));
    assert.ok(dom.find('.cs-panel'));
    assert.ok(A.record.styles > 0);
    assert.ok(dom.find('style').textContent.includes('.cs-block-tools'));
  });

  await test('status line shows port, workspace and the active feature flags', () => {
    const t = dom.text('.cs-status');
    assert.ok(t.includes(`:${PORT}`), t);
    assert.ok(t.includes(ws), t);
    assert.ok(t.includes('active: app.ts'), t);
    assert.ok(t.includes('errorLoop=attach'), t);
    assert.ok(t.includes('autoApply=tắt'), t);
  });

  await test('registers the new Tampermonkey menu commands', () => {
    const labels = A.record.menus.map((m) => m.label).join(', ');
    assert.ok(A.record.menus.length >= 8, `menus: ${labels}`);
    assert.ok(labels.includes('Toggle auto-apply'));
    assert.ok(labels.includes('Re-check errors of last apply'));
    assert.ok(labels.includes('Undo last apply'));
  });

  console.log('\n\u001b[1m(1) Auto-attach\u001b[0m');

  await test('plain Enter attaches the file the prompt names, then sends', async () => {
    dom.composer.value = 'sửa giúp src/app.ts hàm greet bị sai';
    dom.composer.dispatchEvent(new DomEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    await waitUntil(() => dom.sent.length === 1, 12000, 'message sent');
    const body = dom.sent[0];
    assert.ok(body.includes('sửa giúp src/app.ts'), 'original text kept');
    assert.ok(body.includes('## File: src/app.ts'), `attached the referenced file:\n${body}`);
    assert.ok(body.includes('```typescript'), 'fenced code');
    assert.ok(body.includes('export const BEFORE = true;'), 'file content included');
    assert.strictEqual(dom.composer.value, '', 'composer cleared by the send');
    const paths = A.record.requests.map((r) => r.path);
    assert.ok(paths.includes('/file'), 'probed the referenced path first');
  });

  await test('Enter does NOT re-attach when context is already in the prompt', async () => {
    const before = dom.sent.length;
    dom.composer.value = '## File: src/app.ts\n\n```ts\nx\n```\n\nthêm comment cho hàm này';
    dom.composer.dispatchEvent(new DomEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    await waitUntil(() => dom.sent.length === before + 1, 8000, 'message sent unchanged');
    const body = dom.sent[before];
    assert.strictEqual(body.indexOf('## File:'), 0, 'no second context block added');
    assert.ok(!body.includes('## Active file:'), body.slice(0, 120));
  });

  await test('Ctrl+Shift+Enter attaches + sends explicitly', async () => {
    const before = dom.sent.length;
    dom.composer.value = 'giải thích vòng lặp này';
    dom.composer.dispatchEvent(
      new DomEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true, shiftKey: true, code: 'Enter', keyCode: 13 }),
    );
    await waitUntil(() => dom.sent.length === before + 1, 12000, 'explicit send');
    assert.ok(dom.sent[before].includes('src/app.ts'), dom.sent[before].slice(0, 200));
  });

  await test('attachErrors=ifAny: no Problems section when the file is clean', async () => {
    vscode.__clearDiagnostics();
    dom.composer.value = '';
    dom.byLabel('Chỉ chèn ngữ cảnh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.length > 0, 8000, 'context inserted');
    assert.ok(!/## Problems/.test(dom.composer.value), dom.composer.value);
  });

  await test('attachErrors=ifAny: Problems appear once VSCode reports them', async () => {
    vscode.__setDiagnostics(appFile, [
      new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 4)), "'BEFORE' is unused ts(6133)", vscode.DiagnosticSeverity.Error),
    ]);
    dom.composer.value = '';
    dom.byLabel('Chỉ chèn ngữ cảnh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.includes("ts(6133)") || dom.composer.value.includes("'BEFORE' is unused"), 8000, 'diagnostics attached');
    assert.ok(/## Problems|Problems/.test(dom.composer.value), dom.composer.value.slice(0, 400));
    vscode.__clearDiagnostics();
  });

  console.log('\n\u001b[1m(3) Apply flows & chips\u001b[0m');

  await test('code blocks get chips, and a path-less block keeps Auto disabled', async () => {
    await waitUntil(() => dom.all('.cs-block-tools').length >= 2, 15000, 'both toolbars');
    const bars = dom.all('.cs-block-tools');
    assert.ok(bars.length >= 2);
    const first = bars[0].querySelectorAll('button').map((b) => b.textContent).join(',');
    const second = bars[1].querySelectorAll('button').map((b) => b.textContent).join(',');
    assert.ok(first.includes('Apply to VSCode'), first);
    assert.ok(first.includes('Auto → src/app.ts'), `path hint is surfaced: ${first}`);
    assert.ok(second.includes('🤖 Auto-apply'), second);
    const disabledAuto = bars[1].querySelectorAll('button').find((b) => b.textContent.includes('Auto-apply'));
    assert.strictEqual(disabledAuto.disabled, true, 'blocks without a path are not auto-appliable');
  });

  await test('quick Apply → diff preview → confirm from chat', async () => {
    const before = A.record.requests.filter((r) => r.path === '/apply').length;
    dom.chipIn('Apply to VSCode').chip.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => /Diff đang chờ xác nhận/.test(dom.toasts()), 12000, 'preview toast');
    assert.strictEqual(readApp(), APP_SOURCE, 'file untouched before confirm');

    const confirm = dom.all('.cs-toast button').find((b) => b.textContent.includes('Confirm từ đây'));
    confirm.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => readApp().includes('export const FROM_AI = true;'), 12000, 'file written');
    assert.ok(!readApp().includes('// src/app.ts'), 'path comment stripped');
    assert.ok(!readApp().includes('```'), 'fences stripped');
    assert.ok(A.record.requests.filter((r) => r.path === '/apply').length > before);
  });

  console.log('\n\u001b[1m(2) Error loop\u001b[0m');

  await test('apply that breaks the file posts the new problems back into the composer', async () => {
    dom.composer.value = '';
    // tsserver "notices" the new code 250ms after the write
    const err = new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(0, 13), new vscode.Position(0, 19)),
      "Type 'string' is not assignable to type 'number'. ts(2322)",
      vscode.DiagnosticSeverity.Error,
    );
    const r = await call('POST', '/apply', {
      body: { path: 'src/app.ts', mode: 'replace', content: 'export const n: number = "oops";\n', preview: false, settleMs: 60 },
    });
    assert.strictEqual(r.status, 200);
    // now push the same through the userscript so the follow-up path is exercised
    vscode.__scheduleDiagnostics(appFile, [err], 250);
    const beforeToast = dom.toasts();
    dom.chipIn('Apply to VSCode').chip.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.toasts() !== beforeToast && /Confirm từ đây/.test(dom.toasts()), 12000, 'fresh preview toast');
    const confirm = dom.all('.cs-toast button').filter((b) => b.textContent.includes('Confirm từ đây')).slice(-1)[0];
    confirm.dispatchEvent(new DomEvent('click', { bubbles: true }));

    await waitUntil(() => /lỗi mới/.test(dom.composer.value), 15000, 'follow-up attached to the composer');
    assert.ok(/ts\(2322\)|not assignable/.test(dom.composer.value), dom.composer.value.slice(-600));
    assert.ok(/src\/app\.ts:1/.test(dom.composer.value), 'points at the file and line');
    assert.ok(/Hãy sửa các lỗi trên/.test(dom.composer.value), 'asks for a fix');
    void err;
  });

  await test('the same error is never re-posted twice', async () => {
    const occurrences = (dom.composer.value.match(/lỗi mới/g) || []).length;
    dom.composer.value = '';
    await sleep(300);
    assert.ok(!/lỗi mới/.test(dom.composer.value), `deduped (was ${occurrences}×)`);
  });

  await test('🩺 Kiểm tra lỗi lại re-runs the diff against the last apply', async () => {
    dom.composer.value = '';
    vscode.__setDiagnostics(appFile, [
      new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 3)), 'late analyzer result ts(9001)', vscode.DiagnosticSeverity.Error),
    ]);
    dom.byLabel('Kiểm tra lỗi lại').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.includes('late analyzer result'), 15000, 'recheck follow-up');
    assert.ok(A.record.requests.some((r) => r.path === '/apply/errors'), 'called /apply/errors');
    vscode.__clearDiagnostics();
  });

  await test('⟲ Undo apply cuối restores the file', async () => {
    const before = readApp();
    dom.chipIn('Apply to VSCode').chip.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(
      () => B_or_A_confirm(),
      15000,
      'apply to finish',
    );
    async function B_or_A_confirm() {
      const c = dom.all('.cs-toast button').filter((b) => b.textContent.includes('Confirm từ đây')).slice(-1)[0];
      if (!c) return false;
      c.dispatchEvent(new DomEvent('click', { bubbles: true }));
      await waitUntil(() => readApp().includes('FROM_AI'), 15000, 'written');
      return true;
    }
    assert.ok(readApp().includes('FROM_AI'), 'precondition: auto/quick apply landed');
    dom.byLabel('Undo apply cuối').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => readApp() === before, 15000, 'file restored to its pre-apply content');
    assert.ok(/Undoed/.test(dom.toasts()), dom.toasts());
  });

  await test('⚙ Options modal: patch mode reveals the search field', async () => {
    dom.chipIn('Options').chip.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await sleep(150);
    const modal = dom.find('.cs-modal');
    assert.ok(modal, 'modal open');
    const search = modal.querySelectorAll('textarea').find((t) => (t.getAttribute('placeholder') || '').includes('cần tìm'));
    assert.strictEqual(search.style.display, 'none');
    const select = modal.querySelector('select');
    select.value = 'patch';
    select.dispatchEvent(new DomEvent('change', { bubbles: true }));
    assert.notStrictEqual(search.style.display, 'none', 'search field revealed');
    assert.ok(search.value.length > 0, 'prefilled with the first lines of the block');
    // three checkboxes now: preview / save / error-loop
    const checks = modal.querySelectorAll('input[type="checkbox"]');
    assert.strictEqual(checks.length, 3);
    modal.querySelectorAll('button').find((b) => b.textContent.includes('Huỷ')).dispatchEvent(new DomEvent('click', { bubbles: true }));
  });

  await test('⧉ Copy strips fences and the path comment', () => {
    dom.chipIn('Copy').chip.dispatchEvent(new DomEvent('click', { bubbles: true }));
    assert.ok(A.record.clipboard.includes('export const'));
    assert.ok(!A.record.clipboard.includes('```'));
    assert.ok(!A.record.clipboard.includes('// src/app.ts'));
  });

  console.log('\n\u001b[1mFailure handling\u001b[0m');

  await test('bad token → clear hint + settings opened', async () => {
    const tokenInput = dom.find('.cs-panel').querySelectorAll('input[type="text"]')[1];
    const good = tokenInput.value;
    tokenInput.value = 'CS-WRONG-0000';
    tokenInput.dispatchEvent(new DomEvent('change', { bubbles: true }));
    await sleep(150);
    dom.byLabel('Chỉ chèn ngữ cảnh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => /sai token/.test(dom.toasts()), 8000, '401 toast');
    assert.ok(dom.find('.cs-panel').matches('.cs-open'), 'panel opened to show settings');
    tokenInput.value = good;
    tokenInput.dispatchEvent(new DomEvent('change', { bubbles: true }));
    await waitUntil(() => /✅/.test(dom.text('.cs-status')), 8000, 'back online');
  });

  console.log('\n\u001b[1m(3) Auto-apply (second browser instance)\u001b[0m');

  const B = await bootInstance('B', {
    blocks: [
      { lang: 'typescript', code: 'export const AUTO_A = 1;\n', path: 'src/app.ts' },
      { lang: 'typescript', code: 'export const AUTO_B = 2;\n', path: 'src/win.ts' },
    ],
    settings: { autoApply: true, autoApplyPreview: 'auto', errorLoop: 'off', preview: false },
  });
  await vscode.workspace.openTextDocument(path.join(ws, 'src', 'win.ts'));

  await test('two small path-named blocks auto-apply as ONE batch when streaming ends', async () => {
    await waitUntil(() => readApp().includes('AUTO_A'), 25000, 'src/app.ts auto-written');
    assert.ok(fs.readFileSync(path.join(ws, 'src', 'win.ts'), 'utf8').includes('AUTO_B'), 'src/win.ts auto-written');
    const batches = B.record.requests.filter((r) => r.path === '/apply/batch');
    const singles = B.record.requests.filter((r) => r.path === '/apply');
    assert.ok(batches.length === 1, `expected exactly one batch call, got ${batches.length} (singles: ${singles.length})`);
    assert.strictEqual(singles.length, 0, 'must not be applied one-by-one');
    assert.ok(B.dom.toasts().includes('Batch'), B.dom.toasts());
    const chips = B.dom.all('.cs-block-tools').map((bar) => bar.textContent);
    assert.ok(chips.every((c) => c.includes('auto-applied')), chips.join(' / '));
  });

  await test('re-rendering the same answer does NOT apply it twice', async () => {
    const before = B.record.requests.filter((r) => r.path === '/apply/batch').length;
    // simulate the site re-rendering the identical blocks
    B.dom.addBlock({ lang: 'typescript', code: 'export const AUTO_A = 1;\n', path: 'src/auto/a.ts' });
    await sleep(3500);
    const after = B.record.requests.filter((r) => r.path === '/apply/batch').length;
    assert.strictEqual(after, before, `re-render caused another apply (${before} → ${after})`);
    assert.strictEqual(readApp().split('AUTO_A').length - 1, 1, 'content written once');
  });

  await test('batch undo restores every auto-applied file', async () => {
    assert.ok(readApp().includes('AUTO_A'), 'precondition');
    B.dom.byLabel('Undo apply cuối').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => readApp().includes('BEFORE'), 20000, 'app.ts restored');
    assert.strictEqual(readApp(), APP_SOURCE, 'exactly the pre-apply content');
    assert.ok(fs.readFileSync(path.join(ws, 'src', 'win.ts'), 'utf8').includes('WIN'), 'win.ts restored too');
  });

  await test('auto-apply of a brand-new file opens a diff instead of writing it', async () => {
    B.dom.addBlock({ lang: 'typescript', code: 'export const NEW_FILE = 1;\n', path: 'src/auto/fresh.ts' });
    await waitUntil(() => /Diff đang chờ xác nhận/.test(B.dom.toasts()), 25000, 'new file asked for confirmation');
    assert.ok(!fs.existsSync(path.join(ws, 'src', 'auto', 'fresh.ts')), 'nothing on disk without confirmation');
    const confirm = B.dom.all('.cs-toast button').filter((b) => b.textContent.includes('Confirm từ đây')).slice(-1)[0];
    confirm.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => fs.existsSync(path.join(ws, 'src', 'auto', 'fresh.ts')), 20000, 'created after confirm');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'auto', 'fresh.ts'), 'utf8'), 'export const NEW_FILE = 1;\n');
  });

  await test('a big block is NOT written silently: it opens a diff instead', async () => {
    const long = `export const BIG = [\n${Array.from({ length: 60 }, (_, i) => `  ${i},`).join('\n')}\n];\n`;
    assert.ok(long.length > 300, 'must exceed autoApplyMaxChars');
    B.dom.addBlock({ lang: 'typescript', code: long, path: 'src/win.ts' });
    const seen = B.dom.toasts();
    await waitUntil(() => /Diff đang chờ xác nhận/.test(B.dom.toasts().replace(seen, '')), 25000, 'big edit asked for confirmation');
    assert.ok(fs.readFileSync(path.join(ws, 'src', 'win.ts'), 'utf8').includes('WIN'), 'win.ts still holds the old content');
    const discard = B.dom.all('.cs-toast button').filter((b) => b.textContent.includes('Discard')).slice(-1)[0];
    discard.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await sleep(400);
    assert.ok(fs.readFileSync(path.join(ws, 'src', 'win.ts'), 'utf8').includes('WIN'), 'discarded for real');
  });

  console.log('\n\u001b[1mResilience\u001b[0m');

  await test('server offline → red FAB, no crash, plain chat still works', async () => {
    await ext.deactivate();
    dom.byLabel('Refresh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.find('.cs-fab').matches('.cs-err'), 12000, 'offline state');
    assert.ok(/Không kết nối được/.test(dom.text('.cs-status')));

    // Enter must fall through to the site when the bridge is down
    const before = dom.sent.length;
    dom.composer.value = 'câu hỏi bình thường';
    dom.composer.dispatchEvent(new DomEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    await waitUntil(() => dom.sent.length === before + 1, 8000, 'plain Enter still sends');
    assert.strictEqual(dom.sent[before], 'câu hỏi bình thường');
  });

  await test('Alt+Shift+V keeps working after the bridge comes back', async () => {
    await ext.activate(new vscode.ExtensionContext());
    await waitUntil(async () => {
      dom.byLabel('Refresh').dispatchEvent(new DomEvent('click', { bubbles: true }));
      await sleep(200);
      return /✅/.test(dom.text('.cs-status'));
    }, 15000, 'reconnected');
    dom.composer.value = '';
    dom.document.dispatchEvent(new DomEvent('keydown', { bubbles: true, altKey: true, shiftKey: true, key: 'V' }));
    await waitUntil(() => dom.composer.value.includes('src/app.ts'), 12000, 'shortcut attached context');
  });

  /* ---------------- summary ---------------- */

  console.log(`\n${failed === 0 ? '\u001b[42m\u001b[30m PASS \u001b[0m' : '\u001b[41m\u001b[30m FAIL \u001b[0m'} ${passed} passed, ${failed} failed`);
  if (process.env.CHATSYNC_DEBUG) {
    console.log('\n--- ChatSync server log ---');
    (vscode.__state.outputLines || []).slice(-60).forEach((l) => console.log('  ' + l));
    console.log('--- B requests ---');
    B.record.requests.slice(-25).forEach((r) => console.log(`  ${r.method} ${r.path}`));
    console.log('--- B toasts ---');
    console.log('  ' + B.dom.toasts().slice(0, 1500));
    console.log('--- B chips ---');
    B.dom.all('.cs-block-tools').forEach((b, i) => console.log(`  #${i}: ${b.textContent}`));
    console.log('--- win.ts / app.ts ---');
    console.log('  ' + JSON.stringify(fs.readFileSync(path.join(ws, 'src', 'win.ts'), 'utf8')));
    console.log('  ' + JSON.stringify(fs.readFileSync(path.join(ws, 'src', 'app.ts'), 'utf8')));
    console.log('--- A requests ---');
    A.record.requests.slice(-20).forEach((r) => console.log(`  ${r.method} ${r.path}`));
  }
  const transport = A.record.errors.concat(B.record.errors);
  if (transport.length) {
    console.log(`\ntransport errors (${transport.length}):`);
    transport.slice(0, 5).forEach((e) => console.log(`  - ${e}`));
  }
  if (failures.length) {
    console.log('');
    failures.forEach((f) => console.log(`— ${f.name}\n${f.error.stack || f.error}\n`));
  }
  fs.rmSync(ws, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

/* direct HTTP helper (uses the token) */
async function call(method, urlPath, { body, token } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-ChatSync-Token': token || TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text };
  }
  return { status: res.status, body: json, text };
}

main().catch((e) => {
  console.error('\nFatal:', e);
  process.exit(1);
});
