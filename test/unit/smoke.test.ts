import { describe, it, expect } from 'vitest'
import { redact } from '../../src/loop/reporter'
import { ApplyPayload } from '../../src/loop/schema'

describe('reporter', () => {
  it('redacts sk- keys', () => {
    expect(redact('key=sk-abcdefghij1234567890XYZ')).toContain('[REDACTED]')
  })
})

describe('schema', () => {
  it('rejects empty patches', () => {
    const r = ApplyPayload.safeParse({ roundId: 'r1', patches: [] })
    expect(r.success).toBe(false)
  })
})