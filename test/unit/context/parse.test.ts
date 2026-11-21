import { describe, it, expect } from 'vitest'
import { parseMention } from '../../../src/context/taxonomy'

describe('parseMention', () => {
  it('@file',        () => expect(parseMention('@file:src/a.ts')).toEqual({ kind: 'file', path: 'src/a.ts' }))
  it('@folder',      () => expect(parseMention('@folder:src')).toEqual({ kind: 'folder', path: 'src' }))
  it('@problems',    () => expect(parseMention('@problems:src/loop')).toEqual({ kind: 'problems', scope: 'src/loop' }))
  it('@terminal:N',  () => expect(parseMention('@terminal:50')).toEqual({ kind: 'terminal', lastN: 50 }))
  it('@git:range',   () => expect(parseMention('@git:HEAD~1..HEAD')).toEqual({ kind: 'git', range: 'HEAD~1..HEAD' }))
  it('rejects unknown',    () => expect(parseMention('@unknown')).toBeNull())
  it('rejects bare @file', () => expect(parseMention('@file')).toBeNull())
})