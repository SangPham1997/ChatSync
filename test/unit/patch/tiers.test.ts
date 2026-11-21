import { describe, it, expect } from 'vitest'
import { locateExact, locateLineTrimmed, locateFuzzy, locate } from '../../../src/patch/locate'

const SRC = `function add(a: number, b: number) {\n  return a + b\n}\n`

describe('locate tiers', () => {
  it('tier 1 exact hits', () => {
    const r = locateExact(SRC, 'return a + b')!
    expect(r.tier).toBe('exact')
    expect(SRC.slice(r.offset, r.offset + r.length)).toBe('return a + b')
  })

  it('tier 2 tolerates whitespace', () => {
    const r = locateLineTrimmed(SRC, '   return a + b   ')!
    expect(r.tier).toBe('line-trimmed')
  })

  it('tier 3 fuzzy tolerates drift', () => {
    const drifted = SRC.replace('a + b', 'a  +  b')   // extra spaces
    const r = locateFuzzy(drifted, 'return a + b')!
    expect(r.tier).toBe('fuzzy')
  })

  it('cascade picks first hit', () => {
    const r = locate(SRC, 'return a + b')!
    expect(r.tier).toBe('exact')
  })

  it('returns null when nowhere', () => {
    expect(locate(SRC, 'never appears anywhere')).toBeNull()
  })
})