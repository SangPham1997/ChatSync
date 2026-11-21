// extractSignatures -- try tree-sitter, fall back to regex (plan-approved).
import { parse } from './parser'

export interface Signature {
  kind: string
  name: string
  line: number
  text: string
}

const NODES = new Set([
  'function_declaration',
  'function_definition',
  'method_definition',
  'arrow_function',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
])

export async function extractSignatures(
  source: string,
  ext: string,
  wasmDir: string
): Promise<Signature[]> {
  const tree = await parse(ext, source, wasmDir).catch(() => null)
  if (tree) {
    const out: Signature[] = []
    const walk = (node: any): void => {
      if (NODES.has(node.type)) {
        const nameNode = node.childForFieldName?.('name')
        if (nameNode) {
          out.push({
            kind: node.type,
            name: nameNode.text,
            line: node.startPosition.row + 1,
            text: node.text.split('\n')[0].slice(0, 120),
          })
        }
      }
      for (const c of node.children) walk(c)
    }
    try {
      walk(tree.rootNode)
      tree.delete()
    } catch { /* fall through to regex */ }
    if (out.length > 0) return out
  }

  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/g
  const out: Signature[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    out.push({
      kind: 'regex-fallback',
      name: m[1],
      line: source.slice(0, m.index).split('\n').length,
      text: m[0].trim().slice(0, 120),
    })
  }
  return out
}