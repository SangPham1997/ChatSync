import * as vscode from 'vscode'
import type { ContextBlock, ContextMention } from '../taxonomy'

export async function provideFolder(
  mention: Extract<ContextMention, { kind: 'folder' }>
): Promise<ContextBlock | null> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (!root) return null
  try {
    const children = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, mention.path))
    const lines = children.map(([name, t]) => (t === vscode.FileType.Directory ? `${name}/` : name))
    return { mention, rendered: `### @folder:${mention.path}\n${lines.join('\n')}` }
  } catch { return null }
}