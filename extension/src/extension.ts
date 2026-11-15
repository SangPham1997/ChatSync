import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatSyncServer, readUserscriptFile } from './server';
import { getConfig } from './config';
import { getToken, relToWorkspace, workspaceRoot } from './util';
import * as log from './logger';

let server: ChatSyncServer | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel;

const BASE_URL = (): string => `http://127.0.0.1:${server?.port ?? getConfig().port}`;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = log.initLogger();
  context.subscriptions.push(output);

  server = new ChatSyncServer();
  context.subscriptions.push({ dispose: () => void server?.stop() });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'chatsync.showInfo';
  context.subscriptions.push(statusItem);

  registerCommands(context);

  const cfg = getConfig();
  if (!cfg.enabled) {
    setStatus('off');
    log.log('chatsync.enabled = false → server not started');
    return;
  }

  const result = await server.start();
  if (result.ok) {
    setStatus('on');
    log.log('ChatSync ready.', `Open ${BASE_URL()}/ in a browser for the API dashboard.`);
    void announceOnce(context);
  } else {
    setStatus('error');
    void vscode.window.showErrorMessage(
      `ChatSync could not start on port ${cfg.port}: ${result.error}. Check the ChatSync output channel.`,
      'Open Logs',
    ).then((pick) => pick && vscode.commands.executeCommand('chatsync.openLogs'));
  }

  // restart on config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('chatsync')) {
        return;
      }
      const next = getConfig();
      if (!next.enabled) {
        await server?.stop();
        setStatus('off');
        return;
      }
      log.log('configuration changed → restarting server');
      const r = await server?.start();
      setStatus(r?.ok ? 'on' : 'error');
    }),
  );

  // keep the status bar honest when the active editor changes
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => setStatus(server?.isRunning ? 'on' : 'off')));
}

export async function deactivate(): Promise<void> {
  await server?.stop();
  server = undefined;
}

/* ------------------------------------------------------------------ *
 * Status bar
 * ------------------------------------------------------------------ */

type StatusKind = 'on' | 'off' | 'error';

function setStatus(kind: StatusKind): void {
  if (!statusItem) {
    return;
  }
  const port = server?.port ?? getConfig().port;
  if (kind === 'on') {
    statusItem.text = `$(plug) ChatSync :${port}`;
    statusItem.tooltip = new vscode.MarkdownString(
      `**ChatSync bridge** — running on \`http://127.0.0.1:${port}\`\n\n` +
        `Token: \`${server?.token ?? ''}\`\n\n` +
        `Click for actions (copy token, install userscript, self-test).`,
    );
    statusItem.backgroundColor = undefined;
  } else if (kind === 'error') {
    statusItem.text = `$(warning) ChatSync :${port}`;
    statusItem.tooltip = 'ChatSync failed to start — click for details';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    statusItem.text = '$(circle-slash) ChatSync off';
    statusItem.tooltip = 'ChatSync server is stopped — click to start';
    statusItem.backgroundColor = undefined;
  }
  statusItem.show();
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (cmd: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));

  reg('chatsync.start', async () => {
    if (!server) {
      server = new ChatSyncServer();
    }
    const r = await server.start();
    setStatus(r.ok ? 'on' : 'error');
    if (r.ok) {
      void vscode.window.showInformationMessage(`ChatSync listening on http://127.0.0.1:${r.port}`);
    } else {
      void vscode.window.showErrorMessage(`ChatSync failed to start: ${r.error}`);
    }
  });

  reg('chatsync.stop', async () => {
    await server?.stop();
    setStatus('off');
  });

  reg('chatsync.restart', async () => {
    const r = await server?.start();
    setStatus(r?.ok ? 'on' : 'error');
    void vscode.window.showInformationMessage(`ChatSync restarted on port ${server?.port}`);
  });

  reg('chatsync.openLogs', () => {
    output.show(true);
    log.log('— logs opened —');
  });

  reg('chatsync.copyToken', async () => {
    const token = server?.token ?? getToken(getConfig().token);
    await vscode.env.clipboard.writeText(token);
    void vscode.window.showInformationMessage(`ChatSync token copied: ${token}`);
  });

  reg('chatsync.showInfo', async () => {
    const port = server?.port ?? getConfig().port;
    const token = server?.token ?? getToken(getConfig().token);
    const url = `http://127.0.0.1:${port}`;

    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(link) Copy base URL', detail: url, action: 'url' },
        { label: '$(key) Copy token', detail: `${token}  (header: X-ChatSync-Token)`, action: 'token' },
        { label: '$(globe) Open API dashboard in browser', detail: `${url}/`, action: 'dashboard' },
        { label: '$(file-code) Copy userscript (Tampermonkey)', detail: 'chatsync.user.js source to clipboard', action: 'copyScript' },
        { label: '$(save) Save userscript into workspace', detail: 'writes chatsync.user.js so you can drag it into Tampermonkey', action: 'saveScript' },
        { label: '$(beaker) Run self-test', detail: 'calls /health and /context/file locally and reports the result', action: 'selftest' },
        { label: '$(gear) Open settings', detail: 'port, applyMode, allowedOrigins, token…', action: 'settings' },
        { label: '$(output) Show logs', action: 'logs' },
      ],
      {
        title: `ChatSync — ${server?.isRunning ? `running on :${port}` : 'STOPPED'}`,
        placeHolder: `Workspace: ${workspaceRoot() ?? '(none)'} — pick an action`,
      },
    );
    if (!pick) {
      return;
    }
    switch (pick.action) {
      case 'url':
        await vscode.env.clipboard.writeText(url);
        void vscode.window.showInformationMessage(`Copied ${url}`);
        break;
      case 'token':
        await vscode.env.clipboard.writeText(token);
        void vscode.window.showInformationMessage(`Copied token ${token}`);
        break;
      case 'dashboard':
        await vscode.env.openExternal(vscode.Uri.parse(`${url}/?token=${encodeURIComponent(token)}`));
        break;
      case 'copyScript':
        await vscode.commands.executeCommand('chatsync.copyUserscript');
        break;
      case 'saveScript':
        await vscode.commands.executeCommand('chatsync.installUserscriptFile');
        break;
      case 'selftest':
        await vscode.commands.executeCommand('chatsync.selfTest');
        break;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.chatsync');
        break;
      case 'logs':
        output.show(true);
        break;
    }
  });

  reg('chatsync.copyUserscript', async () => {
    const src = readUserscriptFile();
    if (!src) {
      void vscode.window.showErrorMessage('Userscript bundle not found in the extension folder.');
      return;
    }
    const patched = withDefaults(src, server?.port ?? getConfig().port, server?.token ?? '');
    await vscode.env.clipboard.writeText(patched);
    void vscode.window.showInformationMessage('Userscript copied — paste it into Tampermonkey (create new script).');
  });

  reg('chatsync.installUserscriptFile', async () => {
    const src = readUserscriptFile();
    if (!src) {
      void vscode.window.showErrorMessage('Userscript bundle not found in the extension folder.');
      return;
    }
    const patched = withDefaults(src, server?.port ?? getConfig().port, server?.token ?? '');
    const root = workspaceRoot() ?? os.tmpdir();
    const target = path.join(root, 'chatsync.user.js');
    fs.writeFileSync(target, patched, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(
      `Saved ${relToWorkspace(target)} — in Tampermonkey: Utilities → Import from file (or drag it onto the dashboard).`,
    );
  });

  reg('chatsync.selfTest', () => selfTest());
}

/** Bake the live port/token into the userscript's DEFAULTS so it works with zero config. */
function withDefaults(src: string, port: number, token: string): string {
  return src
    .replace(/(const DEFAULTS = \{[^}]*port:\s*)(\d+)/, `$1${port}`)
    .replace(/(const DEFAULTS = \{[^}]*token:\s*)'[^']*'/, `$1'${token}'`);
}

/* ------------------------------------------------------------------ *
 * Self test
 * ------------------------------------------------------------------ */

async function selfTest(): Promise<void> {
  const port = server?.port ?? getConfig().port;
  const token = server?.token ?? getToken(getConfig().token);
  const base = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-ChatSync-Token': token };
  const lines: string[] = [];
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchFn !== 'function') {
    void vscode.window.showErrorMessage('Self-test needs Node 18+ (global fetch).');
    return;
  }

  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      lines.push(`✔ ${name}: ${await fn()}`);
    } catch (e) {
      lines.push(`✘ ${name}: ${(e as Error).message}`);
    }
  };

  await step('GET /health', async () => {
    const r = await fetchFn(`${base}/health`);
    const j = (await r.json()) as { ok?: boolean; version?: string; port?: number };
    if (!r.ok || !j.ok) {
      throw new Error(`status ${r.status}`);
    }
    return `v${j.version} on :${j.port}`;
  });

  await step('auth enforced (no token → 401)', async () => {
    const r = await fetchFn(`${base}/context/file`);
    return getConfig().requireToken ? `status ${r.status} ${r.status === 401 ? '(correct)' : '(UNEXPECTED — should be 401)'}` : `status ${r.status} (token disabled)`;
  });

  await step('GET /context/file', async () => {
    const r = await fetchFn(`${base}/context/file?diagnostics=1`, { headers });
    const j = (await r.json()) as { hasEditor?: boolean; relPath?: string; lineCount?: number; error?: string };
    if (!r.ok) {
      throw new Error(j.error ?? `status ${r.status}`);
    }
    return j.hasEditor ? `${j.relPath} (${j.lineCount} lines)` : 'no active editor';
  });

  await step('GET /context/errors', async () => {
    const r = await fetchFn(`${base}/context/errors`, { headers });
    const j = (await r.json()) as { count?: number };
    return `${j.count ?? 0} problem(s)`;
  });

  await step('CORS preflight from https://chat.deepseek.com', async () => {
    const r = await fetchFn(`${base}/context/file`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://chat.deepseek.com', 'Access-Control-Request-Method': 'GET' },
    });
    const allow = r.headers.get('access-control-allow-origin');
    return `${r.status} allow-origin=${allow ?? 'none'}`;
  });

  await step('POST /apply round-trip on a scratch file', async () => {
    const root = workspaceRoot() ?? os.tmpdir();
    const rel = '.chatsync-selftest.txt';
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, 'line one\nline two\n', 'utf8');
    const r = await fetchFn(`${base}/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: rel, mode: 'replace', content: 'line one\nline two (patched by ChatSync)\n', save: true, preview: false }),
    });
    const j = (await r.json()) as { ok?: boolean; applied?: boolean; error?: string; message?: string };
    const after = fs.readFileSync(abs, 'utf8');
    fs.unlinkSync(abs);
    if (!j.ok) {
      throw new Error(j.error ?? `status ${r.status}`);
    }
    return after.includes('patched by ChatSync') ? 'content written + verified' : `unexpected content: ${JSON.stringify(after)}`;
  });

  const report = lines.join('\n');
  log.log('self-test report:\n' + report);
  output.show(true);
  await vscode.window.showInformationMessage(`ChatSync self-test finished (${lines.filter((l) => l.startsWith('✔')).length}/${lines.length} passed)`, 'Show Details').then(
    (pick) => pick && vscode.commands.executeCommand('chatsync.openLogs'),
  );
}

/* ------------------------------------------------------------------ *
 * One-time welcome
 * ------------------------------------------------------------------ */

async function announceOnce(context: vscode.ExtensionContext): Promise<void> {
  const key = 'chatsync.announced.v1';
  if (context.globalState.get<boolean>(key)) {
    return;
  }
  await context.globalState.update(key, true);
  const port = server?.port ?? getConfig().port;
  const pick = await vscode.window.showInformationMessage(
    `ChatSync bridge is running on http://127.0.0.1:${port}. Install the userscript in Tampermonkey to connect DeepSeek/ChatGPT to VSCode.`,
    'Save userscript to workspace',
    'Copy userscript',
    'Show connection info',
  );
  if (pick === 'Save userscript to workspace') {
    await vscode.commands.executeCommand('chatsync.installUserscriptFile');
  } else if (pick === 'Copy userscript') {
    await vscode.commands.executeCommand('chatsync.copyUserscript');
  } else if (pick === 'Show connection info') {
    await vscode.commands.executeCommand('chatsync.showInfo');
  }
}
