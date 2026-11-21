// High-level pstack composer: rules-once + sliding window + arg compaction.
import { parseMention, type ContextMention } from './taxonomy'
import { resolveAll, type RegistryOptions } from './registry'
import { RulesOnceTracker, SlidingWindow, compactArgs, type Round } from './policy'

export interface ComposePolicyOptions extends RegistryOptions {
  maxBlocks?: number
  maxRounds?: number
  maxBlockChars?: number
  maxPromptChars?: number
}

export interface ComposePolicyResult {
  pstack: string
  blocks: number
  droppedBlocks: number
  rulesEmitted: number
  rulesSkipped: number
  roundsInWindow: number
  compactedBlocks: number
}

const DEF = { maxBlocks: 5, maxRounds: 5, maxBlockChars: 6000, maxPromptChars: 4000 }

export class PstackComposer {
  private rules = new RulesOnceTracker()
  private window: SlidingWindow
  private opts: Required<ComposePolicyOptions>

  constructor(opts: ComposePolicyOptions) {
    this.opts = {
      maxBlocks:      opts.maxBlocks      ?? DEF.maxBlocks,
      maxRounds:      opts.maxRounds      ?? DEF.maxRounds,
      maxBlockChars:  opts.maxBlockChars  ?? DEF.maxBlockChars,
      maxPromptChars: opts.maxPromptChars ?? DEF.maxPromptChars,
      repoRoot:       opts.repoRoot,
    }
    this.window = new SlidingWindow(this.opts.maxRounds)
  }

  async composeRound(input: string, roundId: string): Promise<ComposePolicyResult> {
    const mentions: ContextMention[] = []
    const promptLines: string[] = []
    for (const ln of input.split('\n')) {
      const m = parseMention(ln)
      if (m) mentions.push(m)
      else promptLines.push(ln)
    }
    const wanted = mentions.slice(0, this.opts.maxBlocks)
    const droppedBlocks = mentions.length - wanted.length
    const blocks = await resolveAll(wanted, { repoRoot: this.opts.repoRoot })

    let compactedBlocks = 0
    const rendered = blocks.map(b => {
      const out = compactArgs(b.rendered, this.opts.maxBlockChars)
      if (out !== b.rendered) compactedBlocks++
      return out
    })

    const rulesEmitted: string[] = []
    let rulesSkipped = 0
    for (const r of rendered) {
      const m = r.match(/^### skill:([^\n]+)/)
      if (m) {
        if (this.rules.isNew(m[1].trim(), r)) rulesEmitted.push(r)
        else rulesSkipped++
      } else {
        rulesEmitted.push(r)
      }
    }

    const userPrompt = compactArgs(promptLines.join('\n').trim(), this.opts.maxPromptChars)
    this.window.push({ id: roundId, userPrompt, contextMentions: mentions.map(m => JSON.stringify(m)) })
    const recent = this.window.getRecent()
    const windowSection = recent.length > 1
      ? '### recent rounds\n' + recent.slice(0, -1).map(r => `- [${r.id}] ${r.userPrompt.slice(0, 120)}`).join('\n') + '\n'
      : ''

    const pstack = [windowSection, ...rulesEmitted, '', '### user prompt', userPrompt]
      .filter(Boolean).join('\n')

    return {
      pstack, blocks: blocks.length, droppedBlocks,
      rulesEmitted: rulesEmitted.length, rulesSkipped,
      roundsInWindow: recent.length, compactedBlocks,
    }
  }

  resetSession(): void { this.rules.reset(); this.window.clear() }
}