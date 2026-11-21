// ChatSync userscript entry — wired via vite-plugin-monkey
import { initPalette } from './palette'
import { checkConnection } from './api'
import { findComposer, isStreaming } from './adapters/deepseek'
import { insertIntoComposer } from './composer/insert'
import { apiRequest } from './api'

async function main() {
  console.info('[chatsync] userscript loaded')

  // Check server connection
  const connected = await checkConnection()
  if (!connected) {
    console.warn('[chatsync] cannot reach extension server at 127.0.0.1:7123')
    return
  }
  console.info('[chatsync] ✅ connected to extension server')

  // Init slash-command palette
  await initPalette()

  // Poll /loop/status every 3s for auto-report
  setInterval(async () => {
    if (document.hidden) return
    try {
      const res = await apiRequest('GET', '/loop/status')
      if (!res.ok) return
      const s = res.body
      if (s.phase === 'report_ready' && s.report && !isStreaming()) {
        const composer = findComposer()
        const composerText = composer
          ? (composer.tagName === 'TEXTAREA' ? (composer as HTMLTextAreaElement).value : composer.textContent) ?? ''
          : ''
        if (!composerText.trim() && composer) {
          insertIntoComposer(composer, s.report)
          console.info(`[chatsync] verify report round ${s.round} inserted`)
          // Ack sent
          await apiRequest('POST', '/loop/ack')
        }
      }
    } catch {
      // Silent fail — polling is best-effort
    }
  }, 3000)
}

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true })
} else {
  main()
}