// M1 skills loader -- gray-matter + dual-root (.chatsync/skills + .agents/skills)
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'

export interface SkillDoc {
  id: string
  source: 'chatsync' | 'agents'
  rootPath: string
  meta: Record<string, unknown>
  body: string
}

const ROOTS: Array<{ source: SkillDoc['source']; path: string }> = [
  { source: 'chatsync', path: '.chatsync/skills' },
  { source: 'agents',   path: '.agents/skills' },
]

export function loadSkills(repoRoot: string): SkillDoc[] {
  const out: SkillDoc[] = []
  for (const r of ROOTS) {
    const abs = join(repoRoot, r.path)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry)
      if (!statSync(full).isFile() || !entry.endsWith('.md')) continue
      const parsed = matter(readFileSync(full, 'utf8'))
      out.push({
        id: entry.replace(/\.md$/, ''),
        source: r.source,
        rootPath: full,
        meta: parsed.data as Record<string, unknown>,
        body: parsed.content,
      })
    }
  }
  return out
}