import { describe, it, expect } from 'vitest'
import { handleReview } from '../../../src/server/handlers'

describe('handleReview', () => {
  it('rejects missing unifiedDiff', async () => {
    const v = { commands: { executeCommand: async () => {} } } as any
    const r = await handleReview({ unifiedDiff: '' } as any, v)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/missing/)
  })
  it('calls executeCommand chatsync.review.show', async () => {
    let calledCmd = ''
    const v = { commands: { executeCommand: async (c: string) => { calledCmd = c } } } as any
    const r = await handleReview({ unifiedDiff: 'diff --git a b' }, v)
    expect(r.ok).toBe(true)
    expect(calledCmd).toBe('chatsync.review.show')
  })
})