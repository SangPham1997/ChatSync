// Local HTTP server. Binds 127.0.0.1 only. Minimal /health + /review.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as vscode from 'vscode'
import { handleReview, type ReviewRequest } from './handlers'

const HOST = '127.0.0.1'
const PORT = 7123
const MAX_BODY = 10 * 1024 * 1024

export interface ServerHandle { port: number; stop: () => Promise<void> }

export function startServer(): ServerHandle {
  const srv = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, port: PORT })
      }
      if (req.method === 'POST' && req.url === '/review') {
        const body = await readBody(req)
        let payload: ReviewRequest
        try { payload = JSON.parse(body) } catch { return send(res, 400, { error: 'bad json' }) }
        const r = await handleReview(payload, vscode)
        return send(res, r.ok ? 200 : 500, r)
      }
      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 500, { error: String(e) })
    }
  })
  srv.listen(PORT, HOST)
  return {
    port: PORT,
    stop: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  }
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

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}