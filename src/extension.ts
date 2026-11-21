// VS Code extension entry. Wires M3 (review) + M1 server /review route.
import * as vscode from 'vscode'
import { registerM3 } from './register'
import { startServer } from './server'

let disposables: vscode.Disposable[] = []
let serverStop: (() => Promise<void>) | null = null

export function activate(ctx: vscode.ExtensionContext): void {
  disposables = registerM3(ctx)
  ctx.subscriptions.push(...disposables)
  try {
    const srv = startServer()
    serverStop = srv.stop
    ctx.subscriptions.push({ dispose: () => { void serverStop?.() } })
  } catch (e) {
    vscode.window.showWarningMessage(`ChatSync: server failed to start: ${String(e)}`)
  }
}

export async function deactivate(): Promise<void> {
  for (const d of disposables) d.dispose()
  disposables = []
  if (serverStop) await serverStop()
}