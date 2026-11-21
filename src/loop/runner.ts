// M1 verify runner -- execa + tree-kill + strip-ansi
// NOTE: only runs commands from an allowlist. No AI-proposed commands.
import { execa } from 'execa'
import treeKill from 'tree-kill'
import stripAnsi from 'strip-ansi'

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const ALLOW = new Set(['npm', 'pnpm', 'yarn', 'npx'])

export async function runVerify(
  cwd: string,
  args: string[],
  timeoutMs = 120_000
): Promise<RunResult> {
  if (!ALLOW.has(args[0])) {
    throw new Error(`command not allowed: ${args[0]}`)
  }
  const sub = execa(args[0], args.slice(1), { cwd, reject: false, all: true })
  const timer = setTimeout(() => { if (sub.pid) treeKill(sub.pid, 'SIGKILL') }, timeoutMs)
  try {
    const r = await sub
    return {
      exitCode: r.exitCode ?? -1,
      stdout: stripAnsi(r.stdout ?? ''),
      stderr: stripAnsi(r.stderr ?? ''),
      timedOut: false,
    }
  } finally {
    clearTimeout(timer)
  }
}