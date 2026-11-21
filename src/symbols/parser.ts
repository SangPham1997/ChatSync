// web-tree-sitter@0.24: Parser is default export, Language is named export.
// If WASM grammar missing, parse() returns null -> signatures.ts regex fallback.
import Parser, { Language } from 'web-tree-sitter'

let initPromise: Promise<boolean> | null = null
const langCache = new Map<string, Language>()

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go',
}

export async function ensureInit(): Promise<boolean> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try { await Parser.init(); return true } catch { return false }
  })()
  return initPromise
}

export async function loadLang(langId: string, wasmDir: string): Promise<Language | null> {
  const cached = langCache.get(langId)
  if (cached) return cached
  try {
    const lang = await Language.load(`${wasmDir}/${langId}.wasm`)
    langCache.set(langId, lang)
    return lang
  } catch { return null }
}

export async function parse(ext: string, source: string, wasmDir: string): Promise<Parser.Tree | null> {
  if (!(await ensureInit())) return null
  const langId = EXT_TO_LANG[ext]
  if (!langId) return null
  const lang = await loadLang(langId, wasmDir)
  if (!lang) return null
  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    parser.delete()
    return tree
  } catch { return null }
}