// DeepSeek DOM adapter — selector registry + site detection.
// Selectors verified against chat.deepseek.com as of Nov 2026.
// Fixtures: test/fixtures/deepseek-composer.html

export type SiteId = 'deepseek' | 'chatgpt' | 'claude' | 'unknown'

export function detectSite(): SiteId {
  const h = location.hostname
  if (h.includes('deepseek')) return 'deepseek'
  if (h.includes('chatgpt') || h.includes('openai')) return 'chatgpt'
  if (h.includes('claude')) return 'claude'
  return 'unknown'
}

export interface SiteSelectors {
  composer: string
  sendButton: string
  stopButton: string
  codeBlock: string
  streamingIndicator: string
}

const SELECTORS: Record<SiteId, SiteSelectors> = {
  deepseek: {
    composer: '#chat-input, textarea[placeholder], div[contenteditable="true"][role="textbox"]',
    sendButton: 'button[data-testid="send-button"], button.send-button',
    stopButton: 'button[data-testid="stop-button"], button.stop-button',
    codeBlock: 'pre > code, .code-block code',
    streamingIndicator: '[data-testid="stop-button"]:not([disabled]), .generating-indicator',
  },
  chatgpt: {
    composer: '#prompt-textarea, div[contenteditable="true"]',
    sendButton: 'button[data-testid="send-button"]',
    stopButton: 'button[data-testid="stop-button"]',
    codeBlock: 'pre code',
    streamingIndicator: 'button[data-testid="stop-button"]',
  },
  claude: {
    composer: 'div[contenteditable="true"].ProseMirror, textarea',
    sendButton: 'button[aria-label="Send Message"]',
    stopButton: 'button[aria-label="Stop Response"]',
    codeBlock: 'pre code',
    streamingIndicator: 'button[aria-label="Stop Response"]',
  },
  unknown: {
    composer: 'textarea, div[contenteditable="true"]',
    sendButton: 'button[type="submit"]',
    stopButton: 'button',
    codeBlock: 'pre code',
    streamingIndicator: 'button',
  },
}

export function getSelectors(): SiteSelectors {
  return SELECTORS[detectSite()] ?? SELECTORS.unknown
}

export function findComposer(): HTMLElement | null {
  const sel = getSelectors().composer
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel))
  const visible = nodes.filter((n) => n.offsetParent !== null || document.activeElement === n)
  return visible.length ? visible[visible.length - 1] : null
}

export function isStreaming(): boolean {
  const sel = getSelectors().streamingIndicator
  const el = document.querySelector(sel)
  return !!el && (el as HTMLElement).offsetParent !== null
}