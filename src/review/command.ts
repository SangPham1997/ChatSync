import * as vscode from 'vscode'
import { showReviewPanel } from './provider'
import { unifiedDiff } from '../git/diff'

export interface ReviewArgs { unifiedDiff: string; markdown?: string }

export function registerReviewCommand(ctx: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('chatsync.review.show', async (args?: ReviewArgs) => {
    if (args?.unifiedDiff) {
      showReviewPanel(ctx, args.unifiedDiff, args.markdown)
      return
    }

    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (repoRoot) {
      try {
        const diff = await unifiedDiff(repoRoot)
        if (diff && diff.trim()) {
          showReviewPanel(ctx, diff, '## Workspace Git Diff')
          return
        }
      } catch {
        // Fall through
      }
    }

    vscode.window.showInformationMessage('ChatSync: No diff received and no uncommitted git changes found.')
  })
}
