import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApiRequest, ApiResponse } from './server';
import { workspaceRoot } from './util';
import { buildActiveFileContext, collectDiagnostics } from './context';
import { handleFolderContent } from './folder';
import * as log from './logger';

export type SkillApplyMode = 'replace' | 'patch' | 'insert' | 'replaceSelection' | 'append' | 'newFile';

export interface SkillAttach {
  kind: 'active-file' | 'diagnostics' | 'folder' | 'file' | 'tabs';
  arg?: string;
  depth?: number;
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  trigger?: string;
  applyMode?: SkillApplyMode;
  attach: SkillAttach[];
  body: string;
  path: string;
  mtime: number;
}

let cache: { skills: Skill[]; at: number } | undefined;
const CACHE_TTL_MS = 5000;
const SKILLS_DIR_REL = '.chatsync/skills';

export function skillsDir(): string | undefined {
  const root = workspaceRoot();
  return root ? path.join(root, SKILLS_DIR_REL) : undefined;
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { meta: {}, body: normalized };
  const fm = normalized.slice(4, end);
  const body = normalized.slice(end + 5).replace(/^\n+/, '');
  const meta: Record<string, unknown> = {};
  const lines = fm.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const val = m[2].trim();
    if ((val === '|' || val === '>') && i + 1 < lines.length) {
      const fold = val === '>';
      const indent0 = ((lines[i + 1].match(/^(\s*)/) || ['', ''])[1] as string).length;
      const block: string[] = [];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.length === 0) { block.push(''); i++; continue; }
        const ind = ((ln.match(/^(\s*)/) || ['', ''])[1] as string).length;
        if (ind < indent0) break;
        block.push(ln.slice(indent0));
        i++;
      }
      meta[key] = fold ? block.join(' ').trim() : block.join('\n').trim();
      continue;
    }
    if (val === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      const list: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        list.push(lines[i].replace(/^\s*-\s+/, '').trim());
        i++;
      }
      meta[key] = list;
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = val;
    }
    i++;
  }
  return { meta, body };
}

function parseAttach(list: string[]): SkillAttach[] {
  const out: SkillAttach[] = [];
  for (const raw of list) {
    const s = raw.trim();
    if (s === 'active-file') { out.push({ kind: 'active-file' }); continue; }
    if (s === 'tabs') { out.push({ kind: 'tabs' }); continue; }
    const mDiag = /^diagnostics(?::(\w+))?$/.exec(s);
    if (mDiag) { out.push({ kind: 'diagnostics', arg: mDiag[1] || 'error' }); continue; }
    const mFolder = /^folder:(\S+)(?:\s+depth=(\d+))?$/.exec(s);
    if (mFolder) { out.push({ kind: 'folder', arg: mFolder[1], depth: mFolder[2] ? parseInt(mFolder[2], 10) : 2 }); continue; }
    const mFile = /^file:(.+)$/.exec(s);
    if (mFile) { out.push({ kind: 'file', arg: mFile[1].trim() }); continue; }
    log.warn(`skill: unknown attach directive "${s}"`);
  }
  return out;
}

export function loadSkills(force = false): Skill[] {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.skills;
  const dir = skillsDir();
  if (!dir || !fs.existsSync(dir)) {
    cache = { skills: [], at: now };
    return [];
  }
  const skills: Skill[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { entries = []; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(dir, name);
    let raw: string;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const slug = name.replace(/\.md$/, '');
    const attachRaw = Array.isArray(meta.attach) ? (meta.attach as string[]) : [];
    const stat = fs.statSync(abs);
    skills.push({
      slug,
      name: (meta.name as string) || slug,
      description: (meta.description as string) || '',
      trigger: (meta.trigger as string) || undefined,
      applyMode: (meta.applyMode as SkillApplyMode) || undefined,
      attach: parseAttach(attachRaw),
      body,
      path: abs,
      mtime: stat.mtimeMs,
    });
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  cache = { skills, at: now };
  return skills;
}

async function resolveAttachment(att: SkillAttach): Promise<{ kind: string; text: string } | undefined> {
  if (att.kind === 'active-file') {
    const info = buildActiveFileContext({ includeContent: true, includeDiagnostics: false });
    if (!info.hasEditor) return undefined;
    return { kind: 'active-file', text: info.contextText || '' };
  }
  if (att.kind === 'diagnostics') {
    const minSev = (att.arg || 'error').toLowerCase();
    const sevMap: Record<string, string> = { error: 'Error', warning: 'Warning', info: 'Information', hint: 'Hint' };
    const minSeverity = sevMap[minSev] || 'Error';
    const diags = collectDiagnostics({ minSeverity, limit: 200 });
    if (!diags.length) return undefined;
    const text = `## Problems (${diags.length})\n\n` + diags.map((d) => `- [${d.severity}] ${d.file}:${d.line}:${d.character} ${d.message}`).join('\n');
    return { kind: 'diagnostics', text };
  }
  if (att.kind === 'folder') {
    const fakeReq = { url: new URL(`http://x/folder?path=${encodeURIComponent(att.arg || '')}&depth=${att.depth ?? 2}`) } as unknown as ApiRequest;
    const res = await handleFolderContent(fakeReq);
    if (res.status !== 200) return undefined;
    const body = res.body as { contextText?: string };
    return { kind: 'folder', text: body.contextText || '' };
  }
  if (att.kind === 'file') {
    const target = att.arg || '';
    if (!target) return undefined;
    try {
      const root = workspaceRoot();
      if (!root) return undefined;
      const abs = path.resolve(root, target);
      if (!fs.existsSync(abs)) return undefined;
      const content = fs.readFileSync(abs, 'utf8');
      const lang = path.extname(abs).replace('.', '') || 'text';
      return { kind: 'file', text: `### File: ${target}\n\n\`\`\`${lang}\n${content}\n\`\`\`` };
    } catch { return undefined; }
  }
  if (att.kind === 'tabs') {
    const tabs: string[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input instanceof vscode.TabInputText) {
          tabs.push(t.label);
        }
      }
    }
    if (!tabs.length) return undefined;
    return { kind: 'tabs', text: `## Open tabs (${tabs.length})\n\n` + tabs.map((n) => `- ${n}`).join('\n') };
  }
  return undefined;
}

export async function handleSkillsList(_req: ApiRequest): Promise<ApiResponse> {
  const skills = loadSkills();
  return {
    status: 200,
    body: {
      ok: true,
      count: skills.length,
      dir: skillsDir(),
      skills: skills.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        trigger: s.trigger,
        applyMode: s.applyMode,
        attach: s.attach.map((a) => `${a.kind}${a.arg ? ':' + a.arg : ''}${a.depth !== undefined ? ' depth=' + a.depth : ''}`),
      })),
    },
  };
}

export async function handleSkillsGet(req: ApiRequest): Promise<ApiResponse> {
  const q = req.url.searchParams;
  const slug = (q.get('slug') || '').trim();
  if (!slug) {
    return { status: 400, body: { ok: false, error: 'missing "slug" query parameter' } };
  }
  const raw = q.get('raw') === '1' || q.get('raw') === 'true';
  const skills = loadSkills();
  const skill = skills.find((s) => s.slug === slug);
  if (!skill) {
    return { status: 404, body: { ok: false, error: `skill "${slug}" not found` } };
  }
  if (raw) {
    return {
      status: 200,
      body: {
        ok: true,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        trigger: skill.trigger,
        applyMode: skill.applyMode,
        body: skill.body,
        attach: skill.attach,
      },
    };
  }
  const parts: string[] = [];
  parts.push(`# Skill: ${skill.name}`);
  if (skill.description) parts.push(`_${skill.description}_`);
  parts.push('');
  parts.push(skill.body);
  const sources: { kind: string; text: string }[] = [];
  for (const a of skill.attach) {
    try {
      const r = await resolveAttachment(a);
      if (r && r.text) sources.push(r);
    } catch (e) {
      log.warn(`skill ${slug}: attach ${a.kind} failed: ${(e as Error).message}`);
    }
  }
  if (sources.length) {
    parts.push('');
    parts.push('---');
    for (const s of sources) {
      parts.push('');
      parts.push(s.text);
    }
  }
  let combinedText = parts.join('\n');
  const MAX_COMBINED = 200_000;
  if (combinedText.length > MAX_COMBINED) {
    log.warn(`skill ${slug}: combinedText ${combinedText.length} > ${MAX_COMBINED}, truncated`);
    combinedText = combinedText.slice(0, MAX_COMBINED) + '\n\n[...ChatSync: combined text truncated at ' + MAX_COMBINED + ' chars...]';
  }
  return {
    status: 200,
    body: {
      ok: true,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      applyMode: skill.applyMode,
      attachResolved: sources.length,
      attachRequested: skill.attach.length,
      combinedText,
    },
  };
}

export async function handleSkillsReload(_req: ApiRequest): Promise<ApiResponse> {
  cache = undefined;
  const skills = loadSkills(true);
  log.log(`skills reloaded: ${skills.length} skill(s)`);
  return { status: 200, body: { ok: true, count: skills.length, skills: skills.map((s) => s.slug) } };
}

export function discardSkillsCache(): void {
  cache = undefined;
}