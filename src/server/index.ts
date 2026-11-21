// Local HTTP server. Binds 127.0.0.1 only.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import * as vscode from 'vscode'
import { handleReview, type ReviewRequest } from './handlers'
import { loadSkills } from '../skills/loader'

export const HOST = '127.0.0.1'
export const PORT = 7123
const MAX_BODY = 10 * 1024 * 1024

export interface ServerHandle { port: number; stop: () => Promise<void> }

export function startServer(vscodeApi: typeof vscode = vscode, port: number = PORT): ServerHandle {
  const srv = createServer(async (req, res) => {
    try {
      const cors = getCorsHeaders(req)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        return res.end()
      }

      const pathname = req.url ? new URL(req.url, `http://${HOST}:${port}`).pathname : ''

      if (req.method === 'GET' && pathname === '/health') {
        const workspaceFolder = vscodeApi.workspace?.workspaceFolders?.[0]?.uri?.fsPath
        const activeEditor = (vscodeApi.window as any)?.activeTextEditor
        const activeFile = activeEditor?.document?.fileName ? basename(activeEditor.document.fileName) : undefined

        return send(req, res, 200, {
          ok: true,
          service: 'chatsync',
          port,
          version: '0.1.0',
          vscodeVersion: (vscodeApi as any).version || '1.95.0',
          workspace: workspaceFolder,
          activeFile,
        })
      }

      if (req.method === 'POST' && pathname === '/review') {
        const body = await readBody(req)
        let payload: ReviewRequest
        try { payload = JSON.parse(body) } catch { return send(req, res, 400, { error: 'bad json' }) }
        const r = await handleReview(payload, vscodeApi)
        return send(req, res, r.ok ? 200 : 500, r)
      }

      if (req.method === 'GET' && pathname === '/skills') {
        const workspaceFolder = vscodeApi.workspace?.workspaceFolders?.[0]?.uri?.fsPath
        let skills: Array<{ trigger: string; name: string; description: string }> = []
        if (workspaceFolder) {
          try {
            const docs = loadSkills(workspaceFolder)
            skills = docs.map((d) => ({
              trigger: (d.meta.trigger as string) || `/${d.id}`,
              name: (d.meta.name as string) || d.id,
              description: (d.meta.description as string) || '',
            }))
          } catch {
            // Best effort loading
          }
        }
        return send(req, res, 200, { ok: true, skills })
      }

      if (req.method === 'GET' && pathname === '/loop/status') {
        return send(req, res, 200, { ok: true, phase: 'idle' })
      }

      if (req.method === 'POST' && pathname === '/loop/ack') {
        return send(req, res, 200, { ok: true })
      }

      if (req.method === 'GET' && pathname === '/context/file') {
        const activeEditor = (vscodeApi.window as any)?.activeTextEditor
        if (!activeEditor) {
          return send(req, res, 200, { ok: true, hasEditor: false })
        }
        const doc = activeEditor.document
        const sel = activeEditor.selection
        const hasSelection = sel && !sel.isEmpty
        const text = hasSelection ? doc.getText(sel) : doc.getText()
        const relPath = vscodeApi.workspace?.asRelativePath?.(doc.uri) || basename(doc.fileName)
        return send(req, res, 200, {
          ok: true,
          hasEditor: true,
          hasSelection,
          fileName: basename(doc.fileName),
          relPath,
          contextText: `## File: ${relPath}\n\`\`\`${doc.languageId || ''}\n${text}\n\`\`\`\n`,
        })
      }

      send(req, res, 404, { error: 'not found' })
    } catch (e) {
      send(req, res, 500, { error: String(e) })
    }
  })
  srv.listen(port, HOST)
  return {
    port,
    stop: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  }
}

function getCorsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin || '*'
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ChatSync-Token, X-ChatSync-Client, Access-Control-Request-Private-Network',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true'
  }
  return headers
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { req.destroy(); reject(new Error('body too large')); return }
      body += c.toString('utf8')
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(req: IncomingMessage, res: ServerResponse, status: number, data: unknown): void {
  const cors = getCorsHeaders(req)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...cors,
  })
  res.end(JSON.stringify(data))
}
