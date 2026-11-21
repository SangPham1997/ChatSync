import { describe, it, expect } from 'vitest'
import { ApproveOncePolicy } from '../../../src/batch/approvePolicy'

describe('ApproveOncePolicy', () => {
  it('allows up to maxCount', () => {
    const p = new ApproveOncePolicy(2)
    expect(p.canAutoApprove()).toBe(true)
    expect(p.consume()).toEqual({ approved: 1, remaining: 1 })
    expect(p.consume()).toEqual({ approved: 2, remaining: 0 })
    expect(p.canAutoApprove()).toBe(false)
  })

  it('reset re-arms', () => {
    const p = new ApproveOncePolicy(1)
    p.consume(); p.reset()
    expect(p.canAutoApprove()).toBe(true)
  })
})