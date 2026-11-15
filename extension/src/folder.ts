import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApiRequest, ApiResponse } from './server';
import { getConfig } from './config';
import { clamp, truncate, workspaceRoot  } from './util';
import { isPathAllowed } from './context';
import * as log from './logger';

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', 'target',
  '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.vscode', 'reports',
  '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.nuxt', '_backups',
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tar|rar|7z|mp[34]|wav|flac|ogg|webm|mov|avi|woff2?|ttf|eot|otf|bin|exe|dll|so|dylib|class|jar|map|min\.js)$/i;

const LANG_OF: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.php': 'php',
  '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro',
  '.sh': 'shellscript', '.bash': 'shellscript', '.ps1': 'powershell',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
};

interface FileEntry {
  path: string;
  language: string;
  chars: number;
  content?: string;
  truncated: boolean;
  skipped?: string;
}

interface WalkState {
  files: FileEntry[];
  treeLines: string[];
  totalChars: number;
  filesSeen: number;
  truncated: boolean;
}

function safeLstat(p: string): fs.Stats | undefined {
  try { return fs.lstatSync(p); } catch { return undefined; }
}

function walkFolder(absDir: string, relDir: string, depth: number, maxDepth: number, opts: {
  ignore: Set<string>;
  maxFiles: number;
  maxChars: number;
  includeContent: boolean;
  perFileMax: number;
}, state: WalkState): void {
  if (depth > maxDepth || state.filesSeen >= opts.maxFiles || state.truncated) return;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { log.warn(`folder walk: cannot read ${absDir}: ${(e as Error).message}`); return; }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const pad = '  '.repeat(depth);
  for (const ent of entries) {
    if (state.filesSeen >= opts.maxFiles || state.truncated) return;
    const name = ent.name;
    if (opts.ignore.has(name)) continue;
    if (name.startsWith('.') && name !== '.env.example') continue;
    if (ent.isSymbolicLink()) continue;
    if (/\.bak(-|$)/.test(name)) continue;

    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    const st = safeLstat(abs);
    if (!st) continue;

    if (st.isDirectory()) {
      state.treeLines.push(`${pad}DIR  ${name}/`);
      walkFolder(abs, rel, depth + 1, maxDepth, opts, state);
    } else if (st.isFile()) {
      state.filesSeen++;
      const ext = path.extname(name).toLowerCase();
      const lang = LANG_OF[ext] || 'text';
      const entry: FileEntry = { path: rel, language: lang, chars: 0, truncated: false };

      if (BINARY_EXT.test(name)) {
        entry.skipped = 'binary';
        state.treeLines.push(`${pad}FILE ${name} (binary)`);
      } else if (!opts.includeContent) {
        entry.skipped = 'content disabled';
        state.treeLines.push(`${pad}FILE ${name}`);
      } else if (st.size > opts.perFileMax * 4) {
        entry.skipped = `too large (${Math.round(st.size / 1024)} KB)`;
        state.treeLines.push(`${pad}FILE ${name} (${Math.round(st.size / 1024)} KB, skipped)`);
      } else {
        let raw: string;
        try { raw = fs.readFileSync(abs, 'utf8'); }
        catch (e) {
          entry.skipped = `read error: ${(e as Error).message}`;
          state.treeLines.push(`${pad}FILE ${name} (read error)`);
          state.files.push(entry);
          continue;
        }
        const t = truncate(raw, opts.perFileMax);
        entry.content = t.text;
        entry.chars = raw.length;
        entry.truncated = t.truncated;

        const treeUsed = state.treeLines.join('\n').length;
        const remaining = opts.maxChars - state.totalChars - treeUsed;
        if (entry.content.length > remaining) {
          if (remaining < 500) {
            entry.skipped = 'budget exhausted';
            entry.content = undefined;
            state.truncated = true;
            state.files.push(entry);
            state.treeLines.push(`${pad}FILE ${name} (budget exhausted)`);
            continue;
          }
          entry.content = entry.content.slice(0, remaining) + '\n\n[...ChatSync: truncated...]';
          entry.truncated = true;
          state.truncated = true;
        }
        state.totalChars += entry.content.length;
        state.treeLines.push(`${pad}FILE ${name} (${entry.chars} chars)`);
      }
      state.files.push(entry);
    }
  }
}

function buildContextText(rootRel: string, state: WalkState): string {
  const lines: string[] = [];
  lines.push(`## Folder: ${rootRel || '.'}`);
  lines.push('');
  lines.push(`- files: ${state.files.filter((f) => f.content).length} with content / ${state.files.length} scanned`);
  lines.push(`- total chars: ${state.totalChars}`);
  if (state.truncated) lines.push('- **truncated** (char budget exhausted)');
  lines.push('');
  lines.push('### Tree');
  lines.push('```');
  lines.push(...state.treeLines);
  lines.push('```');
  for (const f of state.files) {
    if (!f.content) continue;
    lines.push('');
    lines.push(`### ${f.path} (${f.chars} chars${f.truncated ? ', truncated' : ''})`);
    lines.push('```' + f.language);
    lines.push(f.content);
    lines.push('```');
  }
  return lines.join('\n');
}

function parseBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export async function handleFolderContent(req: ApiRequest): Promise<ApiResponse> {
  const cfg = getConfig();
  const q = req.url.searchParams;
  const relPath = (q.get('path') ?? '').trim();
  if (!relPath) {
    return { status: 400, body: { ok: false, error: 'missing "path" query parameter' } };
  }
  const root = workspaceRoot();
  if (!root) {
    return { status: 400, body: { ok: false, error: 'no workspace folder open' } };
  }
  const abs = path.resolve(root, relPath);
  if (!isPathAllowed(vscode.Uri.file(abs))) {
    return { status: 403, body: { ok: false, error: 'path is outside the workspace (blocked by chatsync containment)' } };
  }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { status: 404, body: { ok: false, error: `not found: ${relPath}` } }; }
  if (!st.isDirectory()) {
    return { status: 400, body: { ok: false, error: `not a directory: ${relPath}` } };
  }

  const depth = clamp(Number(q.get('depth') ?? 2), 0, 5, 2);
  const includeContent = parseBool(q.get('includeContent') ?? q.get('content'), true);
  const maxFiles = clamp(Number(q.get('maxFiles') ?? 50), 1, 200, 50);
  const globalChars = clamp(Number(q.get('maxChars') ?? cfg.maxContextChars), 1000, 500000, cfg.maxContextChars);
  const perFileMax = clamp(Number(q.get('perFileMax') ?? 40000), 500, 200000, 40000);
  const userIgnore = (q.get('ignore') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ignore = new Set<string>([...DEFAULT_IGNORE, ...userIgnore]);

  const relNormalized = path.relative(root, abs).split(path.sep).join('/');
  const state: WalkState = { files: [], treeLines: [`DIR  ${relNormalized}/`], totalChars: 0, filesSeen: 0, truncated: false };
  walkFolder(abs, '', 1, depth, { ignore, maxFiles, maxChars: globalChars, includeContent, perFileMax }, state);

  const contextText = buildContextText(relNormalized, state);
  log.log(`folder ${relNormalized} depth=${depth} files=${state.files.length} chars=${state.totalChars}${state.truncated ? ' [truncated]' : ''}`);

  return {
    status: 200,
    body: {
      ok: true,
      root: relNormalized,
      depth,
      fileCount: state.files.length,
      filesWithContent: state.files.filter((f) => f.content).length,
      totalChars: state.totalChars,
      truncated: state.truncated,
      tree: state.treeLines.join('\n'),
      files: state.files.map((f) => ({ path: f.path, language: f.language, chars: f.chars, truncated: f.truncated, skipped: f.skipped })),
      contextText,
    },
  };
}