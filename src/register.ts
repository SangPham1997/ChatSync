// Call from your extension activate(). Kept separate so unit tests (which run
// without VS Code host) never import this file.
import * as vscode from 'vscode'
import { registerReviewCommand } from './review/command'
import { ensureReviewAssets } from './review/assets'

export function registerM3(ctx: vscode.ExtensionContext): vscode.Disposable[] {
  ensureReviewAssets(ctx)
  return [registerReviewCommand(ctx)]
}