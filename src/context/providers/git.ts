import type { ContextBlock, ContextMention } from '../taxonomy'
import { unifiedDiff } from '../../git/diff'

export async function provideGit(
  mention: Extract<ContextMention, { kind: 'git' }>,
  repoRoot: string
): Promise<ContextBlock | null> {
  const diff = await unifiedDiff(repoRoot, mention.range).catch(() => '')
  if (!diff.trim()) return null
  const trimmed = diff.length > 8000 ? diff.slice(0, 8000) + '\n... (truncated)' : diff
  return {
    mention,
    rendered: `### @git${mention.range ? ':' + mention.range : ''}\n\`\`\`diff\n${trimmed}\n\`\`\``,
  }
}