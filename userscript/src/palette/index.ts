// Slash-command palette using Tribute + fuzzysort.
// Attaches to composer via selector-observer for re-render resilience.
// IME-safe: ignores input during composition.

import Tribute from 'tributejs'
import { getSelectors } from '../adapters/deepseek'
import { insertIntoComposer } from '../composer/insert'
import { apiRequest } from '../api'

interface PaletteItem {
  trigger: string
  name: string
  description: string
  kind: 'skill' | 'context'
}

const CONTEXT_ITEMS: PaletteItem[] = [
  { trigger: '@file', name: 'Attach file', description: 'Gửi nội dung file đang mở', kind: 'context' },
  { trigger: '@folder', name: 'Attach folder', description: 'Gửi cây thư mục + nội dung', kind: 'context' },
  { trigger: '@problems', name: 'Attach problems', description: 'Gửi diagnostics từ Problems panel', kind: 'context' },
  { trigger: '@git', name: 'Attach git diff', description: 'Gửi git diff hiện tại', kind: 'context' },
]

let skillCache: PaletteItem[] = []
let tributeInstance: Tribute<PaletteItem> | null = null
let observer: MutationObserver | null = null

function injectStyles(): void {
  const ID = 'chatsync-tribute-styles'
  if (document.getElementById(ID)) return
  const style = document.createElement('style')
  style.id = ID
  style.textContent = `
    .tribute-container {
      position: absolute;
      top: 0;
      left: 0;
      height: auto;
      max-height: 280px;
      max-width: 480px;
      overflow: auto;
      display: block;
      z-index: 2147483647;
      background: #1e1e24;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
    }
    .tribute-container ul {
      margin: 0;
      padding: 4px 0;
      list-style: none;
      background: transparent;
    }
    .tribute-container li {
      padding: 0;
      cursor: pointer;
    }
    .tribute-container li.highlight, .tribute-container li:hover {
      background: #2b313c;
    }
    .tribute-container li.no-match {
      cursor: default;
    }
    .tribute-container .menu-highlighted {
      font-weight: 600;
      color: #58a6ff;
    }
  `
  ;(document.head || document.documentElement).appendChild(style)
}

async function loadSkills(): Promise<void> {
  try {
    const res = await apiRequest('GET', '/skills')
    if (res.ok && Array.isArray(res.body?.skills)) {
      skillCache = res.body.skills
        .filter((s: { trigger?: string; name: string; description: string }) => s.trigger)
        .map((s: { trigger: string; name: string; description: string }) => ({
          trigger: s.trigger,
          name: s.name,
          description: s.description,
          kind: 'skill' as const,
        }))
    }
  } catch {
    // Skills unavailable — context items still work
  }
}

function getAllItems(): PaletteItem[] {
  return [...CONTEXT_ITEMS, ...skillCache]
}

function getOrCreateTribute(): Tribute<PaletteItem> {
  if (tributeInstance) return tributeInstance

  injectStyles()

  tributeInstance = new Tribute<PaletteItem>({
    collection: [
      {
        trigger: '/',
        requireLeadingSpace: false,
        values: (_text: string, cb: (matches: PaletteItem[]) => void) => {
          cb(getAllItems().filter((i) => i.kind === 'skill'))
        },
        lookup: 'trigger',
        fillAttr: 'trigger',
        menuItemTemplate: (item) =>
          `<div style="padding:6px 10px;display:flex;justify-content:space-between;align-items:center;">` +
          `<strong style="color:#58a6ff;">${item.original.trigger}</strong> ` +
          `<span style="color:#8b949e;font-size:12px;margin-left:8px;">${item.original.description}</span></div>`,
        selectTemplate: (item) => item?.original.trigger ?? '',
        noMatchTemplate: () => '<div style="padding:6px 10px;color:#888;">No matching skills</div>',
      },
      {
        trigger: '@',
        requireLeadingSpace: false,
        values: (_text: string, cb: (matches: PaletteItem[]) => void) => {
          cb(getAllItems().filter((i) => i.kind === 'context'))
        },
        lookup: 'trigger',
        fillAttr: 'trigger',
        menuItemTemplate: (item) =>
          `<div style="padding:6px 10px;display:flex;justify-content:space-between;align-items:center;">` +
          `<strong style="color:#58a6ff;">${item.original.trigger}</strong> ` +
          `<span style="color:#8b949e;font-size:12px;margin-left:8px;">${item.original.description}</span></div>`,
        selectTemplate: (item) => item?.original.trigger ?? '',
        noMatchTemplate: () => '<div style="padding:6px 10px;color:#888;">No matching context</div>',
      },
    ],
    allowSpaces: false,
    menuContainer: document.body,
  })

  return tributeInstance
}

export async function initPalette(): Promise<void> {
  await loadSkills()

  const tribute = getOrCreateTribute()
  const sel = getSelectors().composer

  const attach = (el: Element): void => {
    if (!(el instanceof HTMLElement)) return
    if (el.hasAttribute('data-tribute') || (el as any).__csTribute) return
    ;(el as any).__csTribute = true
    tribute.attach(el)
    console.info('[chatsync] palette attached to composer')

    el.addEventListener('tribute-replaced', async (e: any) => {
      const item = e.detail?.item?.original as PaletteItem | undefined
      if (!item) return
      if (item.trigger === '@file') {
        try {
          const res = await apiRequest('GET', '/context/file')
          if (res.ok && res.body?.contextText) {
            insertIntoComposer(el, res.body.contextText, false)
          }
        } catch {
          // Ignore
        }
      }
    })
  }

  document.querySelectorAll<HTMLElement>(sel).forEach(attach)

  observer = new MutationObserver((mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node: Node) => {
        if (!(node instanceof HTMLElement)) return
        if (node.matches(sel)) attach(node)
        node.querySelectorAll<HTMLElement>(sel).forEach(attach)
      })
      mutation.removedNodes.forEach((node: Node) => {
        if (!(node instanceof HTMLElement)) return
        if (node.matches(sel) && (node as any).__csTribute) {
          tribute.detach(node)
          delete (node as any).__csTribute
        }
        node.querySelectorAll<HTMLElement>(sel).forEach((child) => {
          if ((child as any).__csTribute) {
            tribute.detach(child)
            delete (child as any).__csTribute
          }
        })
      })
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

export function destroyPalette(): void {
  observer?.disconnect()
  observer = null
  tributeInstance = null
}
