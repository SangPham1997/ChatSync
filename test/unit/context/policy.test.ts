import { describe, it, expect } from 'vitest'
import { RulesOnceTracker, SlidingWindow, compactArgs } from '../../../src/context/policy'

describe('RulesOnceTracker', () => {
  it('emits first, skips second', () => {
    const t = new RulesOnceTracker()
    expect(t.isNew('a', 'body')).toBe(true)
    expect(t.isNew('a', 'body')).toBe(false)
  })
  it('same id different body -> new', () => {
    const t = new RulesOnceTracker()
    expect(t.isNew('a', 'b1')).toBe(true)
    expect(t.isNew('a', 'b2')).toBe(true)
  })
  it('reset clears', () => {
    const t = new RulesOnceTracker()
    t.isNew('x', 'y'); t.reset()
    expect(t.isNew('x', 'y')).toBe(true)
  })
})

describe('SlidingWindow', () => {
  it('keeps last N', () => {
    const w = new SlidingWindow(2)
    w.push({ id:'a', userPrompt:'1', contextMentions:[] })
    w.push({ id:'b', userPrompt:'2', contextMentions:[] })
    w.push({ id:'c', userPrompt:'3', contextMentions:[] })
    expect(w.size).toBe(2)
    expect(w.getRecent().map(r => r.id)).toEqual(['b','c'])
  })
})

describe('compactArgs', () => {
  it('noop when short', () => { expect(compactArgs('hi', 100)).toBe('hi') })
  it('truncates with head+tail', () => {
    const long = 'A'.repeat(200) + 'MIDDLE' + 'B'.repeat(200)
    const r = compactArgs(long, 50)
    expect(r.length).toBeLessThanOrEqual(50)
    expect(r).toContain('compacted')
    expect(r.startsWith('A')).toBe(true)
    expect(r.endsWith('B')).toBe(true)
  })
})