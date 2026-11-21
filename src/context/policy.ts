// Policy layer for compose pstack. Rules-once, sliding window, arg compaction.

export interface Round {
  id: string
  userPrompt: string
  contextMentions: string[]
}

export class RulesOnceTracker {
  private seen = new Set<string>()
  private hash(s: string): string {
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return h.toString(36)
  }
  isNew(id: string, body: string): boolean {
    const key = `${id}::${this.hash(body)}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
  reset(): void { this.seen.clear() }
  get size(): number { return this.seen.size }
}

export class SlidingWindow {
  private rounds: Round[] = []
  constructor(private readonly maxRounds: number = 5) {}
  push(r: Round): void {
    this.rounds.push(r)
    if (this.rounds.length > this.maxRounds) this.rounds.shift()
  }
  getRecent(n?: number): Round[] {
    return this.rounds.slice(-(n ?? this.maxRounds))
  }
  clear(): void { this.rounds = [] }
  get size(): number { return this.rounds.length }
}

export function compactArgs(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n... (compacted) ...\n'
  if (maxChars <= marker.length) return text.slice(0, maxChars)
  const headLen = Math.floor((maxChars - marker.length) * 0.6)
  const tailLen = maxChars - marker.length - headLen
  return text.slice(0, headLen) + marker + text.slice(-tailLen)
}