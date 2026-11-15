import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/* ------------------------------------------------------------------ *
 * Settings helpers
 * ------------------------------------------------------------------ */

export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

export function relToWorkspace(fsPath: string): string {
  const root = workspaceRoot();
  if (!root) {
    return fsPath;
  }
  const rel = path.relative(root, fsPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : fsPath;
}

/* ------------------------------------------------------------------ *
 * Token: stable per machine+user, no network, no plaintext secrets
 * ------------------------------------------------------------------ */

export function deriveToken(seed: string): string {
  // Deterministic, dependency-free hash (FNV-1a 64-ish, base32 encoded).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(code + i, 0x85ebca6b)) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    h2 = Math.imul(h2, 0xc2b2ae35) >>> 0;
  }
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const body = (h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let out = '';
  for (let i = 0; out.length < 16; i++) {
    const c = body[i % body.length] ?? alphabet[(h1 + h2 + i * 7) % alphabet.length];
    out += alphabet.includes(c) ? c : alphabet[(c.charCodeAt(0) + i) % alphabet.length];
    if (out.length === 4 || out.length === 9 || out.length === 14) {
      out += '-';
    }
  }
  return 'CS-' + out.replace(/-$/, '');
}

let cachedToken: string | undefined;

export function getToken(explicit: string): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  if (cachedToken) {
    return cachedToken;
  }
  let seed = `${os.hostname()}|${os.userInfo().username}|${process.platform}`;
  try {
    // Stable per-user random salt so the token is not guessable from hostname alone.
    const dir = path.join(os.homedir(), '.chatsync');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'token.seed');
    if (fs.existsSync(file)) {
      seed += '|' + fs.readFileSync(file, 'utf8').trim();
    } else {
      const rnd = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(file, rnd, { mode: 0o600 });
      seed += '|' + rnd;
    }
  } catch {
    seed += '|' + Math.random().toString(36);
  }
  cachedToken = deriveToken(seed);
  return cachedToken;
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

const EOL_MAP: Record<string, string> = { '\n': '\n', '\r\n': '\r\n', '\r': '\r' };

export function eolOf(doc: vscode.TextDocument): string {
  return EOL_MAP[doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'] ?? '\n';
}

/** Convert \r\n / \r in incoming code to the document's EOL. */
export function normalizeEol(text: string, eol: string): string {
  return text.replace(/\r\n|\r/g, '\n').replace(/\n/g, eol);
}

export function stripFence(text: string): { code: string; language?: string; pathHint?: string } {
  let code = text.replace(/\r\n/g, '\n');
  let language: string | undefined;
  let pathHint: string | undefined;

  const fence = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/;
  const m = fence.exec(code.trim());
  if (m) {
    const info = m[1].trim();
    code = m[2];
    const parts = info.split(/\s+/);
    language = parts[0] || undefined;
    const rest = parts.slice(1).join(' ').trim();
    if (rest) {
      pathHint = rest.replace(/^file:?\s*/i, '').trim();
    }
  }

  // `// path/to/file.ts` or `# path/to/file.py` as first line
  const firstLine = code.split('\n')[0] ?? '';
  const cm = /^\s*(?:\/\/|#|<!--|;)\s*(?:file\s*[:=]\s*)?([^\s:*?"<>|]+\.[A-Za-z0-9]{1,8})\s*(?:-->)?\s*$/.exec(firstLine);
  if (cm && code.split('\n').length > 1) {
    pathHint = pathHint ?? cm[1];
    code = code.split('\n').slice(1).join('\n');
  }

  return { code, language, pathHint };
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0 || text.length <= max) {
    return { text, truncated: false };
  }
  const head = Math.floor(max * 0.8);
  const tail = max - head - 60;
  const cut = tail > 200 ? text.slice(-tail) : '';
  return {
    text: `${text.slice(0, head)}\n\n/* ...ChatSync: truncated ${text.length - head - cut.length} chars... */\n\n${cut}`,
    truncated: true,
  };
}

export function clamp(n: unknown, min: number, max: number, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : dflt;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

export function positionOf(doc: vscode.TextDocument, line: number, char: number): vscode.Position {
  const l = clamp(line, 1, doc.lineCount, 1) - 1;
  const lineText = doc.lineAt(l).text;
  const c = clamp(char, 1, lineText.length + 1, 1) - 1;
  return new vscode.Position(l, c);
}
