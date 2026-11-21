// VS Code extension entry point. Wires M3 (review command + assets) into
// the extension context. Call order matters: assets first (CSS present before
// webview opens), then command registration.
import * as vscode from 'vscode'
import { registerM3 } from './register'

let disposables: vscode.Disposable[] = []

export function activate(ctx: vscode.ExtensionContext): void {
  disposables = registerM3(ctx)
  ctx.subscriptions.push(...disposables)
}

export function deactivate(): void {
  for (const d of disposables) d.dispose()
  disposables = []
}