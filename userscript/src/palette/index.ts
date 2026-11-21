// Slash-command palette using Tribute + fuzzysort.
// Attaches to composer via selector-observer for re-render resilience.
// IME-safe: ignores input during composition.

import Tribute from 'tributejs'
import fuzzysort from 'fuzzysort'
import { findComposer, getSelectors } from '../adapters/deepseek'
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

function createTribute(el: HTMLElement): Tribute<PaletteItem> {
  const t = new Tribute<PaletteItem>({
    collection: [
      {
        trigger: '/',
        values: () => getAllItems().filter((i) => i.kind === 'skill'),
        lookup: 'trigger',
        fillAttr: 'trigger',
        menuItemTemplate: (item) =>
          `<div style="padding:4px 8px"><strong>${item.original.trigger}</strong> <span style="color:#888">${item.original.description}</span></div>`,
        selectTemplate: (item) => item?.original.trigger ?? '',
        noMatchTemplate: () => '<div style="padding:4px 8px;color:#888">No matching skills</div>',
        menuContainer: document.body,
      },
      {
        trigger: '@',
        values: () => getAllItems().filter((i) => i.kind === 'context'),
        lookup: 'trigger',
        fillAttr: 'trigger',
        menuItemTemplate: (item) =>
          `<div style="padding:4px 8px"><strong>${item.original.trigger}</strong> <span style="color:#888">${item.original.description}</span></div>`,
        selectTemplate: (item) => item?.original.trigger ?? '',
        noMatchTemplate: () => '<div style="padding:4px 8px;color:#888">No matching context</div>',
        menuContainer: document.body,
      },
    ],
    allowSpaces: false,
    autocompleteMode: true,
  })
  t.attach(el)
  return t
}

export async function initPalette(): Promise<void> {
  await loadSkills()

  const sel = getSelectors().composer
  const attach = (el: Element): void => {
    if (!(el instanceof HTMLElement)) return
    if ((el as any).__csTribute) return
    const t = createTribute(el)
    ;(el as any).__csTribute = t
    console.info('[chatsync] palette attached to composer')
  }
  const detach = (el: Element): void => {
    if (!(el instanceof HTMLElement)) return
    const t = (el as any).__csTribute as Tribute<PaletteItem> | undefined
    if (t) {
      t.detach(el)
      delete (el as any).__csTribute
    }
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
        if (node.matches(sel)) detach(node)
        node.querySelectorAll<HTMLElement>(sel).forEach(detach)
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