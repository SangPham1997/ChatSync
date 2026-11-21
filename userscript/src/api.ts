// HTTP client for ChatSync extension server.
// Uses GM_xmlhttpRequest to bypass CORS/mixed-content restrictions.

declare const GM_xmlhttpRequest: (details: {
  method: string
  url: string
  headers?: Record<string, string>
  data?: string
  timeout?: number
  onload?: (resp: { status: number; responseText: string }) => void
  onerror?: (err: unknown) => void
  ontimeout?: () => void
}) => void

declare const GM_getValue: (key: string, defaultValue?: unknown) => unknown
declare const GM_setValue: (key: string, value: unknown) => void

const DEFAULT_PORT = 7123
const SETTINGS_KEY = 'chatsync.settings.v1'

interface Settings {
  port: number
  token: string
}

function loadSettings(): Settings {
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS_KEY, '{}') : '{}'
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '{}')
    return { port: parsed.port || DEFAULT_PORT, token: parsed.token || '' }
  } catch {
    return { port: DEFAULT_PORT, token: '' }
  }
}

export interface ApiResponse {
  ok: boolean
  status: number
  body: any
}

export async function apiRequest(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const settings = loadSettings()
  const url = `http://127.0.0.1:${settings.port}${path}`
  const headers: Record<string, string> = {}
  if (settings.token) headers['X-ChatSync-Token'] = settings.token
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  return new Promise((resolve) => {
    if (typeof GM_xmlhttpRequest !== 'function') {
      resolve({ ok: false, status: 0, body: { error: 'GM_xmlhttpRequest not available' } })
      return
    }
    GM_xmlhttpRequest({
      method,
      url,
      headers,
      data: body !== undefined ? JSON.stringify(body) : undefined,
      timeout: 15000,
      onload: (resp) => {
        let parsed: any
        try { parsed = JSON.parse(resp.responseText) } catch { parsed = { raw: resp.responseText } }
        resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, body: parsed })
      },
      onerror: () => resolve({ ok: false, status: 0, body: { error: 'network error' } }),
      ontimeout: () => resolve({ ok: false, status: 0, body: { error: 'timeout' } }),
    })
  })
}

export async function checkConnection(): Promise<boolean> {
  const res = await apiRequest('GET', '/health')
  if (res.ok && res.body?.token && !loadSettings().token) {
    // Auto-save token from /health (localhost only, safe)
    const settings = loadSettings()
    settings.token = res.body.token
    if (typeof GM_setValue === 'function') {
      GM_setValue(SETTINGS_KEY, JSON.stringify(settings))
    }
  }
  return res.ok
}