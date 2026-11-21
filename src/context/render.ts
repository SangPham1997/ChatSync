// compose pstack from @-mentions. Policy (rules-once, sliding window, arg
// compaction) is INTENTIONALLY out of M3 -- plan §4 says that's user code.
import { parseMention, type ContextMention } from './taxonomy'
import { resolveAll, type RegistryOptions } from './registry'

export interface ComposeOptions extends RegistryOptions { maxBlocks?: number }

export interface ComposeResult {
  pstack: string
  mentions: ContextMention[]
  blocks: number
  dropped: number
}

export async function compose(input: string, opts: ComposeOptions): Promise<ComposeResult> {
  const mentions: ContextMention[] = []
  const promptLines: string[] = []
  for (const ln of input.split('\n')) {
    const m = parseMention(ln)
    if (m) mentions.push(m)
    else promptLines.push(ln)
  }
  const max = opts.maxBlocks ?? 5
  const wanted = mentions.slice(0, max)
  const dropped = mentions.length - wanted.length
  const blocks = await resolveAll(wanted, opts)
  return {
    pstack: [
      ...blocks.map(b => b.rendered),
      '',
      '### user prompt',
      promptLines.join('\n').trim(),
    ].join('\n'),
    mentions,
    blocks: blocks.length,
    dropped,
  }
}