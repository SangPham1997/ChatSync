// VS Code webview wrapper. Requires 'vscode' API -- keep this file out of pure tests.
// TODO(M2): register as command "chatsync.review.show"; wire diff2html CSS asset.
import * as vscode from 'vscode'
import { renderReview } from './render'

export function showReviewPanel(ctx: vscode.ExtensionContext, unifiedDiff: string, markdown?: string) {
  const panel = vscode.window.createWebviewPanel(
    'chatsync.review',
    'ChatSync Review',
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  )
  const nonce = Array.from({ length: 16 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
  ).join('')

  const css = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, 'media', 'diff2html.min.css')
  )

  panel.webview.html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
</head><body>
${renderReview({ unifiedDiff, commentaryMarkdown: markdown })}
</body></html>`
}