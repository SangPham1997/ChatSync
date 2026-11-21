import * as vscode from 'vscode'
import { showReviewPanel } from './provider'

export interface ReviewArgs { unifiedDiff: string; markdown?: string }

export function registerReviewCommand(ctx: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('chatsync.review.show', (args: ReviewArgs) => {
    if (!args?.unifiedDiff) {
      vscode.window.showWarningMessage('ChatSync: /review called without diff.')
      return
    }
    showReviewPanel(ctx, args.unifiedDiff, args.markdown)
  })
}