// Patch locator -- tiers 1..3. Tier 4 (block-anchor) is a TODO.
// Tier 1: exact indexOf(search)
// Tier 2: line-trimmed match (ignore leading/trailing whitespace per line)
// Tier 3: diff-match-patch fuzzy locate (drifts in surrounding context)
// Tier 4 (TODO): Cline-style first-line + last-line anchors with fuzzy middle.
import { diff_match_patch } from 'diff-match-patch'

export type Tier = 'exact' | 'line-trimmed' | 'fuzzy'

export interface LocateResult {
  offset: number
  length: number
  tier: Tier
}

export function locateExact(source: string, search: string): LocateResult | null {
  const idx = source.indexOf(search)
  if (idx < 0) return null
  return { offset: idx, length: search.length, tier: 'exact' }
}

export function locateLineTrimmed(source: string, search: string): LocateResult | null {
  const sLines = search.split('\n').map(l => l.trim()).filter(Boolean)
  if (sLines.length === 0) return null
  const srcLines = source.split('\n')
  for (let i = 0; i <= srcLines.length - sLines.length; i++) {
    let ok = true
    for (let j = 0; j < sLines.length; j++) {
      if (srcLines[i + j].trim() !== sLines[j]) { ok = false; break }
    }
    if (!ok) continue
    const pre = srcLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
    const chunk = srcLines.slice(i, i + sLines.length).join('\n')
    return { offset: pre, length: chunk.length, tier: 'line-trimmed' }
  }
  return null
}

export function locateFuzzy(source: string, search: string, expectedNear = 0): LocateResult | null {
  const dmp = new diff_match_patch()
  dmp.Match_Threshold = 0.6
  dmp.Match_Distance = Math.max(1000, source.length)
  const idx = dmp.match_main(source, search, expectedNear)
  if (idx < 0) return null
  const tailLen = Math.min(40, search.length)
  const tail = search.slice(-tailLen)
  const tailIdx = dmp.match_main(source.slice(idx), tail, 0)
  const end = tailIdx >= 0 ? idx + tailIdx + tailLen : idx + search.length
  return { offset: idx, length: Math.max(end - idx, search.length), tier: 'fuzzy' }
}

export function locate(source: string, search: string, expectedNear = 0): LocateResult | null {
  return (
    locateExact(source, search) ??
    locateLineTrimmed(source, search) ??
    locateFuzzy(source, search, expectedNear)
  )
}