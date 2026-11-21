import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, PORT, HOST, type ServerHandle } from '../../../src/server'
import http from 'node:http'

const TEST_PORT = 7129

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        let json: any = data
        try { json = JSON.parse(data) } catch {}
        resolve({ status: res.statusCode || 0, headers: res.headers, body: json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('server', () => {
  let handle: ServerHandle
  const mockVscode = {
    version: '1.95.0',
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    },
    window: {
      activeTextEditor: undefined,
    },
    commands: {
      executeCommand: async () => {},
    },
  } as any

  beforeAll(() => {
    handle = startServer(mockVscode, TEST_PORT)
  })

  afterAll(async () => {
    await handle.stop()
  })

  it('binds to specified port and defaults to 7123', () => {
    expect(handle.port).toBe(TEST_PORT)
    expect(PORT).toBe(7123)
    expect(HOST).toBe('127.0.0.1')
  })

  it('handles OPTIONS preflight with CORS and PNA headers', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/health',
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chat.deepseek.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('https://chat.deepseek.com')
    expect(res.headers['access-control-allow-private-network']).toBe('true')
    expect(res.headers['access-control-allow-methods']).toContain('GET')
  })

  it('serves GET /health with CORS headers and status', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/health',
      method: 'GET',
      headers: { Origin: 'https://chat.deepseek.com' },
    })
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('https://chat.deepseek.com')
    expect(res.body.ok).toBe(true)
    expect(res.body.port).toBe(TEST_PORT)
    expect(res.body.version).toBe('0.1.0')
  })

  it('serves GET /skills', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/skills',
      method: 'GET',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.skills)).toBe(true)
  })

  it('serves GET /loop/status and POST /loop/ack', async () => {
    const getRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/loop/status',
      method: 'GET',
    })
    expect(getRes.status).toBe(200)
    expect(getRes.body.ok).toBe(true)
    expect(getRes.body.phase).toBe('idle')

    const postRes = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/loop/ack',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({})
    )
    expect(postRes.status).toBe(200)
    expect(postRes.body.ok).toBe(true)
  })

  it('returns 404 for unknown routes with CORS headers', async () => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/unknown',
      method: 'GET',
      headers: { Origin: 'https://chat.deepseek.com' },
    })
    expect(res.status).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBe('https://chat.deepseek.com')
    expect(res.body.error).toBe('not found')
  })
})
