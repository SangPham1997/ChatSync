import type { ContextBlock, ContextMention } from './taxonomy'
import { provideFile } from './providers/file'
import { provideFolder } from './providers/folder'
import { provideProblems } from './providers/problems'
import { provideTerminal } from './providers/terminal'
import { provideGit } from './providers/git'

export interface RegistryOptions { repoRoot: string }

export async function resolveMention(
  mention: ContextMention,
  opts: RegistryOptions
): Promise<ContextBlock | null> {
  switch (mention.kind) {
    case 'file':     return provideFile(mention)
    case 'folder':   return provideFolder(mention)
    case 'problems': return provideProblems(mention)
    case 'terminal': return provideTerminal(mention)
    case 'git':      return provideGit(mention, opts.repoRoot)
  }
}

export async function resolveAll(
  mentions: ContextMention[],
  opts: RegistryOptions
): Promise<ContextBlock[]> {
  const out: ContextBlock[] = []
  for (const m of mentions) {
    const b = await resolveMention(m, opts)
    if (b) out.push(b)
  }
  return out
}