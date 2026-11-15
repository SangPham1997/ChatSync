/**
 * Userscript smoke test.
 *
 * Boots the REAL extension server (via the vscode stub) and then runs the REAL
 * userscript inside a fake DOM, talking to it over HTTP through a
 * GM_xmlhttpRequest shim. Verifies the whole bridge end to end:
 *
 *   fake browser  →  userscript  →  HTTP  →  extension server  →  files on disk
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
const waitUntil = async (fn, timeout = 6000, label = 'condition') => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) {
      return true;
    }
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${label}`);
};

/* ------------------------------------------------------------------ *
 * fixture workspace
 * ------------------------------------------------------------------ */

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsync-ui-'));
const appFile = path.join(ws, 'src', 'app.ts');
fs.mkdirSync(path.dirname(appFile), { recursive: true });
fs.writeFileSync(appFile, "export const BEFORE = true;\nexport const keep = 1;\n", 'utf8');
const readApp = () => fs.readFileSync(appFile, 'utf8');

/* ------------------------------------------------------------------ *
 * fake browser
 * ------------------------------------------------------------------ */

function buildDom() {
  const document = createDocument();
  const window = createWindow(document);

  // localStorage
  const store = new Map();
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  // the chat page: composer + an assistant message with two code blocks
  document.body.appendChild(document.createElement('div'));
  const composer = document.createElement('textarea');
  composer.setAttribute('data-id', 'root');
  composer.setAttribute('placeholder', 'Message ChatSync…');
  document.body.appendChild(composer);

  const message = document.createElement('div');
  message.className = 'ds-markdown message-content';
  document.body.appendChild(message);

  const mkBlock = (lang, code, caption) => {
    if (caption) {
      const p = document.createElement('p');
      p.textContent = caption;
      message.appendChild(p);
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.className = `language-${lang}`;
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrapper.appendChild(pre);
    message.appendChild(wrapper);
    return { wrapper, pre, codeEl };
  };

  const blockA = mkBlock('typescript', "```ts\n// src/app.ts\nexport const FROM_AI = true;\n```".replace(/^```ts\n|\n```$/g, ''), 'Update `src/app.ts`:');
  const blockB = mkBlock('python', 'print("hello")');

  return { window, document, composer, message, blocks: [blockA, blockB] };
}

/* ------------------------------------------------------------------ *
 * GM_* shims
 * ------------------------------------------------------------------ */

function buildGmApi(window, record) {
  const gmStore = new Map();
  return {
    GM_xmlhttpRequest(opts) {
      const headers = { ...(opts.headers || {}) };
      const init = { method: opts.method || 'GET', headers };
      if (opts.data !== undefined && opts.data !== null) {
        init.body = opts.data;
      }
      const timer = setTimeout(() => opts.ontimeout && opts.ontimeout({}), opts.timeout || 30000);
      fetch(opts.url, init)
        .then(async (r) => {
          clearTimeout(timer);
          const text = await r.text();
          record.requests.push({ method: opts.method, url: opts.url, status: r.status });
          opts.onload && opts.onload({ status: r.status, responseText: text, response: text, finalUrl: opts.url });
        })
        .catch((e) => {
          clearTimeout(timer);
          record.errors.push(String(e && e.message));
          opts.onerror && opts.onerror({ error: String(e && e.message) });
        });
    },
    GM_addStyle(css) {
      const style = window.document.createElement('style');
      style.textContent = css;
      window.document.head.appendChild(style);
      record.styles++;
      return style;
    },
    GM_getValue: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
    GM_setValue: (k, v) => gmStore.set(k, v),
    GM_setClipboard: (t) => (record.clipboard = t),
    GM_registerMenuCommand: (label, fn) => record.menus.push({ label, fn }),
    __gmStore: gmStore,
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  // ---- 1. real extension server on the stub host ----
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
      token: 'CS-TEST-TOKEN-1234',
      allowedOrigins: ['https://chat.deepseek.com'],
      applyMode: 'diff',
      autoSave: false,
      previewTimeoutSeconds: 120,
      rateLimitPerMinute: 5000,
      logRequests: false,
      maxContextChars: 60000,
      maxFileSizeKB: 1024,
    },
  };
  await vscode.workspace.openTextDocument(appFile);
  vscode.__setActive(appFile, [new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0))]);
  vscode.__setDiagnostics(appFile, [
    new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5)),
      "'keep' is declared but never used.",
      vscode.DiagnosticSeverity.Warning,
    ),
  ]);
  vscode.__answerMessage(null); // the human never clicks the VSCode notification in these tests

  const ctx = new vscode.ExtensionContext();
  await ext.activate(ctx);

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.ok(health.ok, 'server must be up');
  const TOKEN = health.token;

  // ---- 2. fake browser + userscript ----
  const dom = buildDom();
  const record = { requests: [], errors: [], styles: 0, menus: [], clipboard: null };
  const gm = buildGmApi(dom.window, record);

  const sandbox = {
    ...gm,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    localStorage: dom.window.localStorage,
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
    InputEvent: DomEvent,
    CustomEvent: DomEvent,
    MutationObserver: dom.window.MutationObserver,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    getSelection: dom.window.document.getSelection,
    // page-level dialogs the script may call
    prompt: (...a) => dom.window.prompt(...a),
    confirm: (...a) => dom.window.confirm(...a),
    alert: (...a) => dom.window.alert(...a),
    requestAnimationFrame: dom.window.requestAnimationFrame,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);

  const scriptPath = path.resolve(__dirname, '..', '..', 'userscript', 'chatsync.user.js');
  const source = fs
    .readFileSync(scriptPath, 'utf8')
    .replace(/(const DEFAULTS = \{ port: )\d+(, token: ')[^']*(' \};)/, `$1${PORT}$2${TOKEN}$3`);
  assert.ok(source.includes(`port: ${PORT}`) && source.includes(TOKEN), 'DEFAULTS injection failed');

  console.log(`\n\u001b[1mChatSync userscript test\u001b[0m — server ${BASE} (token ${TOKEN})`);

  vm.runInContext(source, sandbox, { filename: 'chatsync.user.js' });
  await sleep(150);

  const doc = dom.window.document;
  const fab = () => doc.querySelector('.cs-fab');
  const panel = () => doc.querySelector('.cs-panel');
  const statusBox = () => doc.querySelector('.cs-status');
  const toastText = () =>
    doc
      .querySelectorAll('.cs-toast')
      .map((t) => t.textContent)
      .join(' | ');
  const buttonByText = (root, label) =>
    root.querySelectorAll('button').find((b) => (b.textContent || '').includes(label));

  console.log('\n\u001b[1mBoot\u001b[0m');

  await test('injects the floating button, panel and styles', async () => {
    assert.ok(fab(), 'FAB injected');
    assert.ok(panel(), 'panel injected');
    assert.ok(record.styles > 0, 'CSS injected via GM_addStyle');
    assert.ok(doc.querySelector('style').textContent.includes('.cs-fab'));
  });

  await test('connects to the bridge and renders the health status', async () => {
    await waitUntil(() => /✅/.test(statusBox().textContent), 5000, 'online status');
    const text = statusBox().textContent;
    assert.ok(text.includes(`:${PORT}`), `status shows the port: ${text}`);
    assert.ok(text.includes('file active: app.ts'), `status shows the active file: ${text}`);
    assert.ok(fab().matches('.cs-on'), 'FAB marked online');
    assert.ok(record.requests.some((r) => r.url.endsWith('/health') && r.status === 200));
  });

  await test('registers Tampermonkey menu commands', () => {
    const labels = record.menus.map((m) => m.label).join(', ');
    assert.ok(record.menus.length >= 4, `expected menu commands, got: ${labels}`);
    assert.ok(labels.includes('Attach active file'));
  });

  console.log('\n\u001b[1mContext → chat\u001b[0m');

  await test('📎 Attach file writes the context into the composer', async () => {
    dom.composer.value = '';
    const btn = buttonByText(panel(), 'Attach file đang mở');
    assert.ok(btn, 'attach button exists');
    btn.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.length > 0, 5000, 'composer filled');
    const v = dom.composer.value;
    assert.ok(v.includes('## Active file: src/app.ts'), 'header present');
    assert.ok(v.includes('```typescript'), 'language fence present');
    assert.ok(v.includes('export const BEFORE = true;'), 'file content present');
    assert.ok(/context\/file/.test(record.requests.map((r) => r.url).join()), 'called /context/file');
  });

  await test('🐞 Attach Problems injects the diagnostics list', async () => {
    dom.composer.value = '';
    buttonByText(panel(), 'Attach Problems').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.includes('Problems in VSCode'), 5000, 'diagnostics injected');
    assert.ok(dom.composer.value.includes("'keep' is declared but never used."));
  });

  await test('📎 File + Problems includes both sections', async () => {
    dom.composer.value = '';
    buttonByText(panel(), 'File + Problems').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => dom.composer.value.includes('## Problems'), 5000, 'combined context');
    assert.ok(dom.composer.value.includes('## Active file: src/app.ts'));
  });

  console.log('\n\u001b[1mChat → VSCode\u001b[0m');

  await test('code blocks get a toolbar once the answer is stable', async () => {
    await waitUntil(() => doc.querySelectorAll('.cs-block-tools').length >= 1, 8000, 'toolbars injected');
    const bars = doc.querySelectorAll('.cs-block-tools');
    assert.ok(bars.length >= 1, `expected toolbars, found ${bars.length}`);
    const bar = bars[0];
    assert.ok(bar.textContent.includes('Apply to VSCode'));
    assert.ok(bar.textContent.includes('New file'));
    assert.ok(bar.textContent.includes('Copy'));
  });

  await test('⚡ quick Apply pushes the code block into the file (diff → confirm)', async () => {
    const bar = doc.querySelectorAll('.cs-block-tools')[0];
    const quick = bar.querySelectorAll('button').find((b) => b.textContent.includes('Apply to VSCode'));
    quick.dispatchEvent(new DomEvent('click', { bubbles: true }));

    // the extension opens a diff preview → the userscript offers confirm/discard in-chat
    await waitUntil(() => /Diff đang chờ xác nhận/.test(toastText()), 8000, 'preview toast');
    assert.strictEqual(readApp(), "export const BEFORE = true;\nexport const keep = 1;\n", 'file untouched before confirm');

    const confirmBtn = doc
      .querySelectorAll('.cs-toast button')
      .find((b) => b.textContent.includes('Confirm từ đây'));
    assert.ok(confirmBtn, 'confirm button rendered in chat');
    confirmBtn.dispatchEvent(new DomEvent('click', { bubbles: true }));

    await waitUntil(() => readApp().includes('export const FROM_AI = true;'), 8000, 'file written');
    assert.ok(!readApp().includes('```'), 'markdown fences stripped');
    assert.ok(!readApp().includes('// src/app.ts'), 'the `// path` hint line stripped');
    assert.ok(/Applied/.test(toastText()), `success toast shown: ${toastText()}`);
  });

  await test('⚙ Options opens the apply modal with path + mode prefilled', async () => {
    const bar = doc.querySelectorAll('.cs-block-tools')[1] || doc.querySelectorAll('.cs-block-tools')[0];
    const opt = bar.querySelectorAll('button').find((b) => b.textContent.includes('Options'));
    opt.dispatchEvent(new DomEvent('click', { bubbles: true }));
    await sleep(80);
    const modal = doc.querySelector('.cs-modal');
    assert.ok(modal, 'modal open');
    const inputs = modal.querySelectorAll('input[type="text"]');
    assert.ok(inputs.length >= 1);
    const select = modal.querySelector('select');
    assert.ok(select, 'mode select present');
    assert.ok(['replace', 'replaceSelection', 'insert', 'append', 'lines', 'newFile', 'patch'].includes(select.value));
    assert.ok(modal.textContent.includes('Apply → VSCode'));
    // patch-only fields stay hidden until mode=patch
    const searchField = modal.querySelectorAll('textarea').find((t) => (t.getAttribute('placeholder') || '').includes('cần tìm'));
    assert.strictEqual(searchField.style.display, 'none');
    select.value = 'patch';
    select.dispatchEvent(new DomEvent('change', { bubbles: true }));
    assert.notStrictEqual(searchField.style.display, 'none', 'search field revealed for patch mode');
    modal.querySelectorAll('button').find((b) => b.textContent.includes('Huỷ')).dispatchEvent(new DomEvent('click', { bubbles: true }));
    assert.ok(!doc.querySelector('.cs-modal'), 'modal closed');
  });

  await test('modal Apply with mode=lines edits exactly that range', async () => {
    // reset the fixture
    fs.writeFileSync(appFile, 'l1\nl2\nl3\nl4\n', 'utf8');
    await vscode.workspace.openTextDocument(appFile);
    vscode.__setActive(appFile);

    const bar = doc.querySelectorAll('.cs-block-tools')[0];
    bar.querySelectorAll('button').find((b) => b.textContent.includes('Options')).dispatchEvent(new DomEvent('click', { bubbles: true }));
    await sleep(60);
    const modal = doc.querySelector('.cs-modal');
    modal.querySelectorAll('input[type="text"]')[0].value = 'src/app.ts';
    const select = modal.querySelector('select');
    select.value = 'lines';
    select.dispatchEvent(new DomEvent('change', { bubbles: true }));
    const numbers = modal.querySelectorAll('input[type="number"]');
    numbers[0].value = '2';
    numbers[1].value = '3';
    const previewBox = modal.querySelectorAll('input[type="checkbox"]')[0];
    previewBox.checked = false; // write directly, no diff
    modal.querySelectorAll('button').find((b) => b.textContent === 'Apply').dispatchEvent(new DomEvent('click', { bubbles: true }));

    await waitUntil(() => readApp() === 'l1\nexport const FROM_AI = true;\nl4\n', 8000, 'lines applied');
  });

  await test('＋ New file creates a file in the workspace', async () => {
    const target = path.join(ws, 'src', 'generated', 'helper.ts');
    dom.window.prompt = () => 'src/generated/helper.ts';
    sandbox.prompt = dom.window.prompt;
    const bar = doc.querySelectorAll('.cs-block-tools')[0];
    bar.querySelectorAll('button').find((b) => b.textContent.includes('New file')).dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => fs.existsSync(target), 8000, 'new file created');
    assert.ok(fs.readFileSync(target, 'utf8').includes('export const FROM_AI = true;'));
  });

  await test('⧉ Copy puts the code on the clipboard (fences stripped)', () => {
    const bar = doc.querySelectorAll('.cs-block-tools')[0];
    bar.querySelectorAll('button').find((b) => b.textContent.includes('Copy')).dispatchEvent(new DomEvent('click', { bubbles: true }));
    assert.ok(record.clipboard && record.clipboard.includes('export const FROM_AI = true;'));
    assert.ok(!record.clipboard.includes('```'));
  });

  console.log('\n\u001b[1mFailure handling\u001b[0m');

  await test('wrong token surfaces a helpful error and opens Settings', async () => {
    const settingsInput = panel().querySelectorAll('input[type="text"]')[1];
    const good = settingsInput.value;
    settingsInput.value = 'CS-WRONG-0000-0000';
    settingsInput.dispatchEvent(new DomEvent('change', { bubbles: true }));
    await sleep(60);
    buttonByText(panel(), 'Attach file đang mở').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => /sai token/.test(toastText()), 6000, '401 toast');
    assert.ok(panel().matches('.cs-open'), 'panel opened');
    settingsInput.value = good;
    settingsInput.dispatchEvent(new DomEvent('change', { bubbles: true }));
    await sleep(60);
  });

  await test('server offline → red FAB and a clear message', async () => {
    await ext.deactivate();
    buttonByText(panel(), 'Refresh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => fab().matches('.cs-err'), 8000, 'offline state');
    assert.ok(/Không kết nối được/.test(statusBox().textContent), statusBox().textContent);
  });

  await test('keyboard shortcut Alt+Shift+V triggers attach', async () => {
    // restart the bridge first
    const r = await ext.activate(new vscode.ExtensionContext());
    void r;
    await waitUntil(
      () => fetch(`${BASE}/health`).then((x) => x.ok).catch(() => false),
      8000,
      'server back up',
    );
    dom.composer.value = '';
    buttonByText(panel(), 'Refresh').dispatchEvent(new DomEvent('click', { bubbles: true }));
    await waitUntil(() => fab().matches('.cs-on'), 8000, 'online again');
    doc.dispatchEvent(new DomEvent('keydown', { bubbles: true, altKey: true, shiftKey: true, key: 'V', preventDefault() {} }));
    await waitUntil(() => dom.composer.value.includes('## Active file'), 8000, 'shortcut injected context');
  });

  await ext.deactivate();

  console.log(
    `\n${failed === 0 ? '\u001b[42m\u001b[30m PASS \u001b[0m' : '\u001b[41m\u001b[30m FAIL \u001b[0m'} ${passed} passed, ${failed} failed`,
  );
  if (record.errors.length) {
    console.log(`\nGM_xmlhttpRequest transport errors: ${record.errors.length}`);
    record.errors.slice(0, 3).forEach((e) => console.log(`  - ${e}`));
  }
  if (failures.length) {
    console.log('');
    failures.forEach((f) => console.log(`— ${f.name}\n${f.error.stack || f.error}\n`));
  }
  fs.rmSync(ws, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFatal:', e);
  process.exit(1);
});
