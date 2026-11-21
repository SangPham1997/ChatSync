// Vendored type shims for packages that ship no @types.
declare module 'tree-kill' {
  type Signal =
    | 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT'
    | 'SIGABRT' | 'SIGALRM' | 'SIGUSR1' | 'SIGUSR2'
  function treeKill(pid: number, signal?: Signal, callback?: (err?: Error) => void): void
  function treeKill(pid: number, callback?: (err?: Error) => void): void
  export = treeKill
}

declare module 'node-diff3' {
  export interface Diff3Conflict {
    a: string[]; o: string[]; b: string[]
    aIndex: number; oIndex: number; bIndex: number
  }
  export interface Diff3Region {
    ok?: string[]
    conflict?: Diff3Conflict
  }
  export interface Diff3Options {
    excludeFalseConflicts?: boolean
    stringSeparator?: RegExp | string
  }
  export function diff3Merge(
    a: string[],
    o: string[],
    b: string[],
    options?: Diff3Options
  ): Diff3Region[]
}