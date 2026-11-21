import * as vscode from 'vscode'
import type { ContextBlock, ContextMention } from '../taxonomy'

export async function provideProblems(
  mention: Extract<ContextMention, { kind: 'problems' }>
): Promise<ContextBlock | null> {
  const lines: string[] = []
  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    for (const d of items) {
      if (mention.scope && !uri.fsPath.includes(mention.scope)) continue
      lines.push(
        `${String(d.severity)} ${uri.fsPath}:${d.range.start.line + 1} -- ${d.message}`
      )
    }
  }
  if (lines.length === 0) return null
  return { mention, rendered: `### @problems\n${lines.slice(0, 200).join('\n')}` }
}