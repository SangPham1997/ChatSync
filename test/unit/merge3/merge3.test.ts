import { describe, it, expect } from 'vitest'
import { merge3 } from '../../../src/patch/merge3'

describe('merge3', () => {
  it('clean merge -- user edits line 2, AI edits line 4 (non-adjacent)', () => {
    // Deliberately non-adjacent so the test is deterministic across diff3
    // implementations. Adjacent-line behavior is covered by the next test.
    const base = 'line1\nline2\nline3\nline4'
    const user = 'line1\nline2-user\nline3\nline4'
    const ai   = 'line1\nline2\nline3\nline4-ai'
    const r = merge3(base, user, ai)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('line2-user')
      expect(r.text).toContain('line4-ai')
      expect(r.text).not.toContain('<<<<<<<')
    }
  })

  it('adjacent edits merge cleanly thanks to excludeFalseConflicts', () => {
    // Regression guard for the option in merge3.ts. If node-diff3 ever changes
    // default behavior, this test catches it.
    const base = 'line1\nline2\nline3'
    const user = 'line1\nline2-user\nline3'
    const ai   = 'line1\nline2\nline3-ai'
    const r = merge3(base, user, ai)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('line2-user')
      expect(r.text).toContain('line3-ai')
    }
  })

  it('reports genuine conflict when both sides change the same line', () => {
    const base = 'x\nmid\ny'
    const user = 'x\nUSER\ny'
    const ai   = 'x\nAI\ny'
    const r = merge3(base, user, ai)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.regions).toBeGreaterThan(0)
      expect(r.text).toContain('<<<<<<<')
      expect(r.text).toContain('>>>>>>>')
    }
  })
})