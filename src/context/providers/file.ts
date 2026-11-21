import * as vscode from 'vscode'
import type { ContextBlock, ContextMention } from '../taxonomy'

export async function provideFile(
  mention: Extract<ContextMention, { kind: 'file' }>
): Promise<ContextBlock | null> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return null
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, mention.path))
    const text = new TextDecoder('utf-8').decode(bytes)
    const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n... (truncated)' : text
    return { mention, rendered: `### @file:${mention.path}\n\`\`\`\n${trimmed}\n\`\`\`` }
  } catch { return null }
}