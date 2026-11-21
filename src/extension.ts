// VS Code extension entry. Wires M3 (review) + M1 server /review route + status bar.
import * as vscode from 'vscode'
import { registerM3 } from './register'
import { startServer, PORT } from './server'

let disposables: vscode.Disposable[] = []
let serverStop: (() => Promise<void>) | null = null
let statusItem: vscode.StatusBarItem | null = null

export function activate(ctx: vscode.ExtensionContext): void {
  disposables = registerM3(ctx)
  ctx.subscriptions.push(...disposables)

  // Status bar item: $(plug) ChatSync :7123
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusItem.text = `$(plug) ChatSync :${PORT}`
  statusItem.tooltip = `ChatSync bridge active on http://127.0.0.1:${PORT}. Click for actions.`
  statusItem.command = 'chatsync.showInfo'
  statusItem.show()
  ctx.subscriptions.push(statusItem)

  // Register commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('chatsync.showInfo', async () => {
      const pick = await vscode.window.showInformationMessage(
        `ChatSync local bridge is running on http://127.0.0.1:${PORT}.`,
        'Copy URL',
        'Show Review'
      )
      if (pick === 'Copy URL') {
        await vscode.env.clipboard.writeText(`http://127.0.0.1:${PORT}`)
        vscode.window.showInformationMessage('ChatSync URL copied to clipboard.')
      } else if (pick === 'Show Review') {
        await vscode.commands.executeCommand('chatsync.review.show')
      }
    }),
    vscode.commands.registerCommand('chatsync.status', () => {
      vscode.window.showInformationMessage(`ChatSync is running on http://127.0.0.1:${PORT}.`)
    })
  )

  try {
    const srv = startServer()
    serverStop = srv.stop
    ctx.subscriptions.push({ dispose: () => { void serverStop?.() } })
  } catch (e) {
    if (statusItem) {
      statusItem.text = `$(warning) ChatSync :${PORT}`
      statusItem.tooltip = `ChatSync failed to start: ${String(e)}`
    }
    vscode.window.showWarningMessage(`ChatSync: server failed to start: ${String(e)}`)
  }
}

export async function deactivate(): Promise<void> {
  for (const d of disposables) d.dispose()
  disposables = []
  if (statusItem) {
    statusItem.dispose()
    statusItem = null
  }
  if (serverStop) await serverStop()
}
