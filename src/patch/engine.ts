// Patch engine -- glues locate + merge3. No VS Code API here; caller does IO.
import { locate, LocateResult } from './locate'
import { merge3, MergeOutcome } from './merge3'

export interface PatchRequest {
  original: string
  search: string
  replace: string
  expectedNear?: number
}

export type EngineResult =
  | { status: 'applied'; tier: LocateResult['tier']; text: string; merged: boolean }
  | { status: 'conflict'; tier: LocateResult['tier']; text: string; regions: number }
  | { status: 'not-found' }

export function applyPatch(req: PatchRequest): EngineResult {
  const hit = locate(req.original, req.search, req.expectedNear ?? 0)
  if (!hit) return { status: 'not-found' }

  const replaced =
    req.original.slice(0, hit.offset) +
    req.replace +
    req.original.slice(hit.offset + hit.length)

  // If the source file drifted from what AI saw, caller should pass:
  //   original  = what AI saw (base)
  //   current   = user's current on-disk content  -> merge3(base, user, aiPatched)
  // For this stub, we treat `original` as both base and current.
  const merged: MergeOutcome = merge3(req.original, req.original, replaced)
  if (!merged.ok) return { status: 'conflict', tier: hit.tier, text: merged.text, regions: merged.regions }
  return { status: 'applied', tier: hit.tier, text: merged.text, merged: false }
}