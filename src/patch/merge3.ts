// 3-way merge via node-diff3. If merge fails, do NOT reject hard -- return
// conflict markers + flag so the loop reporter can bounce it to chat.
//
// excludeFalseConflicts: true keeps node-diff3 from flagging adjacent-but-
// independent line edits (e.g. user edits line 2, AI edits line 3) as a
// conflict. That's the common case in ChatSync: user fixes a nearby typo
// while AI patch touches the next line. Without this option those produce
// spurious conflicts.
import { diff3Merge } from 'node-diff3'

export type MergeOutcome =
  | { ok: true;  text: string }
  | { ok: false; conflict: true; text: string; regions: number }

export function merge3(original: string, userEdit: string, aiPatch: string): MergeOutcome {
  const o = original.split('\n')
  const a = userEdit.split('\n')
  const b = aiPatch.split('\n')

  const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true }) as Array<{
    ok?: string[]
    conflict?: { a: string[]; o: string[]; b: string[]; aIndex: number; oIndex: number; bIndex: number }
  }>

  const out: string[] = []
  let conflicts = 0
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    if (r.conflict) {
      conflicts++
      out.push('<<<<<<< user')
      out.push(...r.conflict.a)
      out.push('=======')
      out.push(...r.conflict.b)
      out.push('>>>>>>> ai')
    }
  }
  const text = out.join('\n')
  if (conflicts > 0) return { ok: false, conflict: true, text, regions: conflicts }
  return { ok: true, text }
}