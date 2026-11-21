// M1 round lifecycle -- xstate v5 (no DOM, fully unit-testable)
import { createMachine } from 'xstate'

export const roundMachine = createMachine({
  id: 'round',
  initial: 'idle',
  states: {
    idle:      { on: { APPLY: 'applied' } },
    applied:   { on: { START_VERIFY: 'verifying' } },
    verifying: { on: { DONE: 'reporting', FAIL: 'reporting' } },
    reporting: { on: { NEXT: 'waiting', CLOSE: 'green' } },
    waiting:   { on: { APPLY: 'applied', STOP: 'stop' } },
    green:     { on: { RESET: 'idle' } },
    stop:      { on: { RESET: 'idle' } },
  },
})