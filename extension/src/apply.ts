import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ApiRequest, ApiResponse } from './server';
import { getConfig } from './config';
import { clamp, eolOf, normalizeEol, relToWorkspace, stripFence, workspaceRoot } from './util';
import { buildActiveFileContext, collectDiagnostics, resolveTargetPath, ResolvedTarget } from './context';
import * as log from './logger';

export type ApplyMode =
  | 'replace' // replace whole file content
  | 'replaceSelection' // replace current selection (or insert at cursor if none)
  | 'insert' // insert at cursor
  | 'append' // append to end of file
  | 'patch' // find `search` -> replace with `replace` (must be unique unless replaceAll)
  | 'newFile'; // create a new file

export interface ApplyPayload {
  mode?: ApplyMode;
  path?: string;
  content?: string;
  search?: string;
  replace?: string;
  replaceAll?: boolean;
  line?: number;
  endLine?: number;
  save?: boolean;
  preview?: boolean;
  open?: boolean;
  reveal?: boolean;
  label?: string;
}

interface PendingApply {
  id: string;
  targetUri: vscode.Uri;
  newContent: string;
  oldContent: string;
  relPath: string;
  tmpUri: vscode.Uri;
  mode: ApplyMode;
  save: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApply>();
const backupDir = path.join(os.tmpdir(), 'chatsync-backups');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function makeId(): string {
  const rnd =
    typeof (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID === 'function'
      ? (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return 'ap_' + rnd.replace(/-/g, '').slice(0, 16);
}

function backupPathFor(uri: vscode.Uri): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(backupDir, `${path.basename(uri.fsPath)}.${stamp}.bak`);
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) {
    return target;
  }
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

async function openDoc(target: ResolvedTarget): Promise<vscode.TextDocument> {
  if (target.doc) {
    return target.doc;
  }
  return vscode.workspace.openTextDocument(target.uri);
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function computeRangeForPatch(doc: vscode.TextDocument, search: string): { range?: vscode.Range; error?: string; occurrences?: number } {
  const text = doc.getText();
  const exact = countOccurrences(text, search);
  if (exact === 1) {
    const start = doc.positionAt(text.indexOf(search));
    const end = doc.positionAt(text.indexOf(search) + search.length);
    return { range: new vscode.Range(start, end), occurrences: 1 };
  }
  if (exact > 1) {
    return { error: `"search" matches ${exact} times — add more surrounding lines or use replaceAll:true`, occurrences: exact };
  }
  // try line-trimmed comparison
  const lines = text.split(/\r?\n/);
  const searchLines = search.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (searchLines.length === 0) {
    return { error: '"search" is empty', occurrences: 0 };
  }
  const matches: number[] = [];
  for (let i = 0; i + searchLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if ((lines[i + j] ?? '').trim() !== searchLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(i);
    }
  }
  if (matches.length === 1) {
    const startLine = matches[0];
    const endLine = startLine + searchLines.length - 1;
    return {
      range: new vscode.Range(new vscode.Position(startLine, 0), doc.lineAt(endLine).range.end),
      occurrences: 1,
    };
  }
  if (matches.length > 1) {
    return { error: `"search" matches ${matches.length} blocks (whitespace-insensitive) — make it more specific`, occurrences: matches.length };
  }
  return { error: '"search" text not found in the file', occurrences: 0 };
}

function targetRange(doc: vscode.TextDocument, mode: ApplyMode, payload: ApplyPayload, editor?: vscode.TextEditor): { range?: vscode.Range; error?: string } {
  switch (mode) {
    case 'replace':
      return { range: fullRange(doc) };
    case 'append': {
      const last = doc.lineAt(doc.lineCount - 1);
      return { range: new vscode.Range(last.range.end, last.range.end) };
    }
    case 'insert': {
      const pos = editor && editor.document.uri.toString() === doc.uri.toString() ? editor.selection.active : doc.positionAt(0);
      return { range: new vscode.Range(pos, pos) };
    }
    case 'replaceSelection': {
      if (editor && editor.document.uri.toString() === doc.uri.toString()) {
        const sel = editor.selection;
        return { range: sel.isEmpty ? new vscode.Range(sel.active, sel.active) : new vscode.Range(sel.start, sel.end) };
      }
      return { error: 'replaceSelection needs the target file to be the active editor' };
    }
    case 'patch': {
      const search = payload.search ?? '';
      const r = computeRangeForPatch(doc, search);
      if (r.error) {
        return { error: r.error };
      }
      return { range: r.range };
    }
    default:
      return { error: `unsupported mode "${mode}"` };
  }
}

function buildNewContent(doc: vscode.TextDocument, mode: ApplyMode, payload: ApplyPayload, range: vscode.Range): string {
  const eol = eolOf(doc);
  const text = doc.getText();
  const insert = normalizeEol(payload.content ?? '', eol);
  switch (mode) {
    case 'replace':
      return insert;
    case 'append':
      return text.endsWith(eol) || text.length === 0 ? text + insert : text + eol + insert;
    case 'insert':
    case 'replaceSelection': {
      const before = text.slice(0, doc.offsetAt(range.start));
      const after = text.slice(doc.offsetAt(range.end));
      return before + insert + after;
    }
    case 'patch': {
      const replacement = normalizeEol(payload.replace ?? payload.content ?? '', eol);
      const search = payload.search ?? '';
      if (payload.replaceAll) {
        return text.split(search).join(replacement);
      }
      const idx = text.indexOf(search);
      if (idx >= 0) {
        return text.slice(0, idx) + replacement + text.slice(idx + search.length);
      }
      // whitespace-insensitive single match
      const before = text.slice(0, doc.offsetAt(range.start));
      const after = text.slice(doc.offsetAt(range.end));
      return before + replacement + after;
    }
    default:
      return insert;
  }
}

/* ------------------------------------------------------------------ *
 * Direct apply
 * ------------------------------------------------------------------ */

async function writeContent(doc: vscode.TextDocument, newContent: string): Promise<boolean> {
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, fullRange(doc), newContent);
  return vscode.workspace.applyEdit(we);
}

async function performDirectApply(
  target: ResolvedTarget,
  mode: ApplyMode,
  payload: ApplyPayload,
): Promise<ApiResponse> {
  const cfg = getConfig();
  const editor = vscode.window.activeTextEditor;

  if (mode === 'newFile' || target.created) {
    const eol = '\n';
    const content = normalizeEol(payload.content ?? '', eol);
    const root = workspaceRoot();
    const abs = target.uri.fsPath;
    if (root && !abs.startsWith(root)) {
      return { status: 403, body: { ok: false, error: 'refusing to create a file outside the workspace root' } };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const finalPath = uniquePath(abs);
    fs.writeFileSync(finalPath, content, 'utf8');
    const uri = vscode.Uri.file(finalPath);
    if (payload.open !== false) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return {
      status: 200,
      body: {
        ok: true,
        applied: true,
        mode: 'newFile',
        path: relToWorkspace(finalPath),
        absPath: finalPath,
        charsWritten: content.length,
        message: `Created ${relToWorkspace(finalPath)}`,
      },
    };
  }

  let doc: vscode.TextDocument;
  try {
    doc = await openDoc(target);
  } catch (e) {
    return { status: 404, body: { ok: false, error: `cannot open "${target.relPath}": ${(e as Error).message}` } };
  }

  const { range, error } = targetRange(doc, mode, payload, editor);
  if (error || !range) {
    return { status: 409, body: { ok: false, error, path: target.relPath, mode } };
  }

  const oldContent = doc.getText();
  const newContent = buildNewContent(doc, mode, payload, range);
  if (newContent === oldContent) {
    return { status: 200, body: { ok: true, applied: false, mode, path: target.relPath, message: 'no change (identical content)' } };
  }

  // backup first
  let backup: string | undefined;
  try {
    if (doc.uri.scheme === 'file' && fs.existsSync(doc.uri.fsPath)) {
      backup = backupPathFor(doc.uri);
      fs.writeFileSync(backup, oldContent, 'utf8');
    }
  } catch (e) {
    log.warn('backup failed', String(e));
  }

  const ok = await writeContent(doc, newContent);
  if (!ok) {
    return { status: 500, body: { ok: false, error: 'vscode.workspace.applyEdit() failed', path: target.relPath } };
  }

  const shouldSave = payload.save ?? cfg.autoSave;
  if (shouldSave) {
    await doc.save();
  }

  if (payload.reveal !== false && (payload.save === true || cfg.applyMode === 'direct')) {
    try {
      const shown = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      const line = clamp(payload.line ?? range.start.line + 1, 1, doc.lineCount, 1);
      shown.revealRange(new vscode.Range(line - 1, 0, Math.min(doc.lineCount, line + 8) - 1, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      /* ignore reveal errors */
    }
  }

  const body: Record<string, unknown> = {
    ok: true,
    applied: true,
    mode,
    path: target.relPath,
    absPath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    range: { startLine: range.start.line + 1, endLine: range.end.line + 1 },
    charsBefore: oldContent.length,
    charsAfter: newContent.length,
    linesAfter: newContent.split(/\r?\n/).length,
    saved: Boolean(shouldSave),
    backup,
    message: `Applied (${mode}) → ${target.relPath}${shouldSave ? ' [saved]' : ''} — Ctrl+Z to undo`,
  };

  if (cfg.applyMode === 'direct' && backup) {
    const pick = await vscode.window.showInformationMessage(
      `ChatSync applied ${mode} → ${target.relPath}`,
      { modal: false },
      'Keep',
      'Revert file',
    );
    if (pick === 'Revert file') {
      const reverted = await writeContent(doc, oldContent);
      if (shouldSave && reverted) {
        await doc.save();
      }
      body.reverted = reverted;
      body.message = 'Reverted from backup';
    }
  }

  return { status: 200, body };
}

/* ------------------------------------------------------------------ *
 * Diff preview apply
 * ------------------------------------------------------------------ */

function cleanupPending(p: PendingApply): void {
  clearTimeout(p.timer);
  pending.delete(p.id);
  fs.promises.unlink(p.tmpUri.fsPath).catch(() => undefined);
}

async function performPreviewApply(target: ResolvedTarget, mode: ApplyMode, payload: ApplyPayload): Promise<ApiResponse> {
  const cfg = getConfig();
  const editor = vscode.window.activeTextEditor;
  let doc: vscode.TextDocument;
  try {
    doc = await openDoc(target);
  } catch (e) {
    return { status: 404, body: { ok: false, error: `cannot open "${target.relPath}": ${(e as Error).message}` } };
  }
  const { range, error } = targetRange(doc, mode, payload, editor);
  if (error || !range) {
    return { status: 409, body: { ok: false, error, path: target.relPath, mode } };
  }
  const oldContent = doc.getText();
  const newContent = buildNewContent(doc, mode, payload, range);
  if (newContent === oldContent) {
    return { status: 200, body: { ok: true, applied: false, mode, path: target.relPath, message: 'no change (identical content)' } };
  }

  const id = makeId();
  const tmpFile = path.join(os.tmpdir(), `chatsync-preview-${id}${path.extname(doc.fileName) || '.txt'}`);
  fs.writeFileSync(tmpFile, newContent, 'utf8');
  const tmpUri = vscode.Uri.file(tmpFile);

  const timeoutMs = clamp(cfg.previewTimeoutSeconds, 10, 3600, 300) * 1000;
  const entry: PendingApply = {
    id,
    targetUri: doc.uri,
    newContent,
    oldContent,
    relPath: target.relPath,
    tmpUri,
    mode,
    save: payload.save ?? cfg.autoSave,
    expiresAt: Date.now() + timeoutMs,
    timer: setTimeout(() => {
      const p = pending.get(id);
      if (p) {
        cleanupPending(p);
        log.warn(`preview ${id} expired without confirmation`);
      }
    }, timeoutMs),
  };
  pending.set(id, entry);

  await vscode.commands.executeCommand(
    'vscode.diff',
    doc.uri,
    tmpUri,
    `${path.basename(doc.fileName)} (current) ↔ ChatSync (${mode})`,
    { preview: true, preserveFocus: false },
  );

  // In-editor confirmation (mirrors POST /apply/confirm)
  const pick = await vscode.window.showInformationMessage(
    `ChatSync preview: ${mode} → ${target.relPath}`,
    { modal: false },
    'Apply',
    'Discard',
  );
  if (pick === 'Apply') {
    void confirmApply(id, 'editor-button');
  } else if (pick === 'Discard') {
    void cancelApply(id, 'editor-button');
  }

  return {
    status: 200,
    body: {
      ok: true,
      applied: false,
      preview: true,
      applyId: id,
      mode,
      path: target.relPath,
      charsBefore: oldContent.length,
      charsAfter: newContent.length,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      message: `Diff opened in VSCode. Confirm with POST /apply/confirm {"applyId":"${id}"} or the Apply button.`,
      endpoints: { confirm: '/apply/confirm', cancel: '/apply/cancel' },
    },
  };
}

export async function confirmApply(id: string, source: string): Promise<ApiResponse> {
  const p = pending.get(id);
  if (!p) {
    return { status: 404, body: { ok: false, error: `unknown or expired applyId "${id}"` } };
  }
  cleanupPending(p);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(p.targetUri);
  } catch (e) {
    return { status: 500, body: { ok: false, error: (e as Error).message } };
  }
  let backup: string | undefined;
  try {
    if (doc.uri.scheme === 'file' && fs.existsSync(doc.uri.fsPath)) {
      backup = backupPathFor(doc.uri);
      fs.writeFileSync(backup, doc.getText(), 'utf8');
    }
  } catch (e) {
    log.warn('backup failed', String(e));
  }
  const ok = await writeContent(doc, p.newContent);
  if (!ok) {
    return { status: 500, body: { ok: false, error: 'applyEdit failed', path: p.relPath } };
  }
  if (p.save) {
    await doc.save();
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  log.log(`apply confirmed (${source}) → ${p.relPath} [${p.mode}]`);
  return {
    status: 200,
    body: {
      ok: true,
      applied: true,
      applyId: id,
      mode: p.mode,
      path: p.relPath,
      saved: p.save,
      backup,
      message: `Applied ${p.mode} → ${p.relPath} — Ctrl+Z to undo`,
    },
  };
}

export async function cancelApply(id: string, source: string): Promise<ApiResponse> {
  const p = pending.get(id);
  if (!p) {
    return { status: 404, body: { ok: false, error: `unknown or expired applyId "${id}"` } };
  }
  cleanupPending(p);
  log.log(`apply discarded (${source}) → ${p.relPath}`);
  return { status: 200, body: { ok: true, applied: false, cancelled: true, applyId: id, path: p.relPath } };
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

function inferPathFromContent(content: string): string | undefined {
  const { pathHint } = stripFence(content);
  return pathHint;
}

export async function handleApply(req: ApiRequest): Promise<ApiResponse> {
  const cfg = getConfig();
  const body = (req.body ?? {}) as ApplyPayload & { code?: string; text?: string };

  let content = body.content ?? body.code ?? body.text;
  if (typeof content !== 'string') {
    // raw text/plain body
    content = typeof req.rawBody === 'string' ? req.rawBody : '';
  }
  const stripped = stripFence(content);
  content = stripped.code;

  const mode = (body.mode ?? 'replace') as ApplyMode;
  let targetPath = body.path ?? stripped.pathHint ?? (mode === 'newFile' ? inferPathFromContent(content) : undefined);

  if (mode === 'patch' && !body.search) {
    return { status: 400, body: { ok: false, error: 'mode "patch" requires a "search" string' } };
  }
  if (!targetPath && mode !== 'newFile') {
    const active = vscode.window.activeTextEditor?.document;
    if (!active) {
      return { status: 400, body: { ok: false, error: 'no "path" given and no active editor in VSCode' } };
    }
    targetPath = relToWorkspace(active.uri.fsPath);
  }

  const target = resolveTargetPath(targetPath);
  if ('error' in target) {
    const blocked = /outside the workspace/.test(target.error);
    return { status: blocked ? 403 : 400, body: { ok: false, error: target.error } };
  }

  const effectiveMode: ApplyMode = target.created ? 'newFile' : mode;
  const wantPreview = body.preview ?? cfg.applyMode === 'diff';
  log.log(`apply ${effectiveMode} → ${target.relPath} (${wantPreview ? 'preview' : 'direct'}, ${content.length} chars) ${body.label ? `[${body.label}]` : ''}`);

  const res = wantPreview && effectiveMode !== 'newFile'
    ? await performPreviewApply(target, effectiveMode, { ...body, content })
    : await performDirectApply(target, effectiveMode, { ...body, content });

  // attach fresh diagnostics for the touched file so the chat can react
  if (res.status === 200 && (res.body as { applied?: boolean }).applied) {
    const diags = collectDiagnostics({ minSeverity: 'Error', limit: 50 }).filter(
      (d) => d.absPath === target.uri.fsPath,
    );
    (res.body as Record<string, unknown>).diagnosticsAfter = diags;
    (res.body as Record<string, unknown>).contextAfter = buildActiveFileContext({ includeContent: false, includeDiagnostics: false });
  }
  return res;
}

export async function handleApplyBatch(req: ApiRequest): Promise<ApiResponse> {
  const body = (req.body ?? {}) as { applies?: ApplyPayload[] };
  const list = Array.isArray(body.applies) ? body.applies : [];
  if (list.length === 0) {
    return { status: 400, body: { ok: false, error: 'body.applies must be a non-empty array' } };
  }
  if (list.length > 50) {
    return { status: 400, body: { ok: false, error: 'too many applies in one batch (max 50)' } };
  }
  const results: unknown[] = [];
  for (const item of list) {
    const r = await handleApply({ ...req, body: item });
    results.push({ path: item.path, status: r.status, body: r.body });
  }
  const failed = results.filter((r) => (r as { status: number }).status !== 200).length;
  return { status: failed === 0 ? 200 : 207, body: { ok: failed === 0, count: results.length, failed, results } };
}

export async function handleApplyConfirm(req: ApiRequest): Promise<ApiResponse> {
  const body = (req.body ?? {}) as { applyId?: string };
  const id = body.applyId ?? req.url.searchParams.get('applyId') ?? '';
  if (!id) {
    return { status: 400, body: { ok: false, error: 'missing applyId' } };
  }
  return confirmApply(id, 'http');
}

export async function handleApplyCancel(req: ApiRequest): Promise<ApiResponse> {
  const body = (req.body ?? {}) as { applyId?: string };
  const id = body.applyId ?? req.url.searchParams.get('applyId') ?? '';
  if (!id) {
    return { status: 400, body: { ok: false, error: 'missing applyId' } };
  }
  return cancelApply(id, 'http');
}

export async function handleApplyList(_req: ApiRequest): Promise<ApiResponse> {
  const items = [...pending.values()].map((p) => ({
    applyId: p.id,
    path: p.relPath,
    mode: p.mode,
    expiresAt: new Date(p.expiresAt).toISOString(),
  }));
  return { status: 200, body: { ok: true, count: items.length, pending: items } };
}

export function pendingCount(): number {
  return pending.size;
}

export function discardAllPending(): void {
  for (const p of [...pending.values()]) {
    cleanupPending(p);
  }
}
