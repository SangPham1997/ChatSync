import { describe, it, expect } from 'vitest'
import { merge3 } from '../../../src/patch/merge3'

describe('merge3', () => {
  it('clean merge -- non-adjacent lines', () => {
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

  it('adjacent edits produce a safe conflict (no silent merge)', () => {
    // node-diff3 treats adjacent-but-different line changes as a conflict zone.
    // excludeFalseConflicts only filters SAME-change regions, not adjacent ones.
    // Desired ChatSync behavior: AI patch close to user edits surfaces a
    // conflict for human review rather than silently merging.
    const base = 'line1\nline2\nline3'
    const user = 'line1\nline2-user\nline3'
    const ai   = 'line1\nline2\nline3-ai'
    const r = merge3(base, user, ai)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.conflict).toBe(true)
      expect(r.regions).toBeGreaterThan(0)
      expect(r.text).toContain('<<<<<<< user')
      expect(r.text).toContain('>>>>>>> ai')
    }
  })

  it('reports genuine conflict when same line differs', () => {
    const r = merge3('x\nUSER\ny', 'x\nmid\ny', 'x\nAI\ny')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.regions).toBeGreaterThan(0)
      expect(r.text).toContain('<<<<<<<')
    }
  })
})