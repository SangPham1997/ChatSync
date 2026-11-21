// Pure handler for /review -- testable without VS Code host.
import type * as vscode from 'vscode'

export interface ReviewRequest { unifiedDiff: string; markdown?: string }

export async function handleReview(
  req: ReviewRequest,
  vscodeApi: typeof vscode
): Promise<{ ok: boolean; error?: string }> {
  if (!req || !req.unifiedDiff) return { ok: false, error: 'missing unifiedDiff' }
  try {
    await vscodeApi.commands.executeCommand('chatsync.review.show', req)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}