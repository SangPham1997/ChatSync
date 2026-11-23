import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApiRequest, ApiResponse } from './server';
import { getConfig } from './config';
import { clamp, relToWorkspace, truncate, workspaceRoot } from './util';
import * as log from './logger';

export interface SelectionInfo {
  index: number;
  isCursor: boolean;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  charCount: number;
  text: string;
}

export interface DiagnosticInfo {
  file: string;
  absPath: string;
  severity: 'Error' | 'Warning' | 'Information' | 'Hint';
  line: number;
  endLine: number;
  character: number;
  message: string;
  source?: string;
  code?: string;
}

export interface FileContext {
  ok: boolean;
  hasEditor: boolean;
  uri?: string;
  path?: string;
  relPath?: string;
  fileName?: string;
  languageId?: string;
  isDirty?: boolean;
  isUntitled?: boolean;
  lineCount?: number;
  charCount?: number;
  eol?: 'LF' | 'CRLF';
  cursor?: { line: number; character: number };
  selections?: SelectionInfo[];
  hasSelection?: boolean;
  content?: string;
  truncated?: boolean;
  skippedReason?: string;
  diagnostics?: DiagnosticInfo[];
  contextText?: string;
}

function severityName(s: vscode.DiagnosticSeverity): DiagnosticInfo['severity'] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'Error';
    case vscode.DiagnosticSeverity.Warning:
      return 'Warning';
    case vscode.DiagnosticSeverity.Information:
      return 'Information';
    default:
      return 'Hint';
  }
}

export function collectDiagnostics(
  opts: { minSeverity?: string; onlyActiveFile?: boolean; limit?: number } = {},
): DiagnosticInfo[] {
  const order = ['Hint', 'Information', 'Warning', 'Error'];
  const minIdx = Math.max(0, order.indexOf(opts.minSeverity ?? 'Warning'));
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  const out: DiagnosticInfo[] = [];

  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file' && uri.scheme !== 'untitled') {
      continue;
    }
    if (opts.onlyActiveFile && uri.toString() !== active) {
      continue;
    }
    for (const d of diags) {
      const sev = severityName(d.severity);
      if (order.indexOf(sev) < minIdx) {
        continue;
      }
      out.push({
        file: relToWorkspace(uri.fsPath),
        absPath: uri.fsPath,
        severity: sev,
        line: d.range.start.line + 1,
        endLine: d.range.end.line + 1,
        character: d.range.start.character + 1,
        message: d.message,
        source: d.source,
        code: typeof d.code === 'string' ? d.code : d.code ? String((d.code as { value: unknown }).value ?? '') : undefined,
      });
    }
  }

  const sevRank: Record<string, number> = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const limit = clamp(opts.limit, 1, 2000, 200);
  return out.slice(0, limit);
}

function diagnosticsToText(diags: DiagnosticInfo[]): string {
  if (!diags.length) {
    return '';
  }
  return diags.map((d) => `- [${d.severity}] ${d.file}:${d.line}:${d.character} ${d.message}${d.source ? ` (${d.source})` : ''}`).join('\n');
}

/** Build the ready-to-paste markdown snippet for the chat prompt. */
export function buildContextText(info: FileContext, diags: DiagnosticInfo[]): string {
  if (!info.ok || !info.hasEditor) {
    return '';
  }
  const lines: string[] = [];
  const sel = info.selections?.find((s) => !s.isCursor);
  lines.push(`## Active file: ${info.relPath ?? info.fileName ?? 'untitled'}`);
  lines.push('');
  lines.push(
    `- language: ${info.languageId ?? 'unknown'}` +
      `, lines: ${info.lineCount ?? 0}` +
      `, chars: ${info.charCount ?? 0}` +
      (sel ? `, selection: L${sel.startLine}-L${sel.endLine} (${sel.charCount} chars)` : ', selection: none') +
      (info.isDirty ? ', unsaved changes: yes' : ''),
  );
  lines.push('');
  if (sel) {
    lines.push(`Selected code (\`${info.relPath ?? info.fileName}\` lines ${sel.startLine}-${sel.endLine}):`);
    lines.push('');
    lines.push('```' + (info.languageId ?? ''));
    lines.push(sel.text);
    lines.push('```');
  } else if (info.content) {
    lines.push(`Full file content (\`${info.relPath ?? info.fileName}\`):`);
    lines.push('');
    lines.push('```' + (info.languageId ?? ''));
    lines.push(info.content);
    lines.push('```');
  } else if (info.skippedReason) {
    lines.push(`(content skipped: ${info.skippedReason})`);
  }
  const dText = diagnosticsToText(diags);
  if (dText) {
    lines.push('');
    lines.push('## Problems (diagnostics)');
    lines.push('');
    lines.push(dText);
  }
  return lines.join('\n');
}

export function buildActiveFileContext(
  opts: { includeContent?: boolean; includeDiagnostics?: boolean; minSeverity?: string } = {},
): FileContext {
  const cfg = getConfig();
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { ok: true, hasEditor: false, skippedReason: 'no active editor' };
  }
  const doc = editor.document;
  const includeContent = opts.includeContent !== false;
  const maxChars = clamp(cfg.maxContextChars, 1000, 2_000_000, 60000);
  const maxBytes = clamp(cfg.maxFileSizeKB, 1, 200_000, 1024) * 1024;

  const full = includeContent ? doc.getText() : '';
  const byteSize = Buffer.byteLength(full, 'utf8');

  const selections: SelectionInfo[] = editor.selections.map((s, i) => {
    const text = doc.getText(s);
    return {
      index: i,
      isCursor: s.isEmpty,
      startLine: s.start.line + 1,
      startCharacter: s.start.character + 1,
      endLine: s.end.line + 1,
      endCharacter: s.end.character + 1,
      charCount: text.length,
      text: truncate(text, Math.min(maxChars, 40_000)).text,
    };
  });

  let content: string | undefined;
  let truncated = false;
  let skippedReason: string | undefined;

  if (!includeContent) {
    skippedReason = 'content omitted (includeContent=false)';
  } else if (doc.fileName && /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp[34]|wav|woff2?|ttf|eot|bin|exe|dll|so|dylib|class|jar|lock)$/i.test(doc.fileName)) {
    skippedReason = 'binary file';
  } else if (byteSize > maxBytes) {
    skippedReason = `file too large (${Math.round(byteSize / 1024)}KB > ${cfg.maxFileSizeKB}KB)`;
  } else {
    const t = truncate(full, maxChars);
    content = t.text;
    truncated = t.truncated;
  }

  const info: FileContext = {
    ok: true,
    hasEditor: true,
    uri: doc.uri.toString(),
    path: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    relPath: doc.uri.scheme === 'file' ? relToWorkspace(doc.uri.fsPath) : doc.fileName,
    fileName: path.basename(doc.fileName || 'untitled'),
    languageId: doc.languageId,
    isDirty: doc.isDirty,
    isUntitled: doc.isUntitled,
    lineCount: doc.lineCount,
    charCount: full.length,
    eol: doc.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
    cursor: { line: editor.selection.active.line + 1, character: editor.selection.active.character + 1 },
    selections,
    hasSelection: selections.some((s) => !s.isCursor),
    content,
    truncated,
    skippedReason,
  };

  const diags = opts.includeDiagnostics
    ? collectDiagnostics({ onlyActiveFile: true, minSeverity: opts.minSeverity })
    : [];
  if (opts.includeDiagnostics) {
    info.diagnostics = diags;
  }
  info.contextText = buildContextText(info, diags);
  return info;
}

/* ------------------------------------------------------------------ *
 * Path resolution
 * ------------------------------------------------------------------ */

export interface ResolvedTarget {
  uri: vscode.Uri;
  doc?: vscode.TextDocument;
  relPath: string;
  created: boolean;
}

/**
 * Containment guard: the browser may only touch files inside the workspace,
 * or files that are already open in VSCode. With no folder open, everything
 * the user opened is fair game.
 */
export function isPathAllowed(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return true;
  }
  const target = uri.fsPath.replace(/\\/g, '/');
  for (const f of folders) {
    const root = f.uri.fsPath.replace(/\\/g, '/');
    if (target === root || target.startsWith(root.endsWith('/') ? root : root + '/')) {
      return true;
    }
  }
  return vscode.workspace.textDocuments.some((d) => d.uri.fsPath.replace(/\\/g, '/') === target);
}

const OUTSIDE_MSG = 'path is outside the workspace and not open in VSCode (blocked by chatsync containment)';

function byBasename(name: string): vscode.Uri | undefined {
  const want = path.basename(name).toLowerCase();
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  let best: vscode.Uri | undefined;
  let bestDepth = Number.MAX_SAFE_INTEGER;
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '__pycache__']);
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || best) {
      return;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (best) {
        return;
      }
      if (skip.has(e)) {
        continue;
      }
      const full = path.join(dir, e);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.toLowerCase() === want && depth < bestDepth) {
        best = vscode.Uri.file(full);
        bestDepth = depth;
      }
    }
  };
  walk(root, 0);
  return best;
}

/**
 * Resolve a path coming from the browser into a workspace URI.
 * Priority: open editor exact -> open editor basename -> workspace root -> absolute -> basename search.
 */
export function resolveTargetPath(p: string | undefined): ResolvedTarget | { error: string } {
  if (!p || !p.trim()) {
    return { error: 'missing "path"' };
  }
  const raw = p.trim().replace(/^file:\/\//, '');
  const normalized = raw.replace(/\\/g, '/');

  const openDocs = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file');

  const eq = (u: vscode.Uri) =>
    u.fsPath.replace(/\\/g, '/').toLowerCase() === normalized.toLowerCase() ||
    relToWorkspace(u.fsPath).toLowerCase() === normalized.toLowerCase();

  for (const d of openDocs) {
    if (eq(d.uri)) {
      return { uri: d.uri, doc: d, relPath: relToWorkspace(d.uri.fsPath), created: false };
    }
  }
  const base = path.basename(normalized).toLowerCase();
  for (const d of openDocs) {
    if (path.basename(d.uri.fsPath).toLowerCase() === base) {
      return { uri: d.uri, doc: d, relPath: relToWorkspace(d.uri.fsPath), created: false };
    }
  }

  const root = workspaceRoot();
  if (root) {
    const fromRoot = path.resolve(root, normalized);
    const rel = path.relative(root, fromRoot);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const uri = vscode.Uri.file(fromRoot);
      const opened = openDocs.find((d) => d.uri.fsPath === fromRoot);
      return { uri, doc: opened, relPath: rel.split(path.sep).join('/'), created: !fs.existsSync(fromRoot) };
    }
  }
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    const uri = vscode.Uri.file(normalized);
    if (!isPathAllowed(uri)) {
      return { error: OUTSIDE_MSG };
    }
    const opened = openDocs.find((d) => d.uri.fsPath === normalized);
    return { uri, doc: opened, relPath: relToWorkspace(normalized), created: !fs.existsSync(normalized) };
  }
  // Containment guard for relative paths that climb out of the workspace (../../etc/passwd)
  if (root && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
    const absCandidate = path.resolve(root, normalized);
    if (!isPathAllowed(vscode.Uri.file(absCandidate))) {
      return { error: OUTSIDE_MSG };
    }
  }
  const found = byBasename(normalized);
  if (found) {
    const opened = openDocs.find((d) => d.uri.fsPath === found.fsPath);
    return { uri: found, doc: opened, relPath: relToWorkspace(found.fsPath), created: false };
  }
  if (root) {
    const abs = path.resolve(root, normalized);
    const uri = vscode.Uri.file(abs);
    // A path that resolves inside the workspace but does not exist on disk yet
    // is a "new file" request (the apply pipeline creates it).
    return { uri, relPath: normalized, created: !fs.existsSync(abs) };
  }
  if (!isPathAllowed(vscode.Uri.file(normalized))) {
    return { error: OUTSIDE_MSG };
  }
  return { error: `cannot resolve path "${p}" (no workspace folder open)` };
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

function parseBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') {
    return dflt;
  }
  if (typeof v === 'boolean') {
    return v;
  }
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export async function handleContextFile(req: ApiRequest): Promise<ApiResponse> {
  const q = req.url.searchParams;
  const includeContent = parseBool(q.get('content') ?? q.get('includeContent'), true);
  const includeDiagnostics = parseBool(q.get('diagnostics') ?? q.get('includeDiagnostics'), parseBool(q.get('errors'), false));
  const minSeverity = (q.get('minSeverity') ?? 'Warning') as string;
  const info = buildActiveFileContext({ includeContent, includeDiagnostics, minSeverity });
  return { status: 200, body: info };
}

export async function handleContextErrors(req: ApiRequest): Promise<ApiResponse> {
  const q = req.url.searchParams;
  const diags = collectDiagnostics({
    minSeverity: q.get('minSeverity') ?? 'Error',
    onlyActiveFile: parseBool(q.get('onlyActiveFile'), false),
    limit: Number(q.get('limit') ?? 200),
  });
  return {
    status: 200,
    body: { ok: true, count: diags.length, diagnostics: diags, text: diagnosticsToText(diags) },
  };
}

export async function handleContextWorkspace(_req: ApiRequest): Promise<ApiResponse> {
  const root = workspaceRoot();
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  const docs = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file');
  return {
    status: 200,
    body: {
      ok: true,
      root,
      folders,
      openDocuments: docs.map((d) => ({
        path: relToWorkspace(d.uri.fsPath),
        absPath: d.uri.fsPath,
        languageId: d.languageId,
        isDirty: d.isDirty,
        lineCount: d.lineCount,
      })),
      activeFile: vscode.window.activeTextEditor
        ? relToWorkspace(vscode.window.activeTextEditor.document.uri.fsPath)
        : undefined,
    },
  };
}

export async function handleTabs(_req: ApiRequest): Promise<ApiResponse> {
  const tabs: unknown[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        tabs.push({
          label: tab.label,
          path: relToWorkspace(input.uri.fsPath),
          absPath: input.uri.fsPath,
          isDirty: tab.isDirty,
          isActive: tab.isActive,
          groupIndex: group.viewColumn - 1,
        });
      }
    }
  }
  return { status: 200, body: { ok: true, count: tabs.length, tabs } };
}

export async function handleFileContent(req: ApiRequest): Promise<ApiResponse> {
  const cfg = getConfig();
  const q = req.url.searchParams;
  const target = resolveTargetPath(q.get('path') ?? undefined);
  if ('error' in target) {
    const blocked = /outside the workspace/.test(target.error);
    return { status: blocked ? 403 : 400, body: { ok: false, error: target.error } };
  }
  const maxChars = clamp(cfg.maxContextChars, 1000, 2_000_000, 60000);
  const wantContent = !/^(0|false|no)$/i.test(q.get('content') ?? '1');
  const includeDiagnostics = /^(1|true|yes)$/i.test(q.get('diagnostics') ?? '');
  try {
    const doc = target.doc ?? (await vscode.workspace.openTextDocument(target.uri));
    const full = doc.getText();
    const t = wantContent ? truncate(full, maxChars) : { text: undefined, truncated: false };
    return {
      status: 200,
      body: {
        ok: true,
        path: target.relPath,
        absPath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
        languageId: doc.languageId,
        lineCount: doc.lineCount,
        charCount: full.length,
        bytes: Buffer.byteLength(full, 'utf8'),
        eol: doc.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
        isDirty: doc.isDirty,
        content: t.text,
        truncated: t.truncated,
        diagnostics: includeDiagnostics
          ? collectDiagnostics({ minSeverity: 'Error', limit: 100 }).filter((d) => d.absPath === doc.uri.fsPath)
          : undefined,
      },
    };
  } catch (e) {
    log.warn('file read failed', target.relPath, String(e));
    return { status: 404, body: { ok: false, error: `cannot read "${target.relPath}": ${(e as Error).message}` } };
  }
}
