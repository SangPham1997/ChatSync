// VS Code has no public terminal-buffer API (1.95). Side-channel file is the
// workaround; write path is up to the user (extension or external script).
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextBlock, ContextMention } from '../taxonomy'

export async function provideTerminal(
  mention: Extract<ContextMention, { kind: 'terminal' }>
): Promise<ContextBlock | null> {
  const n = mention.lastN ?? 20
  try {
    const raw = readFileSync(join(tmpdir(), 'chatsync-terminal-echo.log'), 'utf8')
    const tail = raw.split('\n').slice(-n).join('\n')
    return { mention, rendered: `### @terminal (last ${n})\n\`\`\`\n${tail}\n\`\`\`` }
  } catch { return null }
}