import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ApiRequest, ApiResponse } from './server';
import { getConfig } from './config';
import { clamp, eolOf, normalizeEol, relToWorkspace, stripFence, workspaceRoot } from './util';
import { buildActiveFileContext, collectDiagnostics, DiagnosticInfo, resolveTargetPath, ResolvedTarget } from './context';
import { DiagnosticDiff, makeDiffReport, settleDiagnostics } from './errors';
import * as log from './logger';

export type ApplyMode =
  | 'replace' // replace whole file content
  | 'replaceSelection' // replace current selection (or insert at cursor if none)
  | 'insert' // insert at cursor
  | 'insertAtLine' // insert before a 1-based line
  | 'append' // append to end of file
  | 'patch' // find `search` -> replace with `replace` (must be unique unless replaceAll)
  | 'lines' // replace an inclusive 1-based line range
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
  preview?: boolean | 'auto';
  batchId?: string;
  autoUndoMs?: number;
  diagnostics?: boolean;
  settleMs?: number;
  settleTimeoutMs?: number;
  undoAfterMs?: number;
  open?: boolean;
  reveal?: boolean;
  label?: string;
}

interface PendingApply {
  id: string;
  kind: 'edit' | 'newFile';
  beforeTmpUri?: vscode.Uri;
  batchId?: string;
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
 * Apply records — the memory behind the error loop and /apply/undo.
 * We keep the *pre-apply* diagnostics snapshot and file content so that,
 * after the language server finishes re-analysing, we can tell the chat
 * exactly which problems this edit introduced or fixed.
 * ------------------------------------------------------------------ */

export interface ApplyRecord {
  id: string;
  batchId?: string;
  uri: vscode.Uri;
  relPath: string;
  mode: ApplyMode;
  beforeContent: string;
  afterContent: string;
  baseline: DiagnosticInfo[];
  targetPaths: string[];
  createdAt: number;
  undoExpiresAt: number;
  created: boolean;
  settled: boolean;
  waitedMs: number;
  finalDiagnostics: DiagnosticInfo[];
  lastDiff?: ReturnType<typeof makeDiffReport>;
}

const MAX_RECORDS = 50;

function recordStore(): Map<string, ApplyRecord> {
  const g = globalThis as unknown as { __chatsyncApplyRecords?: Map<string, ApplyRecord> };
  if (!g.__chatsyncApplyRecords) {
    g.__chatsyncApplyRecords = new Map<string, ApplyRecord>();
  }
  return g.__chatsyncApplyRecords;
}

function recordKey(r: ApplyRecord): string {
  return `${r.relPath.replace(/\\/g, '/').toLowerCase()}@@${r.mode}`;
}

/** Keep at most one record per (file, mode) so the batch error check is not ambiguous. */
function storeRecord(r: ApplyRecord): void {
  const m = recordStore();
  for (const [k, v] of m) {
    if (recordKey(v) === recordKey(r)) {
      m.delete(k);
    }
  }
  m.set(r.id, r);
  while (m.size > MAX_RECORDS) {
    const oldest = [...m.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) {
      break;
    }
    m.delete(oldest[0]);
  }
}

export function findRecord(idOrApplyId?: string, batchId?: string): ApplyRecord | undefined {
  const m = recordStore();
  if (idOrApplyId) {
    if (m.has(idOrApplyId)) {
      return m.get(idOrApplyId);
    }
    const clean = idOrApplyId.replace(/^ap_/, '');
    for (const r of m.values()) {
      if (r.id.replace(/^ap_/, '') === clean) {
        return r;
      }
    }
  }
  if (batchId) {
    for (const r of m.values()) {
      if (r.batchId === batchId) {
        return r;
      }
    }
  }
  return undefined;
}

export function findRecordsByBatch(batchId: string): ApplyRecord[] {
  return [...recordStore().values()].filter((r) => r.batchId === batchId);
}

export function listRecords(): Record<string, unknown>[] {
  const m = recordStore();
  const now = Date.now();
  return [...m.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      applyId: r.id,
      batchId: r.batchId,
      path: r.relPath,
      mode: r.mode,
      appliedAt: new Date(r.createdAt).toISOString(),
      undoExpiresAt: new Date(r.undoExpiresAt).toISOString(),
      undoable: now < r.undoExpiresAt,
      settled: r.settled,
      newErrors: r.lastDiff ? r.lastDiff.newErrors.length : undefined,
      fixedErrors: r.lastDiff ? r.lastDiff.fixedErrors.length : undefined,
    }));
}

function pruneExpiredRecords(): void {
  const m = recordStore();
  const now = Date.now();
  for (const [k, r] of m) {
    if (now > r.undoExpiresAt + 10 * 60 * 1000) {
      m.delete(k);
    }
  }
}

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
    case 'insertAtLine': {
      const line = clamp(payload.line, 1, doc.lineCount + 1, doc.lineCount + 1) - 1;
      const pos = line >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(line, 0);
      return { range: new vscode.Range(pos, pos) };
    }
    case 'lines': {
      const start = clamp(payload.line, 1, doc.lineCount, 1) - 1;
      const end = clamp(payload.endLine ?? payload.line, start + 1, doc.lineCount, start + 1) - 1;
      return { range: new vscode.Range(new vscode.Position(start, 0), doc.lineAt(end).range.end) };
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
    case 'insertAtLine':
    case 'replaceSelection': {
      const before = text.slice(0, doc.offsetAt(range.start));
      const after = text.slice(doc.offsetAt(range.end));
      return before + insert + after;
    }
    case 'lines': {
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
 * Error-loop plumbing: snapshot → apply → settle → diff
 * ------------------------------------------------------------------ */

function snapshotForTarget(fsPath: string): DiagnosticInfo[] {
  if (!getConfig().reportErrorDiff) {
    return [];
  }
  return collectDiagnostics({ minSeverity: 'Error', limit: 2000 }).filter((d) => {
    const a = d.absPath.replace(/\\/g, '/').toLowerCase();
    const b = fsPath.replace(/\\/g, '/').toLowerCase();
    return a === b || d.file.replace(/\\/g, '/').toLowerCase() === b;
  });
}

function recordApply(args: {
  uri: vscode.Uri;
  relPath: string;
  mode: ApplyMode;
  beforeContent: string;
  afterContent: string;
  baseline: DiagnosticInfo[];
  targetPaths: string[];
  batchId?: string;
  undoable: boolean;
  created?: boolean;
}): ApplyRecord {
  const cfg = getConfig();
  const now = Date.now();
  const rec: ApplyRecord = {
    id: makeId(),
    batchId: args.batchId,
    uri: args.uri,
    relPath: args.relPath,
    mode: args.mode,
    beforeContent: args.beforeContent,
    afterContent: args.afterContent,
    baseline: args.baseline,
    targetPaths: args.targetPaths,
    createdAt: now,
    created: Boolean(args.created),
    undoExpiresAt: args.undoable ? now + clamp(cfg.autoApplyUndoWindowMinutes, 0, 120, 10) * 60_000 : now,
    settled: false,
    waitedMs: 0,
    finalDiagnostics: [],
  };
  storeRecord(rec);
  return rec;
}

/**
 * Wait for the language server to finish with this file, then report what the
 * edit actually did to the Problems panel. Skippable with `diagnostics:false`
 * (useful for fast batch pipelines).
 */
async function withDiff(body: Record<string, unknown>, rec: ApplyRecord, payload: ApplyPayload): Promise<ApiResponse> {
  const cfg = getConfig();
  if (!cfg.reportErrorDiff || payload.diagnostics === false) {
    return { status: 200, body };
  }
  const settle = await settleDiagnostics(rec.targetPaths, {
    stableMs: Number(payload.settleMs) || undefined,
    timeoutMs: Number(payload.settleTimeoutMs) || undefined,
    minSeverity: 'Error',
  });
  rec.settled = settle.settled;
  rec.waitedMs = settle.waitedMs;
  rec.finalDiagnostics = settle.diagnostics;
  const diff = makeDiffReport({
    targetPaths: rec.targetPaths,
    before: rec.baseline,
    after: settle.diagnostics,
    settled: settle.settled,
    waitedMs: settle.waitedMs,
    path: rec.relPath,
    mode: rec.mode,
  });
  rec.lastDiff = diff;
  body.diagnosticsDiff = diff;
  if (diff.newErrors.length) {
    body.message = `${String(body.message ?? 'Applied')} — ⚠ ${diff.newErrors.length} lỗi mới (${diff.newErrors[0].message})`;
  }
  return { status: 200, body };
}

/** Restore the exact pre-apply content of a recorded apply (works after a reload). */
async function undoRecord(rec: ApplyRecord, source: string): Promise<ApiResponse> {
  if (Date.now() > rec.undoExpiresAt) {
    return { status: 410, body: { ok: false, error: `undo window closed at ${new Date(rec.undoExpiresAt).toISOString()}` } };
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(rec.uri);
  } catch (e) {
    return { status: 500, body: { ok: false, error: (e as Error).message } };
  }
  const current = doc.getText();
  let deleted = false;
  if (rec.created && rec.beforeContent === '' && doc.uri.scheme === 'file') {
    // the file did not exist before this apply → undo means delete
    const we = new vscode.WorkspaceEdit();
    we.delete(doc.uri, fullRange(doc));
    await vscode.workspace.applyEdit(we);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    try {
      fs.unlinkSync(doc.uri.fsPath);
      deleted = true;
    } catch (e) {
      log.warn('undo delete failed', String(e));
    }
    recordStore().delete(rec.id);
    log.log(`undo+delete (${source}) → ${rec.relPath}`);
    return {
      status: 200,
      body: { ok: true, undone: true, deleted, applyId: rec.id, path: rec.relPath, mode: rec.mode, message: `Deleted ${rec.relPath} (it did not exist before)` },
    };
  }
  const ok = await writeContent(doc, rec.beforeContent);
  if (!ok) {
    return { status: 500, body: { ok: false, error: 'applyEdit failed during undo' } };
  }
  const saved = await doc.save();
  recordStore().delete(rec.id);
  log.log(`undo (${source}) → ${rec.relPath}`);
  const after = snapshotForTarget(doc.uri.fsPath);
  return {
    status: 200,
    body: {
      ok: true,
      undone: true,
      applyId: rec.id,
      path: rec.relPath,
      mode: rec.mode,
      saved,
      restoredChars: current.length,
      diagnosticsAfter: after,
      message: `Undoed ${rec.mode} → ${rec.relPath}`,
    },
  };
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
    const finalUri = vscode.Uri.file(finalPath);
    const baseline = snapshotForTarget(target.uri.fsPath);
    fs.writeFileSync(finalPath, content, 'utf8');
    if (payload.open !== false) {
      const doc = await vscode.workspace.openTextDocument(finalUri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    const rec = recordApply({
      uri: finalUri,
      relPath: relToWorkspace(finalPath),
      mode: 'newFile',
      beforeContent: '',
      afterContent: content,
      baseline,
      targetPaths: [finalPath, relToWorkspace(finalPath)],
      batchId: payload.batchId,
      undoable: true,
      created: true,
    });
    return withDiff(
      {
        ok: true,
        applied: true,
        mode: 'newFile',
        applyId: rec.id,
        path: relToWorkspace(finalPath),
        absPath: finalPath,
        charsWritten: content.length,
        message: `Created ${relToWorkspace(finalPath)}`,
      },
      rec,
      payload,
    );
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

  const baseline = snapshotForTarget(doc.uri.fsPath);

  // backup first (survives reloads; the in-memory record only enables fast undo)
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

  const rec = recordApply({
    uri: doc.uri,
    relPath: target.relPath,
    mode,
    beforeContent: oldContent,
    afterContent: newContent,
    baseline,
    targetPaths: [doc.uri.fsPath, target.relPath],
    batchId: payload.batchId,
    undoable: true,
  });
  body.applyId = rec.id;

  const autoUndoMs = Number(payload.autoUndoMs) || 0;
  if (autoUndoMs > 0 && autoUndoMs <= 60_000) {
    setTimeout(() => {
      const p = recordStore().get(rec.id);
      if (p && Date.now() >= p.undoExpiresAt) {
        void undoRecord(p, 'auto-timeout').then((r) => {
          if ((r.body as { undone?: boolean }).undone) {
            log.log(`auto-undo after ${autoUndoMs}ms → ${p.relPath}`);
          }
        });
      }
    }, autoUndoMs + 50);
  }

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
      recordStore().delete(rec.id);
    }
  }

  return withDiff(body, rec, payload);
}

/* ------------------------------------------------------------------ *
 * Diff preview apply
 * ------------------------------------------------------------------ */

function cleanupPending(p: PendingApply): void {
  clearTimeout(p.timer);
  pending.delete(p.id);
  fs.promises.unlink(p.tmpUri.fsPath).catch(() => undefined);
  if (p.beforeTmpUri) {
    fs.promises.unlink(p.beforeTmpUri.fsPath).catch(() => undefined);
  }
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
    kind: 'edit',
    batchId: payload.batchId,
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

  // a previewed new file lands on disk only now
  if (p.kind === 'newFile') {
    const abs = p.targetUri.fsPath;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const finalPath = uniquePath(abs);
    fs.writeFileSync(finalPath, p.newContent, 'utf8');
    const uri = finalPath === abs ? p.targetUri : vscode.Uri.file(finalPath);
    const opened = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(opened, { preview: false });
    const rec = recordApply({
      uri,
      relPath: relToWorkspace(finalPath),
      mode: 'newFile',
      beforeContent: p.oldContent,
      afterContent: p.newContent,
      baseline: snapshotForTarget(finalPath),
      targetPaths: [finalPath, relToWorkspace(finalPath)],
      batchId: p.batchId,
      undoable: true,
      created: p.oldContent === '',
    });
    log.log(`new file confirmed (${source}) → ${rec.relPath}`);
    return withDiff(
      {
        ok: true,
        applied: true,
        applyId: rec.id,
        previewApplyId: id,
        mode: 'newFile',
        path: rec.relPath,
        absPath: finalPath,
        message: `Created ${rec.relPath}`,
      },
      rec,
      {},
    );
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(p.targetUri);
  } catch (e) {
    return { status: 500, body: { ok: false, error: (e as Error).message } };
  }
  const beforeContent = doc.getText();
  const baseline = snapshotForTarget(doc.uri.fsPath);
  const ok = await writeContent(doc, p.newContent);
  if (!ok) {
    return { status: 500, body: { ok: false, error: 'applyEdit failed', path: p.relPath } };
  }
  if (p.save) {
    await doc.save();
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  log.log(`apply confirmed (${source}) → ${p.relPath} [${p.mode}]`);
  const rec = recordApply({
    uri: p.targetUri,
    relPath: p.relPath,
    mode: p.mode,
    beforeContent,
    afterContent: p.newContent,
    baseline,
    targetPaths: [p.targetUri.fsPath, p.relPath],
    batchId: p.batchId,
    undoable: true,
  });
  return withDiff(
    {
      ok: true,
      applied: true,
      applyId: rec.id,
      previewApplyId: id,
      mode: p.mode,
      path: p.relPath,
      saved: p.save,
      message: `Applied ${p.mode} → ${p.relPath} — Ctrl+Z to undo`,
    },
    rec,
    {},
  );
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
 * New files can be previewed too: diff "empty" against the proposed
 * content, so nothing ever lands on disk without a look.
 * ------------------------------------------------------------------ */

async function performNewFilePreview(target: ResolvedTarget, payload: ApplyPayload, content: string): Promise<ApiResponse> {
  const cfg = getConfig();
  const id = makeId();
  const ext = path.extname(target.uri.fsPath) || '.txt';
  const beforeFile = path.join(os.tmpdir(), `chatsync-before-${id}${ext}`);
  const afterFile = path.join(os.tmpdir(), `chatsync-after-${id}${ext}`);
  const existedBefore = fs.existsSync(target.uri.fsPath);
  fs.writeFileSync(beforeFile, existedBefore ? fs.readFileSync(target.uri.fsPath, 'utf8') : '', 'utf8');
  fs.writeFileSync(afterFile, content, 'utf8');

  const timeoutMs = clamp(cfg.previewTimeoutSeconds, 10, 3600, 300) * 1000;
  const entry: PendingApply = {
    id,
    kind: 'newFile',
    batchId: payload.batchId,
    targetUri: target.uri,
    newContent: content,
    oldContent: existedBefore ? fs.readFileSync(target.uri.fsPath, 'utf8') : '',
    relPath: target.relPath,
    tmpUri: vscode.Uri.file(afterFile),
    beforeTmpUri: vscode.Uri.file(beforeFile),
    mode: 'newFile',
    save: true,
    expiresAt: Date.now() + timeoutMs,
    timer: setTimeout(() => {
      const p = pending.get(id);
      if (p) {
        cleanupPending(p);
        log.warn(`new-file preview ${id} expired`);
      }
    }, timeoutMs),
  };
  pending.set(id, entry);

  await vscode.commands.executeCommand(
    'vscode.diff',
    entry.beforeTmpUri!,
    entry.tmpUri,
    `${path.basename(target.uri.fsPath)} (does not exist) ↔ ChatSync new file`,
    { preview: true, preserveFocus: false },
  );

  const pick = await vscode.window.showInformationMessage(
    `ChatSync wants to create ${target.relPath}`,
    { modal: false },
    'Create file',
    'Discard',
  );
  if (pick === 'Create file') {
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
      mode: 'newFile',
      path: target.relPath,
      charsWritten: content.length,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      message: `New-file diff opened for ${target.relPath}. Confirm with POST /apply/confirm {"applyId":"${id}"}.`,
      endpoints: { confirm: '/apply/confirm', cancel: '/apply/cancel' },
    },
  };
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

  pruneExpiredRecords();

  const effectiveMode: ApplyMode = target.created ? 'newFile' : mode;
  // "auto": small in-workspace edits go straight in, everything risky gets a diff.
  const resolvedTargetIsNew = target.created && effectiveMode === 'newFile';
  const autoPreview = resolvedTargetIsNew || content.length > clamp(cfg.autoApplyMaxChars, 0, 200_000, 2500);
  const wantPreview =
    body.preview === 'auto' ? autoPreview : body.preview ?? cfg.applyMode === 'diff';
  log.log(`apply ${effectiveMode} → ${target.relPath} (${wantPreview ? 'preview' : 'direct'}, ${content.length} chars) ${body.label ? `[${body.label}]` : ''}`);

  let res: ApiResponse;
  if (wantPreview && effectiveMode === 'newFile') {
    res = await performNewFilePreview(target, { ...body, content }, content);
  } else if (wantPreview) {
    res = await performPreviewApply(target, effectiveMode, { ...body, content });
  } else {
    res = await performDirectApply(target, effectiveMode, { ...body, content });
  }

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
  const batchId = makeId();
  const results: unknown[] = [];
  for (const item of list) {
    const r = await handleApply({ ...req, body: { ...item, batchId } });
    results.push({
      path: item.path ?? (r.body as { path?: string }).path,
      status: r.status,
      body: r.body,
    });
  }
  const failed = results.filter((r) => (r as { status: number }).status !== 200).length;

  // aggregate the per-file error diffs so the chat can react once, not N times
  const rec = findRecord(undefined, batchId);
  let batchDiff: DiagnosticDiff | undefined;
  if (rec) {
    const paths = [...recordStore().values()].filter((r) => r.batchId === batchId);
    const targetPaths = paths.flatMap((r) => r.targetPaths);
    const before = paths.flatMap((r) => r.baseline);
    const settle = await settleDiagnostics(targetPaths, { minSeverity: 'Error' });
    batchDiff = makeDiffReport({
      targetPaths,
      before,
      after: settle.diagnostics,
      settled: settle.settled,
      waitedMs: settle.waitedMs,
      path: paths.map((r) => r.relPath).join(', '),
      mode: 'batch',
    });
    for (const r of paths) {
      r.lastDiff = batchDiff;
      r.settled = settle.settled;
    }
  }
  return {
    status: failed === 0 ? 200 : 207,
    body: {
      ok: failed === 0,
      batchId,
      count: results.length,
      failed,
      results,
      diagnosticsDiff: batchDiff,
    },
  };
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

export async function handleApplyErrors(req: ApiRequest): Promise<ApiResponse> {
  const q = req.url.searchParams;
  const body = (req.body ?? {}) as { applyId?: string; batchId?: string; wait?: boolean | string };
  const applyId = body.applyId ?? q.get('applyId') ?? q.get('id') ?? undefined;
  const batchId = body.batchId ?? q.get('batchId') ?? undefined;
  const rec = findRecord(applyId, batchId);
  if (!rec) {
    return {
      status: 404,
      body: { ok: false, error: 'unknown applyId/batchId — records live ~' + getConfig().autoApplyUndoWindowMinutes + ' minutes' },
    };
  }
  const waitRaw = body.wait ?? q.get('wait');
  const wait = waitRaw === undefined ? true : !/^(0|false|no)$/i.test(String(waitRaw));
  const baseline = rec.baseline;

  if (!wait && rec.lastDiff) {
    return { status: 200, body: { ok: true, applyId: rec.id, batchId: rec.batchId, cached: true, diagnosticsDiff: rec.lastDiff } };
  }

  const settle = await settleDiagnostics(rec.targetPaths, {
    stableMs: Number(body.batchId ?? q.get('settleMs')) || undefined,
    minSeverity: 'Error',
  });
  rec.settled = settle.settled;
  rec.waitedMs = settle.waitedMs;
  rec.finalDiagnostics = settle.diagnostics;
  const diff = makeDiffReport({
    targetPaths: rec.targetPaths,
    before: baseline,
    after: settle.diagnostics,
    settled: settle.settled,
    waitedMs: settle.waitedMs,
    path: rec.relPath,
    mode: rec.mode,
  });
  rec.lastDiff = diff;
  return { status: 200, body: { ok: true, applyId: rec.id, batchId: rec.batchId, path: rec.relPath, mode: rec.mode, diagnosticsDiff: diff } };
}

export async function handleApplyUndo(req: ApiRequest): Promise<ApiResponse> {
  const q = req.url.searchParams;
  const body = (req.body ?? {}) as { applyId?: string; batchId?: string };
  const batchId = body.batchId ?? q.get('batchId') ?? undefined;
  const applyId = body.applyId ?? q.get('applyId') ?? undefined;
  const recs = batchId ? findRecordsByBatch(batchId) : [];
  if (!recs.length && applyId) {
    const one = findRecord(applyId);
    if (one) {
      recs.push(one);
    }
  }
  if (!recs.length) {
    return {
      status: 404,
      body: { ok: false, error: `unknown or expired applyId/batchId (undo window is ${getConfig().autoApplyUndoWindowMinutes} minutes)` },
    };
  }
  if (recs.length === 1) {
    return undoRecord(recs[0], 'http');
  }
  const results = [];
  for (const rec of recs) {
    const r = await undoRecord(rec, 'http-batch');
    results.push({ path: rec.relPath, status: r.status, body: r.body });
  }
  const undone = results.filter((r) => (r.body as { undone?: boolean }).undone).length;
  return {
    status: 200,
    body: {
      ok: undone > 0,
      undone: true,
      batchId,
      count: results.length,
      undoneCount: undone,
      results,
      message: `Undoed ${undone}/${results.length} files from batch ${batchId}`,
    },
  };
}

export async function handleApplyHistory(_req: ApiRequest): Promise<ApiResponse> {
  pruneExpiredRecords();
  return { status: 200, body: { ok: true, count: recordStore().size, applies: listRecords() } };
}

/* ------------------------------------------------------------------ *
 * Optional, off-by-default power endpoints
 * ------------------------------------------------------------------ */

export async function handleRunCommand(req: ApiRequest): Promise<ApiResponse> {
  const cfg = getConfig();
  if (!cfg.allowRunCommand) {
    return { status: 403, body: { ok: false, error: 'chatsync.allowRunCommand is disabled' } };
  }
  const body = (req.body ?? {}) as { command?: string; args?: unknown[] };
  if (!body.command) {
    return { status: 400, body: { ok: false, error: 'missing command' } };
  }
  try {
    const result = await vscode.commands.executeCommand(body.command, ...(body.args ?? []));
    return { status: 200, body: { ok: true, command: body.command, result: result === undefined ? null : result } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: (e as Error).message } };
  }
}

export async function handleTerminal(req: ApiRequest): Promise<ApiResponse> {
  const cfg = getConfig();
  if (!cfg.allowTerminal) {
    return { status: 403, body: { ok: false, error: 'chatsync.allowTerminal is disabled' } };
  }
  const body = (req.body ?? {}) as { text?: string; name?: string; execute?: boolean };
  if (!body.text) {
    return { status: 400, body: { ok: false, error: 'missing text' } };
  }
  const term =
    vscode.window.terminals.find((t) => t.name === (body.name ?? 'ChatSync')) ??
    vscode.window.createTerminal({ name: body.name ?? 'ChatSync' });
  term.show(true);
  term.sendText(body.text, body.execute !== false);
  return { status: 200, body: { ok: true, sent: body.text, executed: body.execute !== false } };
}
