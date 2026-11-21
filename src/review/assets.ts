import type * as vscode from 'vscode'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS = [
  { from: 'node_modules/diff2html/bundles/css/diff2html.min.css', to: 'diff2html.min.css' },
]

export function ensureReviewAssets(ctx: vscode.ExtensionContext): void {
  const media = join(ctx.extensionPath, 'media')
  if (!existsSync(media)) mkdirSync(media, { recursive: true })
  for (const a of ASSETS) {
    const src = join(ctx.extensionPath, a.from)
    const dst = join(media, a.to)
    if (!existsSync(src)) continue
    if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue
    copyFileSync(src, dst)
  }
}