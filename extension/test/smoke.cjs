/**
 * ChatSync smoke test — runs the real extension code (HTTP server, CORS gate,
 * token auth, context readers, apply pipeline) against an in-memory `vscode`
 * stub. No VSCode required.
 *
 *   npm run test:smoke
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { vscode, ext } = require('./.tmp/smoke-bundle.cjs');

const PORT = Number(process.env.CHATSYNC_TEST_PORT || 4871);
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

/* ---------------- HTTP helpers ---------------- */

async function call(method, urlPath, { token, body, headers = {}, raw = false, beforeResponse } = {}) {
  if (beforeResponse) {
    setTimeout(beforeResponse, 10);
  }
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(token ? { 'X-ChatSync-Token': token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return raw ? { status: res.status, headers: res.headers, text } : { status: res.status, headers: res.headers, body: json, text };
}

/** Like call() but lets us forge the Host header (undici forbids it via fetch). */
function rawRequest(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- fixture workspace ---------------- */

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsync-smoke-'));
const appFile = path.join(ws, 'src', 'app.ts');
fs.mkdirSync(path.dirname(appFile), { recursive: true });

const ORIGINAL = `export function greet(name: string): string {
  return 'hello ' + name;
}

export const VERSION = '1.0.0';
`;
fs.writeFileSync(appFile, ORIGINAL, 'utf8');

function readApp() {
  return fs.readFileSync(appFile, 'utf8');
}

async function main() {
  vscode.__state.root = ws;
  vscode.__state.config = {
    chatsync: {
      enabled: true,
      port: PORT,
      portFallbackRange: 0,
      host: '127.0.0.1',
      requireToken: true,
      token: '',
      allowedOrigins: ['https://chat.deepseek.com', 'http://localhost:*'],
      maxFileSizeKB: 1024,
      maxContextChars: 60000,
      applyMode: 'diff',
      autoSave: false,
      previewTimeoutSeconds: 60,
      allowRunCommand: false,
      allowTerminal: false,
      rateLimitPerMinute: 5000,
      logRequests: false,
      diagnosticsSettleMs: 60,
      diagnosticsMinWaitMs: 0,
      diagnosticsTimeoutMs: 1500,
      reportErrorDiff: true,
      errorFollowUpText: true,
      autoApplyMaxChars: 300,
      autoApplyUndoWindowMinutes: 10,
    },
  };

  // open the fixture file and make it the active editor, with a selection on line 5
  await vscode.workspace.openTextDocument(appFile);
  vscode.__setActive(appFile, [
    new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, "export const VERSION = '1.0.0';".length)),
  ]);
  vscode.__setDiagnostics(appFile, [
    new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(1, 9), new vscode.Position(1, 14)),
      "'name' is declared but its value is never read.",
      vscode.DiagnosticSeverity.Warning,
    ),
    new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
      "Cannot find module 'missing-dep'.",
      vscode.DiagnosticSeverity.Error,
    ),
  ]);

  const ctx = new vscode.ExtensionContext();
  await ext.activate(ctx);

  // grab the live server handle + token the same way the status bar does
  const serverDisp = ctx.subscriptions.find((s) => s && typeof s.dispose === 'function' && s !== ctx);
  void serverDisp;
  const statusLine = vscode.__state.outputLines.find((l) => /listening on/.test(l)) || '';
  console.log(`\n\u001b[1mChatSync smoke test\u001b[0m — workspace ${ws}\n  ${statusLine.trim()}`);

  const health0 = await call('GET', '/health');
  const TOKEN = health0.body.token;
  assert.ok(TOKEN, 'health should expose the token for localhost clients');

  console.log('\n\u001b[1mSecurity / CORS\u001b[0m');

  await test('GET /health is public and reports the server', async () => {
    const r = await call('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.port, PORT);
    assert.strictEqual(r.body.requireToken, true);
    assert.ok(r.body.version, 'version present');
    assert.strictEqual(r.body.workspace, ws);
    assert.strictEqual(r.body.activeFile, 'app.ts');
  });

  await test('protected route without token → 401', async () => {
    const r = await call('GET', '/context/file');
    assert.strictEqual(r.status, 401);
    assert.ok(/token/i.test(r.body.error));
  });

  await test('protected route with wrong token → 401', async () => {
    const r = await call('GET', '/context/file', { token: 'CS-WRONG-TOKEN-1234' });
    assert.strictEqual(r.status, 401);
  });

  await test('disallowed Origin → 403 (CORS)', async () => {
    const r = await call('GET', '/context/file', { token: TOKEN, headers: { Origin: 'https://evil.example.com' } });
    assert.strictEqual(r.status, 403);
    assert.ok(/CORS/.test(r.body.error));
  });

  await test('preflight from https://chat.deepseek.com → 204 + CORS headers', async () => {
    const res = await fetch(`${BASE}/apply`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chat.deepseek.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-chatsync-token',
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://chat.deepseek.com');
    assert.strictEqual(res.headers.get('access-control-allow-private-network'), 'true');
    assert.ok(/x-chatsync-token/i.test(res.headers.get('access-control-allow-headers') || ''));
    assert.strictEqual(res.headers.get('vary'), 'Origin');
  });

  await test('allowed wildcard origin http://localhost:5173 → echoed', async () => {
    const r = await call('GET', '/health', { headers: { Origin: 'http://localhost:5173' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  await test('non-loopback Host header → 403 (DNS-rebinding guard)', async () => {
    const r = await rawRequest('GET', '/health', { Host: 'attacker.example.com' });
    assert.strictEqual(r.status, 403);
    assert.ok(/host header/i.test(JSON.parse(r.text).error));
  });

  await test('unknown route → 404 with the route list', async () => {
    const r = await call('GET', '/nope', { token: TOKEN });
    assert.strictEqual(r.status, 404);
    assert.ok(Array.isArray(r.body.available) && r.body.available.includes('POST /apply'));
  });

  await test('gated /run endpoint → 403 while allowRunCommand=false', async () => {
    const r = await call('POST', '/run', { token: TOKEN, body: { command: 'workbench.action.reloadWindow' } });
    assert.strictEqual(r.status, 403);
  });

  console.log('\n\u001b[1mContext\u001b[0m');

  await test('GET /context/file returns file + selection + contextText', async () => {
    const r = await call('GET', '/context/file?diagnostics=1', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.hasEditor, true);
    assert.strictEqual(r.body.relPath, 'src/app.ts');
    assert.strictEqual(r.body.languageId, 'typescript');
    assert.strictEqual(r.body.lineCount, 6);
    assert.strictEqual(r.body.hasSelection, true);
    assert.strictEqual(r.body.selections[0].startLine, 5);
    assert.ok(r.body.content.includes("VERSION = '1.0.0'"));
    assert.ok(r.body.contextText.includes('## Active file: src/app.ts'));
    assert.ok(r.body.contextText.includes('```typescript'));
    assert.strictEqual(r.body.diagnostics.length, 2, 'minSeverity=Warning keeps warnings AND errors for the active file');
    assert.deepStrictEqual(r.body.diagnostics.map((d) => d.severity).sort(), ['Error', 'Warning']);
    assert.ok(r.body.contextText.includes('## Problems (diagnostics)'));
  });

  await test('GET /context/errors returns workspace problems as text', async () => {
    const r = await call('GET', '/context/errors?minSeverity=Error', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, 1);
    assert.strictEqual(r.body.diagnostics[0].severity, 'Error');
    assert.strictEqual(r.body.diagnostics[0].line, 1);
    assert.ok(r.body.text.includes("Cannot find module 'missing-dep'"));
  });

  await test('GET /context/workspace + /tabs list the open document', async () => {
    const w = await call('GET', '/context/workspace', { token: TOKEN });
    assert.strictEqual(w.status, 200);
    assert.strictEqual(w.body.root, ws);
    assert.ok(w.body.openDocuments.some((d) => d.path === 'src/app.ts'));
  });

  await test('GET /file?path= reads by relative path', async () => {
    const r = await call('GET', '/file?path=src/app.ts', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.languageId, 'typescript');
    assert.ok(r.body.content.startsWith('export function greet'));
  });

  await test('GET /file?path= cannot escape the workspace → 403', async () => {
    const r = await call('GET', `/file?path=${encodeURIComponent('../../etc/passwd')}`, { token: TOKEN });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.ok, false);
    assert.ok(/outside the workspace/.test(r.body.error));
  });

  await test('GET /file?path= cannot read an absolute path outside → 403', async () => {
    const r = await call('GET', `/file?path=${encodeURIComponent(os.homedir() + '/.bashrc')}`, { token: TOKEN });
    assert.strictEqual(r.status, 403);
  });

  console.log('\n\u001b[1mApply\u001b[0m');

  await test('POST /apply mode=replace writes the file (direct)', async () => {
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'export const A = 1;\nexport const B = 2;\nexport const C = 3;\n' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.applied, true);
    assert.strictEqual(r.body.mode, 'replace');
    assert.ok(r.body.backup && fs.existsSync(r.body.backup), 'a backup file must exist');
    assert.strictEqual(readApp(), 'export const A = 1;\nexport const B = 2;\nexport const C = 3;\n');
  });

  await test('markdown fences + `// path/to/file` header are stripped', async () => {
    const payload = '```ts\n// src/app.ts\nexport const FROM_FENCE = true;\n```';
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { mode: 'replace', preview: false, content: payload },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.path, 'src/app.ts', 'path picked up from the fence/comment or the active editor');
    assert.ok(readApp().includes('export const FROM_FENCE = true;'));
    assert.ok(!readApp().includes('```'), 'fences must not leak into the file');
  });

  await test('POST /apply mode=patch (unique search) replaces exactly one spot', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'const a = 1;\nconst b = 2;\nconst c = 3;\n' } });
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/app.ts', mode: 'patch', preview: false, search: 'const b = 2;', replace: 'const b = 22;' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.applied, true);
    const text = readApp();
    assert.ok(text.includes('const b = 22;'));
    assert.ok(text.includes('const a = 1;') && text.includes('const c = 3;'));
  });

  await test('ambiguous patch → 409 with occurrence count', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'x\nx\nx\n' } });
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'patch', preview: false, search: 'x', replace: 'y' } });
    assert.strictEqual(r.status, 409);
    assert.ok(/matches 3 times/.test(r.body.error), r.body.error);
  });

  await test('missing patch target → 409', async () => {
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'patch', preview: false, search: 'definitely not here', replace: 'y' } });
    assert.strictEqual(r.status, 409);
    assert.ok(/not found/.test(r.body.error));
  });

  await test('patch whitespace-insensitive fallback matches reformatted code', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'function f() {\n    return 1;\n}\n' } });
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/app.ts', mode: 'patch', preview: false, search: 'function f() {\nreturn 1;\n}', replace: 'function f() {\n  return 2;\n}' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(readApp().includes('return 2;'));
  });

  await test('mode=lines replaces an inclusive 1-based range', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'l1\nl2\nl3\nl4\n' } });
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'lines', line: 2, endLine: 3, preview: false, content: 'L2-L3 replaced' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(readApp(), 'l1\nL2-L3 replaced\nl4\n');
  });

  await test('mode=append adds to the end', async () => {
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'append', preview: false, content: '// appended' } });
    assert.strictEqual(r.status, 200);
    assert.ok(readApp().endsWith('// appended\n') || readApp().endsWith('// appended'));
  });

  await test('mode=replaceSelection edits the current selection only', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'keep me\nreplace me\nkeep me too\n' } });
    vscode.__setActive(appFile, [new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 'replace me'.length))]);
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replaceSelection', preview: false, content: 'REPLACED' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(readApp(), 'keep me\nREPLACED\nkeep me too\n');
  });

  await test('mode=newFile + preview:false creates the file inside the workspace', async () => {
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/generated/util.ts', mode: 'newFile', preview: false, content: 'export const ok = true;\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.mode, 'newFile');
    assert.ok(fs.existsSync(path.join(ws, 'src', 'generated', 'util.ts')));
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'generated', 'util.ts'), 'utf8'), 'export const ok = true;\n');
  });

  await test('refuses to create/write files outside the workspace root → 403', async () => {
    const evil = path.join(os.tmpdir(), 'chatsync-evil.ts');
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: evil, mode: 'newFile', content: 'x' } });
    assert.strictEqual(r.status, 403);
    assert.ok(/outside the workspace/.test(r.body.error));
    assert.ok(!fs.existsSync(evil), 'nothing may be written outside the workspace');
  });

  await test('diff preview → confirm writes the change', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'before preview\n' } });
    vscode.__answerMessage(null); // the human has not clicked anything in VSCode yet
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: true, content: 'after preview\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.preview, true);
    assert.ok(r.body.applyId, 'applyId returned');
    assert.strictEqual(readApp(), 'before preview\n', 'file must NOT change before confirmation');
    assert.ok(vscode.__state.executedCommands.some((c) => c.command === 'vscode.diff'), 'vscode.diff was invoked');

    const list = await call('GET', '/apply/list', { token: TOKEN });
    assert.ok(list.body.pending.some((p) => p.applyId === r.body.applyId));

    // user clicks Apply in the chat UI
    const c = await call('POST', '/apply/confirm', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.applied, true);
    assert.strictEqual(readApp(), 'after preview\n');

    const after = await call('POST', '/apply/confirm', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(after.status, 404, 'applyId is single-use');
  });

  await test('diff preview → cancel leaves the file untouched', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'untouched\n' } });
    vscode.__answerMessage(null);
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: true, content: 'SHOULD NOT LAND\n' } });
    assert.ok(r.body.applyId);
    const c = await call('POST', '/apply/cancel', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.cancelled, true);
    assert.strictEqual(readApp(), 'untouched\n');
  });

  await test('diff preview → clicking Apply inside VSCode also commits', async () => {
    vscode.__answerMessage('Apply'); // simulate the notification button
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: true, content: 'from the editor button\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(readApp(), 'from the editor button\n');
    const late = await call('GET', '/apply/list', { token: TOKEN });
    assert.strictEqual(late.body.count, 0, 'the pending entry is consumed');
    vscode.__answerMessage(null);
  });

  await test('no-op apply reports applied=false', async () => {
    await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'same content\n' } });
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'same content\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.applied, false);
    assert.ok(/no change/.test(r.body.message));
    assert.strictEqual(readApp(), 'same content\n');
  });

  await test('CRLF documents keep their line endings', async () => {
    const crlf = path.join(ws, 'src', 'win.ts');
    fs.writeFileSync(crlf, 'a\r\nb\r\nc\r\n', 'utf8');
    await vscode.workspace.openTextDocument(crlf);
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/win.ts', mode: 'append', preview: false, content: 'd\ne\n' } });
    assert.strictEqual(r.status, 200);
    const raw = fs.readFileSync(crlf);
    assert.ok(raw.includes(Buffer.from('\r\n')), 'CRLF preserved');
    assert.strictEqual(raw.toString('utf8'), 'a\r\nb\r\nc\r\nd\r\ne\r\n');
  });

  await test('POST /apply/batch applies several edits', async () => {
    const r = await call('POST', '/apply/batch', {
      token: TOKEN,
      body: {
        applies: [
          { path: 'src/app.ts', mode: 'replace', preview: false, content: 'batch line 1\n' },
          { path: 'src/generated/batch.md', mode: 'newFile', preview: false, content: '# batch\n' },
        ],
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual(r.body.failed, 0);
    assert.strictEqual(readApp(), 'batch line 1\n');
    assert.ok(fs.existsSync(path.join(ws, 'src', 'generated', 'batch.md')));
  });

  await test('apply to a non-existent path reports a resolution error', async () => {
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'does/not/exist-anywhere.ts', mode: 'replace', preview: false, content: 'x' } });
    assert.ok([200, 400].includes(r.status));
    if (r.status === 200) {
      assert.strictEqual(r.body.mode, 'newFile', 'unresolvable path inside the workspace becomes newFile');
    }
  });

  await test('oversized body → 413', async () => {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: huge } });
    assert.strictEqual(r.status, 413);
  });

  console.log('\n\u001b[1mError loop (feature 2)\u001b[0m');

  await test('apply reports problems the language server raises AFTER the write', async () => {
    vscode.__clearDiagnostics();
    const file = path.join(ws, 'src', 'analysed.ts');
    fs.writeFileSync(file, 'const a = 1;\n', 'utf8');
    await vscode.workspace.openTextDocument(file);
    const abs = file;

    // simulate tsserver: ~80ms after the edit it finds a brand-new error
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/analysed.ts', mode: 'replace', preview: false, content: 'const a: number = "nope";\n' },
      beforeResponse: () => {
        vscode.__scheduleDiagnostics(
          abs,
          [new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 6), new vscode.Position(0, 12)), "Type 'string' is not assignable to type 'number'.ts(2322)", vscode.DiagnosticSeverity.Error)],
          80,
        );
      },
    });
    assert.strictEqual(r.status, 200);
    const diff = r.body.diagnosticsDiff;
    assert.ok(diff, 'apply must return a diagnosticsDiff');
    assert.strictEqual(diff.errorCountBefore, 0, 'baseline had no errors');
    assert.strictEqual(diff.newErrors.length, 1, `expected 1 new error, got ${JSON.stringify(diff.newErrors)}`);
    assert.strictEqual(diff.after[0].file, 'src/analysed.ts');
    assert.ok(diff.followUpText.includes("Type 'string' is not assignable"), diff.followUpText);
    assert.ok(diff.followUpText.includes('src/analysed.ts:1'));
    assert.strictEqual(diff.followUpRecommended, true);
    assert.ok(diff.settled, 'should have waited for the analyser to stop changing');
    assert.ok(diff.waitedMs >= 60, `waited ${diff.waitedMs}ms`);
    assert.ok(/1 lỗi mới/.test(r.body.message), r.body.message);
  });

  await test('a clean apply produces no follow-up text', async () => {
    vscode.__clearDiagnostics();
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/analysed.ts', mode: 'replace', preview: false, content: 'const a: number = 1;\n' },
    });
    assert.strictEqual(r.status, 200);
    const diff = r.body.diagnosticsDiff;
    assert.strictEqual(diff.newErrors.length, 0);
    assert.strictEqual(diff.followUpText, '');
    assert.strictEqual(diff.followUpRecommended, false);
  });

  await test('an apply that FIXES errors is reported as fixedErrors', async () => {
    const abs = path.join(ws, 'src', 'analysed.ts');
    vscode.__setDiagnostics(abs, [
      new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5)), 'Broken thing ts(2322)', vscode.DiagnosticSeverity.Error),
    ]);
    const r = await call('POST', '/apply', {
      token: TOKEN,
      body: { path: 'src/analysed.ts', mode: 'replace', preview: false, content: 'fixed\n' },
      beforeResponse: () => vscode.__scheduleDiagnostics(abs, [], 60),
    });
    const diff = r.body.diagnosticsDiff;
    assert.strictEqual(diff.fixedErrors.length, 1, JSON.stringify(diff));
    assert.strictEqual(diff.newErrors.length, 0);
    assert.ok(/lỗi cũ đã biến mất/.test(diff.followUpText), diff.followUpText);
  });

  await test('GET /apply/errors re-runs the diff later (slow analyser)', async () => {
    const abs = path.join(ws, 'src', 'late.ts');
    fs.writeFileSync(abs, 'x\n', 'utf8');
    vscode.__clearDiagnostics();
    const a = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/late.ts', mode: 'replace', preview: false, content: 'y\n' } });
    assert.strictEqual(a.body.diagnosticsDiff.newErrors.length, 0, 'nothing wrong yet');
    const applyId = a.body.applyId;
    assert.ok(applyId);

    // the analyser only wakes up when the chat asks again
    vscode.__setDiagnostics(abs, [
      new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)), 'late breaking change ts(9001)', vscode.DiagnosticSeverity.Error),
    ]);
    const r = await call('GET', `/apply/errors?applyId=${encodeURIComponent(applyId)}`, { token: TOKEN });
    assert.strictEqual(r.status, 200);
    const diff = r.body.diagnosticsDiff;
    assert.strictEqual(diff.newErrors.length, 1, JSON.stringify(diff));
    assert.ok(diff.followUpText.includes('late breaking change'));

    const cached = await call('GET', `/apply/errors?applyId=${encodeURIComponent(applyId)}&wait=0`, { token: TOKEN });
    assert.strictEqual(cached.body.cached, true);
    assert.strictEqual(cached.body.diagnosticsDiff.newErrors.length, 1);

    const missing = await call('GET', '/apply/errors?applyId=ap_nope', { token: TOKEN });
    assert.strictEqual(missing.status, 404);
  });

  await test('diagnostics=false skips the settle wait entirely', async () => {
    const started = Date.now();
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/analysed.ts', mode: 'replace', preview: false, diagnostics: false, content: 'fast\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.diagnosticsDiff, undefined);
    assert.ok(Date.now() - started < 500, 'should not have waited for diagnostics');
  });

  console.log('\n\u001b[1mUndo + history (safety net for auto-apply)\u001b[0m');

  await test('POST /apply/undo restores the previous content', async () => {
    fs.writeFileSync(appFile, 'BEFORE TEXT\n', 'utf8');
    await vscode.workspace.openTextDocument(appFile);
    const a = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'AFTER TEXT\n' } });
    assert.strictEqual(readApp(), 'AFTER TEXT\n');
    const u = await call('POST', '/apply/undo', { token: TOKEN, body: { applyId: a.body.applyId } });
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.undone, true);
    assert.strictEqual(readApp(), 'BEFORE TEXT\n');

    const again = await call('POST', '/apply/undo', { token: TOKEN, body: { applyId: a.body.applyId } });
    assert.strictEqual(again.status, 404, 'an undone apply cannot be undone twice');
  });

  await test('undoing a newFile apply deletes the created file', async () => {
    const target = path.join(ws, 'src', 'scratch.ts');
    const a = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/scratch.ts', mode: 'newFile', preview: false, content: 'export const tmp = 1;\n' } });
    assert.strictEqual(a.status, 200);
    assert.ok(fs.existsSync(target));
    const u = await call('POST', '/apply/undo', { token: TOKEN, body: { applyId: a.body.applyId } });
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.deleted, true, JSON.stringify(u.body));
    assert.ok(!fs.existsSync(target), 'file must be gone');
  });

  await test('GET /apply/history lists recent applies', async () => {
    const r = await call('GET', '/apply/history', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.count > 0);
    const first = r.body.applies[0];
    assert.ok(first.applyId && first.path && first.mode);
    assert.strictEqual(typeof first.undoable, 'boolean');
    assert.ok(!Number.isNaN(Date.parse(first.appliedAt)));
  });

  await test('undo window of 0 minutes disables undo → 410', async () => {
    const before = vscode.__state.config.chatsync.autoApplyUndoWindowMinutes;
    vscode.__state.config.chatsync.autoApplyUndoWindowMinutes = 0;
    try {
      const a = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: false, content: 'no undo\n' } });
      assert.ok(a.body.applyId, 'still reported');
      const u = await call('POST', '/apply/undo', { token: TOKEN, body: { applyId: a.body.applyId } });
      assert.strictEqual(u.status, 410);
      assert.ok(/undo window closed/.test(u.body.error), JSON.stringify(u.body));
      assert.strictEqual(readApp(), 'no undo\n', 'file keeps the applied content');
    } finally {
      vscode.__state.config.chatsync.autoApplyUndoWindowMinutes = before;
    }
  });

  console.log('\n\u001b[1mAuto-apply policy (feature 3)\u001b[0m');

  await test('preview:"auto" writes small edits directly', async () => {
    fs.writeFileSync(appFile, 'tiny\n', 'utf8');
    await vscode.workspace.openTextDocument(appFile);
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: 'auto', content: 'small edit\n' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.applied, true, 'auto + small → direct write');
    assert.strictEqual(r.body.preview, undefined);
    assert.strictEqual(readApp(), 'small edit\n');
  });

  await test('preview:"auto" opens a diff when the edit is larger than autoApplyMaxChars', async () => {
    const big = `export const data = [${Array.from({ length: 120 }, (_, i) => i).join(',')}];\n`;
    assert.ok(big.length > 300, 'fixture must exceed the configured limit');
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/app.ts', mode: 'replace', preview: 'auto', content: big } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.preview, true, 'auto + big edit → diff preview');
    assert.ok(r.body.applyId);
    assert.notStrictEqual(readApp(), big, 'file untouched until confirmed');
    const c = await call('POST', '/apply/confirm', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(c.body.applied, true);
    assert.strictEqual(readApp(), big);
  });

  await test('preview:"auto" still shows a diff for a brand-new file (then undo deletes it)', async () => {
    const p2 = 'src/auto/new-one.ts';
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: p2, mode: 'newFile', preview: 'auto', content: 'export const n = 1;\n' } });
    assert.strictEqual(r.body.preview, true, 'new files are always reviewed in auto mode');
    assert.strictEqual(r.body.applied, false);
    assert.ok(!fs.existsSync(path.join(ws, p2)), 'not on disk before confirm');
    const c = await call('POST', '/apply/confirm', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.applied, true);
    assert.strictEqual(c.body.mode, 'newFile');
    assert.strictEqual(fs.readFileSync(path.join(ws, p2), 'utf8'), 'export const n = 1;\n');
    const u = await call('POST', '/apply/undo', { token: TOKEN, body: { applyId: c.body.applyId } });
    assert.strictEqual(u.body.deleted, true);
    assert.ok(!fs.existsSync(path.join(ws, p2)), 'undo removes the file it created');
  });

  await test('default applyMode=diff previews new files too', async () => {
    const r = await call('POST', '/apply', { token: TOKEN, body: { path: 'src/auto/default.ts', mode: 'newFile', content: 'x\n' } });
    assert.strictEqual(r.body.preview, true);
    const cancel = await call('POST', '/apply/cancel', { token: TOKEN, body: { applyId: r.body.applyId } });
    assert.strictEqual(cancel.body.cancelled, true);
    assert.ok(!fs.existsSync(path.join(ws, 'src', 'auto', 'default.ts')));
  });

  await test('batch apply returns a shared batchId usable for one-click undo', async () => {
    fs.writeFileSync(path.join(ws, 'src', 'b1.ts'), 'old1\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'src', 'b2.ts'), 'old2\n', 'utf8');
    await vscode.workspace.openTextDocument(path.join(ws, 'src', 'b1.ts'));
    await vscode.workspace.openTextDocument(path.join(ws, 'src', 'b2.ts'));
    const r = await call('POST', '/apply/batch', {
      token: TOKEN,
      body: {
        applies: [
          { path: 'src/b1.ts', mode: 'replace', preview: false, content: 'new1\n' },
          { path: 'src/b2.ts', mode: 'replace', preview: false, content: 'new2\n' },
        ],
      },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.batchId, 'batchId present');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'b1.ts'), 'utf8'), 'new1\n');
    const u = await call('POST', '/apply/undo', { token: TOKEN, body: { batchId: r.body.batchId } });
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.undoneCount, 2, JSON.stringify(u.body));
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'b1.ts'), 'utf8'), 'old1\n');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'b2.ts'), 'utf8'), 'old2\n');
  });

  await test('batch aggregates the error diff of every touched file', async () => {
    const f1 = path.join(ws, 'src', 'b1.ts');
    const f2 = path.join(ws, 'src', 'b2.ts');
    vscode.__clearDiagnostics();
    const r = await call('POST', '/apply/batch', {
      token: TOKEN,
      body: {
        applies: [
          { path: 'src/b1.ts', mode: 'replace', preview: false, content: 'a\n' },
          { path: 'src/b2.ts', mode: 'replace', preview: false, content: 'b\n' },
        ],
      },
      beforeResponse: () => {
        // must land after both per-item baselines are taken, while the aggregate is still settling
        vscode.__scheduleDiagnostics(f2, [new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)), 'boom in b2 ts(1234)', vscode.DiagnosticSeverity.Error)], 220);
      },
    });
    const diff = r.body.diagnosticsDiff;
    assert.ok(diff, 'batch must carry a diagnosticsDiff');
    assert.strictEqual(diff.newErrors.length, 1);
    assert.strictEqual(diff.newErrors[0].file, 'src/b2.ts');
    assert.ok(diff.followUpText.includes('src/b2.ts'));
    assert.ok(diff.targetPaths.length >= 2);
  });

  console.log('\n\u001b[1mDistribution\u001b[0m');

  await test('GET /userscript.js serves an installable Tampermonkey script', async () => {
    const r = await call('GET', '/userscript.js', { raw: true });
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.startsWith('// ==UserScript=='), 'starts with the metadata block');
    assert.ok(/@match\s+https:\/\/chat\.deepseek\.com\/\*/.test(r.text));
    assert.ok(/GM_xmlhttpRequest/.test(r.text));
    assert.ok(/@connect\s+127\.0\.0\.1/.test(r.text));
    assert.ok(r.text.includes('/apply'), 'script calls the apply endpoint');
  });

  await test('GET / serves the API dashboard HTML', async () => {
    const r = await call('GET', '/', { raw: true });
    assert.strictEqual(r.status, 200);
    assert.ok(/ChatSync local bridge/.test(r.text));
    assert.ok(/\/context\/file/.test(r.text));
  });

  await ext.deactivate();

  await test('server stops cleanly on deactivate', async () => {
    let refused = false;
    try {
      await fetch(`${BASE}/health`);
    } catch {
      refused = true;
    }
    assert.ok(refused, 'port should be closed after deactivate');
  });

  /* ---------------- summary ---------------- */

  console.log(`\n${failed === 0 ? '\u001b[42m\u001b[30m PASS \u001b[0m' : '\u001b[41m\u001b[30m FAIL \u001b[0m'} ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('');
    for (const f of failures) {
      console.log(`— ${f.name}\n${f.error.stack || f.error}\n`);
    }
  }
  fs.rmSync(ws, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFatal:', e);
  process.exit(1);
});
