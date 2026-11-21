import { describe, it, expect } from 'vitest'
import { extractSignatures } from '../../../src/symbols/signatures'

describe('extractSignatures (regex fallback path)', () => {
  it('finds ts declarations when tree-sitter unavailable', async () => {
    const src = `
export function add(a: number, b: number): number { return a + b }
class Foo { bar() {} }
const baz = () => 42
interface Shape { area(): number }
`
    const sigs = await extractSignatures(src, '.ts', '/nonexistent-wasm-dir')
    const names = sigs.map(s => s.name)
    expect(names).toContain('add')
    expect(names).toContain('Foo')
    expect(names).toContain('baz')
    expect(names).toContain('Shape')
  })
})