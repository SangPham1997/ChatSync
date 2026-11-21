// Context taxonomy -- Continue-style @-mentions. Provider implementations are
// TODO(M2): they need VS Code API. This file only defines names + resolution.
export type ContextMention =
  | { kind: 'file';     path: string }
  | { kind: 'folder';   path: string }
  | { kind: 'problems'; scope?: string }
  | { kind: 'terminal'; lastN?: number }
  | { kind: 'git';      range?: string }

export interface ContextBlock {
  mention: ContextMention
  rendered: string      // what gets injected into the compose pstack
  tokenHint?: number
}

export function parseMention(raw: string): ContextMention | null {
  const s = raw.trim()
  const m = /^@(file|folder|problems|terminal|git)(?::(.+))?$/.exec(s)
  if (!m) return null
  const [, kind, arg] = m
  switch (kind) {
    case 'file':     return arg ? { kind: 'file',   path: arg }              : null
    case 'folder':   return arg ? { kind: 'folder', path: arg }              : null
    case 'problems': return { kind: 'problems', scope: arg }
    case 'terminal': return { kind: 'terminal', lastN: arg ? Number(arg) : 20 }
    case 'git':      return { kind: 'git', range: arg }
    default:         return null
  }
}

// TODO(M2): implement provider that turns each mention into a ContextBlock via
// workspace.fs, vscode.languages.getDiagnostics, terminal buffer capture, git diff.
export type ContextProvider = (m: ContextMention) => Promise<ContextBlock | null>