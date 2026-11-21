// M1 contract validation -- zod
import { z } from 'zod'

export const ApplyPayload = z.object({
  roundId: z.string().min(1),
  patches: z.array(
    z.object({
      file: z.string().min(1),
      search: z.string(),
      replace: z.string(),
    })
  ).min(1),
})
export type ApplyPayload = z.infer<typeof ApplyPayload>

export const LoopStatus = z.object({
  roundId: z.string(),
  phase: z.enum(['idle', 'applied', 'verifying', 'reporting', 'waiting', 'green', 'stop']),
  exitCode: z.number().int().nullable().optional(),
})
export type LoopStatus = z.infer<typeof LoopStatus>