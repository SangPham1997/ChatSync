import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSyncConfig, getConfig } from './config';
import { checkHost, checkOrigin, extractToken, RateLimiter, timingSafeEqualStr } from './security';
import { getToken, workspaceRoot } from './util';
import * as log from './logger';
import {
  handleContextErrors,
  handleContextFile,
  handleContextWorkspace,
  handleFileContent,
  handleTabs,
} from './context';
import {
  discardAllPending,
  handleApply,
  handleApplyBatch,
  handleApplyCancel,
  handleApplyConfirm,
  handleApplyList,
  handleRunCommand,
  handleTerminal,
  pendingCount,
} from './apply';

export interface ApiRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  route: string;
  body?: unknown;
  rawBody?: string;
  token?: string;
  origin?: string;
  startedAt: number;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (r: ApiRequest) => Promise<ApiResponse> | ApiResponse;

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

const HTML_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ChatSync</title>
<style>
 body{font:14px/1.6 -apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;background:#1e1e1e;color:#d4d4d4;margin:0;padding:32px}
 .card{max-width:820px;margin:0 auto;background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:24px}
 h1{font-size:20px;margin:0 0 4px} .muted{color:#9d9d9d}
 code,pre{background:#1b1b1b;border:1px solid #333;border-radius:4px;padding:2px 5px;font-family:ui-monospace,Menlo,Consolas,monospace}
 pre{padding:12px;overflow:auto} table{border-collapse:collapse;width:100%;margin:12px 0}
 td,th{border-bottom:1px solid #333;padding:6px 8px;text-align:left;font-weight:400} th{color:#9d9d9d}
 .ok{color:#4ec9b0} .warn{color:#dcdcaa}
 button{background:#0e639c;color:#fff;border:0;border-radius:4px;padding:6px 12px;cursor:pointer}
</style></head><body><div class="card">
<h1>ChatSync local bridge <span class="ok" id="dot">●</span></h1>
<p class="muted">Running inside VSCode. Listening on loopback only.</p>
<div id="info">loading…</div>
<h3>Endpoints</h3>
<table>
<tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
<tr><td>GET</td><td>/health</td><td>Liveness, port, version, auth requirements</td></tr>
<tr><td>GET</td><td>/context/file</td><td>Active editor: path, selections, content, <code>contextText</code></td></tr>
<tr><td>GET</td><td>/context/errors</td><td>Problems panel (diagnostics)</td></tr>
<tr><td>GET</td><td>/context/workspace</td><td>Workspace root + open documents</td></tr>
<tr><td>GET</td><td>/tabs</td><td>All open tabs</td></tr>
<tr><td>GET</td><td>/file?path=…</td><td>Read any workspace file</td></tr>
<tr><td>POST</td><td>/apply</td><td>Apply a code block (replace / patch / lines / newFile …)</td></tr>
<tr><td>POST</td><td>/apply/batch</td><td>Apply several edits at once</td></tr>
<tr><td>POST</td><td>/apply/confirm · /apply/cancel</td><td>Resolve a diff preview</td></tr>
<tr><td>GET</td><td>/userscript.js</td><td>The Tampermonkey script (installable)</td></tr>
</table>
<h3>Try it</h3>
<p><button onclick="t()">GET /health</button> <button onclick="t2()">GET /context/file</button></p>
<pre id="out"></pre>
<script>
 const token = new URLSearchParams(location.search).get('token') || '';
 const h = token ? { 'X-ChatSync-Token': token } : {};
 function show(o){ document.getElementById('out').textContent = JSON.stringify(o, null, 2); }
 async function t(){ try{ show(await (await fetch('/health')).json()); }catch(e){ show(String(e)); } }
 async function t2(){ try{ show(await (await fetch('/context/file', {headers:h})).json()); }catch(e){ show(String(e)); } }
 fetch('/health').then(r=>r.json()).then(j=>{
   document.getElementById('info').innerHTML =
     'port <code>'+j.port+'</code> · vscode <code>'+j.vscodeVersion+'</code> · token required: <b>'+(j.requireToken?'yes':'no')+'</b>'
     + '<br>workspace: <code>'+(j.workspace||'— none —')+'</code>'
     + '<br>token: <code>'+(j.token||'—')+'</code> <span class="muted">(paste it into the userscript settings)</span>';
 });
<\/script>
</div></body></html>`;

export class ChatSyncServer {
  private server?: http.Server;
  private limiter = new RateLimiter(getConfig().rateLimitPerMinute);
  private actualPort = 0;
  private actualHost = '127.0.0.1';
  private startedAt = Date.now();
  private requestCount = 0;

  get port(): number {
    return this.actualPort;
  }

  get host(): string {
    return this.actualHost;
  }

  get isRunning(): boolean {
    return this.server !== undefined;
  }

  get stats(): { uptimeSeconds: number; requests: number; pendingApplies: number } {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: this.requestCount,
      pendingApplies: pendingCount(),
    };
  }

  get token(): string {
    return getToken(getConfig().token);
  }

  async start(): Promise<{ ok: boolean; port?: number; error?: string }> {
    const cfg = getConfig();
    await this.stop();
    this.limiter.setLimit(cfg.rateLimitPerMinute);

    const attempts = Math.max(1, cfg.portFallbackRange + 1);
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      const port = cfg.port + i;
      try {
        await this.listen(cfg, port);
        this.actualPort = port;
        this.actualHost = cfg.host;
        this.startedAt = Date.now();
        log.log(`server listening on http://${cfg.host}:${port}`);
        if (i > 0) {
          log.warn(`port ${cfg.port} was busy → using ${port}`);
        }
        return { ok: true, port };
      } catch (e) {
        lastError = (e as Error).message;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') {
          break;
        }
        log.warn(`port ${port} unavailable (${code ?? lastError})`);
      }
    }
    log.error('failed to start server:', lastError);
    return { ok: false, error: lastError || 'unknown error' };
  }

  private listen(cfg: ChatSyncConfig, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.once('error', (err) => {
        server.removeAllListeners();
        reject(err);
      });
      server.listen(port, cfg.host, () => {
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    discardAllPending();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(() => resolve(), 500);
    });
    log.log('server stopped');
  }

  /* ---------------- request pipeline ---------------- */

  private setCors(req: http.IncomingMessage, res: http.ServerResponse, cfg: ChatSyncConfig, originOk: boolean, echo?: string): void {
    const origin = (req.headers.origin ?? '').toString();
    if (originOk && echo) {
      res.setHeader('Access-Control-Allow-Origin', echo);
      res.setHeader('Vary', 'Origin');
    } else if (originOk && !origin && cfg.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ChatSync-Token, X-ChatSync-Client, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome PNA
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...(headers ?? {}),
    });
    res.end(payload);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = getConfig();
    const startedAt = Date.now();
    this.requestCount++;
    this.limiter.setLimit(cfg.rateLimitPerMinute);

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    const origin = (req.headers.origin ?? '').toString();
    const verdict = checkOrigin(req, cfg);
    this.setCors(req, res, cfg, verdict.ok, verdict.echo);

    const finish = (status: number, body: unknown, headers?: Record<string, string>): void => {
      this.send(res, status, body, headers);
      if (cfg.logRequests) {
        log.log(
          `${method} ${route} → ${status} (${Date.now() - startedAt}ms)${origin ? ` origin=${origin}` : ''}`,
        );
      }
    };

    try {
      // 1. loopback Host check (DNS rebinding guard)
      if (!checkHost(req)) {
        finish(403, { ok: false, error: 'host header rejected (loopback only)' });
        return;
      }
      // 2. CORS preflight
      if (method === 'OPTIONS') {
        if (!verdict.ok) {
          finish(403, { ok: false, error: `CORS: ${verdict.reason}` });
          return;
        }
        res.writeHead(204);
        res.end();
        if (cfg.logRequests) {
          log.log(`OPTIONS ${route} → 204 (preflight)`);
        }
        return;
      }
      // 3. origin enforcement for real requests
      if (!verdict.ok) {
        finish(403, { ok: false, error: `CORS: ${verdict.reason}` });
        return;
      }
      // 4. rate limit
      const ip = req.socket.remoteAddress ?? '?';
      if (!this.limiter.allow(ip)) {
        finish(429, { ok: false, error: 'rate limit exceeded (chatsync.rateLimitPerMinute)' });
        return;
      }
      // 5. token
      const token = extractToken(req, url);
      const isPublic = route === '/health' || route === '/' || route === '/userscript.js' || route === '/favicon.ico';
      if (cfg.requireToken && !isPublic && !timingSafeEqualStr(token ?? '', this.token)) {
        finish(401, {
          ok: false,
          error: 'invalid or missing token',
          hint: 'Run "ChatSync: Show Connection Info" in VSCode and put the token in the userscript settings, or send header X-ChatSync-Token.',
        });
        return;
      }

      // 6. body
      const ctx: ApiRequest = { req, res, url, method, route, token, origin, startedAt };
      if (method === 'POST' || method === 'PUT') {
        const parsed = await readBody(req);
        if (parsed.error) {
          finish(parsed.status ?? 413, { ok: false, error: parsed.error });
          return;
        }
        ctx.rawBody = parsed.text;
        ctx.body = parsed.json;
      }

      const result = await this.dispatch(ctx, cfg);
      finish(result.status, result.body, result.headers);
    } catch (e) {
      log.error('unhandled error', (e as Error).stack ?? String(e));
      finish(500, { ok: false, error: (e as Error).message ?? 'internal error' });
    }
  }

  private async dispatch(ctx: ApiRequest, cfg: ChatSyncConfig): Promise<ApiResponse> {
    const { route, method } = ctx;

    if (route === '/' && method === 'GET') {
      return { status: 200, body: HTML_INDEX, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
    }
    if (route === '/favicon.ico') {
      return { status: 204, body: '' };
    }
    if (route === '/health') {
      return { status: 200, body: this.healthBody(cfg) };
    }
    if (route === '/userscript.js' && method === 'GET') {
      const script = readUserscriptFile();
      if (!script) {
        return { status: 404, body: { ok: false, error: 'userscript bundle not found next to the extension' } };
      }
      return {
        status: 200,
        body: script,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Disposition': 'inline; filename="chatsync.user.js"',
        },
      };
    }

    const routes: Record<string, Record<string, Handler>> = {
      GET: {
        '/context/file': handleContextFile,
        '/context/active': handleContextFile,
        '/context/errors': handleContextErrors,
        '/context/diagnostics': handleContextErrors,
        '/context/workspace': handleContextWorkspace,
        '/tabs': handleTabs,
        '/file': handleFileContent,
        '/apply/list': handleApplyList,
      },
      POST: {
        '/apply': handleApply,
        '/apply/batch': handleApplyBatch,
        '/apply/confirm': handleApplyConfirm,
        '/apply/cancel': handleApplyCancel,
        '/run': handleRunCommand,
        '/terminal': handleTerminal,
      },
    };

    const handler = routes[method]?.[route];
    if (!handler) {
      // Legacy alias from the original plan: POST /apply with a GET-style query is not supported.
      return {
        status: 404,
        body: {
          ok: false,
          error: `no route for ${method} ${route}`,
          available: Object.entries(routes).flatMap(([m, rs]) => Object.keys(rs).map((r) => `${m} ${r}`)),
        },
      };
    }
    return handler(ctx);
  }

  private healthBody(cfg: ChatSyncConfig): Record<string, unknown> {
    return {
      ok: true,
      service: 'chatsync',
      version: extensionVersion(),
      protocol: 1,
      host: this.actualHost,
      port: this.actualPort,
      requireToken: cfg.requireToken,
      token: cfg.requireToken ? this.token : undefined,
      tokenHint: cfg.requireToken ? 'also sent here so a freshly installed userscript can auto-configure on localhost' : undefined,
      applyMode: cfg.applyMode,
      autoSave: cfg.autoSave,
      allowRunCommand: cfg.allowRunCommand,
      allowTerminal: cfg.allowTerminal,
      vscodeVersion: vscode.version,
      workspace: workspaceRoot(),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      activeFile: vscode.window.activeTextEditor
        ? path.basename(vscode.window.activeTextEditor.document.fileName)
        : undefined,
      pendingApplies: pendingCount(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: this.requestCount,
      serverTime: new Date().toISOString(),
    };
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage): Promise<{ text?: string; json?: unknown; error?: string; status?: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) {
        return;
      }
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        // Resolve first so the 413 is flushed, then stop reading the socket.
        resolve({ error: `request body too large (> ${MAX_BODY_BYTES / 1024 / 1024}MB)`, status: 413 });
        req.pause();
        req.resume(); // drain and discard the rest
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) {
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({ text: '', json: {} });
        return;
      }
      const ctype = (req.headers['content-type'] ?? '').toString();
      if (ctype.includes('application/json') || !ctype) {
        try {
          resolve({ text, json: JSON.parse(text) });
        } catch {
          // Not JSON → treat as raw code body (text/plain or none)
          resolve({ text, json: undefined });
        }
      } else {
        resolve({ text, json: undefined });
      }
    });
    req.on('error', (e) => resolve({ error: e.message, status: 400 }));
  });
}

function extensionVersion(): string {
  try {
    // dist/extension.js → ../../package.json (bundled layout)
    const candidates = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', '..', 'package.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const pkg = JSON.parse(fs.readFileSync(c, 'utf8')) as { version?: string };
        if (pkg.version) {
          return pkg.version;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

function readUserscriptFile(): string | undefined {
  const candidates = [
    path.join(__dirname, '..', 'userscript', 'chatsync.user.js'),
    path.join(__dirname, '..', '..', 'userscript', 'chatsync.user.js'),
    path.join(__dirname, '..', '..', '..', 'userscript', 'chatsync.user.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return fs.readFileSync(c, 'utf8');
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export { readUserscriptFile, extensionVersion };
