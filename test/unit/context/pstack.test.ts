import { describe, it, expect } from 'vitest'
import { PstackComposer } from '../../../src/context/composePstack'

describe('PstackComposer', () => {
  it('empty mentions -> blocks=0, roundsInWindow increments', async () => {
    const c = new PstackComposer({ repoRoot: '/tmp' })
    const r1 = await c.composeRound('prompt one', 'r1')
    const r2 = await c.composeRound('prompt two', 'r2')
    expect(r1.blocks).toBe(0)
    expect(r2.roundsInWindow).toBe(2)
    expect(r2.pstack).toContain('recent rounds')
  })
  it('sliding window rotates', async () => {
    const c = new PstackComposer({ repoRoot: '/tmp', maxRounds: 2 })
    await c.composeRound('p1', 'r1')
    await c.composeRound('p2', 'r2')
    await c.composeRound('p3', 'r3')
    const r = await c.composeRound('p4', 'r4')
    expect(r.roundsInWindow).toBe(2)
  })
  it('resetSession clears window and rules', async () => {
    const c = new PstackComposer({ repoRoot: '/tmp' })
    await c.composeRound('p1', 'r1')
    c.resetSession()
    const r = await c.composeRound('p2', 'r2')
    expect(r.roundsInWindow).toBe(1)
  })
})