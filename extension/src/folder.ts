import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApiRequest, ApiResponse } from './server';
import { getConfig } from './config';
import { clamp, truncate, workspaceRoot } from './util';
import { isPathAllowed } from './context';
import * as log from './logger';

type FolderMode = 'smart' | 'summary' | 'signatures' | 'full' | 'tree';

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', 'target',
  '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.vscode', 'reports',
  '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.nuxt', '_backups',
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tar|rar|7z|mp[34]|wav|flac|ogg|webm|mov|avi|woff2?|ttf|eot|otf|bin|exe|dll|so|dylib|class|jar|map|min\.js)$/i;

const TEST_EXT = /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt)$/i;
const CONFIG_NAME = /^(package\.json|tsconfig\.json|\.eslintrc.*|webpack\.config\.\w+|vite\.config\.\w+|rollup\.config\.\w+|\.gitignore|\.env\.example|README\.md|LICENSE|esbuild\.mjs)$/i;

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
  signatures?: string;
  truncated: boolean;
  skipped?: string;
  mtime: number;
  size: number;
  priority: number;
}

interface WalkState {
  files: FileEntry[];
  treeLines: string[];
  totalChars: number;
  filesSeen: number;
  truncated: boolean;
}

function safeStat(p: string): fs.Stats | undefined {
  try { return fs.statSync(p); } catch { return undefined; }
}

function extractSignatures(content: string, ext: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  const e = ext.toLowerCase();

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      if (/^(export\s+)?(async\s+)?(function|class|interface|type|enum)\s+\w+/.test(t) ||
          /^(export\s+)?(const|let|var)\s+\w+\s*[:=]/.test(t) ||
          /^export\s+\{/.test(t) ||
          /^export\s+default\s+/.test(t) ||
          /^(public|private|protected)\s+\w+\s*[:(]/.test(t)) {
        out.push(t);
      }
    }
  } else if (e === '.py') {
    for (const line of lines) {
      const t = line.trim();
      if (/^(class|def|async\s+def)\s+\w+/.test(t) || /^@\w+/.test(t)) out.push(t);
    }
  } else if (e === '.go') {
    for (const line of lines) {
      const t = line.trim();
      if (/^(func|type|var|const)\s+/.test(t)) out.push(t);
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const t = line.trim();
      if (/^(pub\s+)?(fn|struct|enum|trait|impl|type|const|static|mod)\s+/.test(t)) out.push(t);
    }
  } else {
    let count = 0;
    for (const line of lines) {
      if (line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('#')) {
        out.push(line);
        count++;
        if (count >= 15) break;
      }
    }
  }

  return out.length > 0 ? out.join('\n') : lines.slice(0, 10).join('\n');
}

function computePriority(f: FileEntry): number {
  let p = 0;
  const name = path.basename(f.path);
  if (CONFIG_NAME.test(name)) p += 100;
  if (TEST_EXT.test(name)) p -= 100;
  if (f.size > 0 && f.size < 5000) p += 20;
  else if (f.size > 50000) p -= 20;
  if (f.mtime > 0) {
    const daysOld = (Date.now() - f.mtime) / (1000 * 60 * 60 * 24);
    if (daysOld < 1) p += 50;
    else if (daysOld < 7) p += 20;
  }
  if (/^(index|main|app|server|extension)\.\w+$/i.test(name)) p += 80;
  return p;
}

function decideMode(f: FileEntry, mode: FolderMode): 'tree' | 'signatures' | 'summary' | 'full' {
  if (mode === 'tree') return 'tree';
  if (mode === 'full') return 'full';
  if (mode === 'signatures') return 'signatures';
  if (mode === 'summary') return 'summary';

  const name = path.basename(f.path);
  if (TEST_EXT.test(name)) return 'tree';
  if (CONFIG_NAME.test(name)) return 'full';
  if (f.size > 15000) return 'signatures';
  return 'summary';
}

function walkFolder(absDir: string, relDir: string, depth: number, maxDepth: number, opts: {
  ignore: Set<string>;
  maxFiles: number;
  maxChars: number;
  perFileMax: number;
  mode: FolderMode;
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
    const st = safeStat(abs);
    if (!st) continue;

    if (st.isDirectory()) {
      state.treeLines.push(`${pad}DIR  ${name}/`);
      walkFolder(abs, rel, depth + 1, maxDepth, opts, state);
    } else if (st.isFile()) {
      state.filesSeen++;
      const ext = path.extname(name).toLowerCase();
      const lang = LANG_OF[ext] || 'text';
      const entry: FileEntry = {
        path: rel, language: lang, chars: 0, truncated: false,
        mtime: st.mtimeMs, size: st.size, priority: 0,
      };

      if (BINARY_EXT.test(name)) {
        entry.skipped = 'binary';
        state.treeLines.push(`${pad}FILE ${name} (binary)`);
        state.files.push(entry);
        continue;
      }

      const decision = decideMode(entry, opts.mode);
      entry.priority = computePriority(entry);

      if (decision === 'tree') {
        entry.skipped = 'tree-only';
        state.treeLines.push(`${pad}FILE ${name} (${Math.round(st.size / 1024)} KB)`);
        state.files.push(entry);
        continue;
      }

      let raw: string;
      try { raw = fs.readFileSync(abs, 'utf8'); }
      catch (e) {
        entry.skipped = `read error: ${(e as Error).message}`;
        state.treeLines.push(`${pad}FILE ${name} (read error)`);
        state.files.push(entry);
        continue;
      }
      entry.chars = raw.length;

      let payload: string;
      if (decision === 'signatures') {
        payload = extractSignatures(raw, ext);
        entry.signatures = payload;
      } else if (decision === 'summary') {
        const headLines = raw.split('\n').slice(0, 30).join('\n');
        const sigs = extractSignatures(raw, ext);
        payload = `// head (first 30 lines):\n${headLines}\n\n// signatures:\n${sigs}`;
      } else {
        const t = truncate(raw, opts.perFileMax);
        payload = t.text;
        entry.truncated = t.truncated;
      }

      if (payload.length > opts.perFileMax) {
        payload = payload.slice(0, opts.perFileMax) + '\n// [...truncated...]';
        entry.truncated = true;
      }

      const treeUsed = state.treeLines.join('\n').length;
      const remaining = opts.maxChars - state.totalChars - treeUsed;
      if (payload.length > remaining) {
        if (remaining < 500) {
          entry.skipped = 'budget exhausted';
          state.truncated = true;
          state.treeLines.push(`${pad}FILE ${name} (budget exhausted)`);
          state.files.push(entry);
          continue;
        }
        payload = payload.slice(0, remaining) + '\n// [...budget...]';
        entry.truncated = true;
        state.truncated = true;
      }
      entry.content = payload;
      state.totalChars += payload.length;
      state.treeLines.push(`${pad}FILE ${name} (${raw.length} chars -> ${payload.length} sent)`);
      state.files.push(entry);
    }
  }
}

function buildContextText(rootRel: string, state: WalkState, mode: FolderMode): string {
  const lines: string[] = [];
  lines.push(`## Folder: ${rootRel || '.'}`);
  lines.push('');
  lines.push(`- mode: \`${mode}\``);
  const withContent = state.files.filter((f) => f.content && !f.skipped);
  const codeCount = state.files.filter((f) => !f.skipped).length;
  lines.push(`- files: ${withContent.length} with content / ${codeCount} code / ${state.files.length} scanned`);
  lines.push(`- total chars: ${state.totalChars}`);
  if (state.truncated) lines.push('- **truncated** (char budget exhausted)');
  lines.push('');
  lines.push('### Tree');
  lines.push('```');
  lines.push(...state.treeLines);
  lines.push('```');

  for (const f of withContent) {
    const header = f.signatures
      ? `### ${f.path} (signatures, ${f.chars} chars source)`
      : `### ${f.path} (${f.chars} chars${f.truncated ? ', truncated' : ''})`;
    lines.push('');
    lines.push(header);
    lines.push('```' + f.language);
    lines.push(f.content!);
    lines.push('```');
  }
  return lines.join('\n');
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
  const modeParam = (q.get('mode') ?? 'smart').toLowerCase();
  const validModes: FolderMode[] = ['smart', 'summary', 'signatures', 'full', 'tree'];
  const mode: FolderMode = validModes.includes(modeParam as FolderMode) ? (modeParam as FolderMode) : 'smart';
  const maxFiles = clamp(Number(q.get('maxFiles') ?? 50), 1, 200, 50);
  const globalChars = clamp(Number(q.get('maxChars') ?? cfg.maxContextChars), 1000, 500000, cfg.maxContextChars);
  const perFileMax = clamp(Number(q.get('perFileMax') ?? 40000), 500, 200000, 40000);
  const userIgnore = (q.get('ignore') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ignore = new Set<string>([...DEFAULT_IGNORE, ...userIgnore]);

  const relNormalized = path.relative(root, abs).split(path.sep).join('/');
  const state: WalkState = { files: [], treeLines: [`DIR  ${relNormalized}/`], totalChars: 0, filesSeen: 0, truncated: false };
  walkFolder(abs, '', 1, depth, { ignore, maxFiles, maxChars: globalChars, perFileMax, mode }, state);

  const withContent = state.files.filter((f) => f.content);
  const without = state.files.filter((f) => !f.content);
  state.files = [...withContent.sort((a, b) => b.priority - a.priority), ...without];

  const contextText = buildContextText(relNormalized, state, mode);
  log.log(`folder ${relNormalized} mode=${mode} depth=${depth} files=${state.files.length} chars=${state.totalChars}${state.truncated ? ' [truncated]' : ''}`);

  return {
    status: 200,
    body: {
      ok: true,
      root: relNormalized,
      mode,
      depth,
      fileCount: state.files.length,
      filesWithContent: state.files.filter((f) => f.content).length,
      totalChars: state.totalChars,
      truncated: state.truncated,
      tree: state.treeLines.join('\n'),
      files: state.files.map((f) => ({
        path: f.path, language: f.language, chars: f.chars,
        sent: f.content ? f.content.length : 0,
        truncated: f.truncated, skipped: f.skipped,
      })),
      contextText,
    },
  };
}