// /git/diff endpoint -- simple-git wrapper. Used by /review and @git context.
import { simpleGit } from 'simple-git'

export async function unifiedDiff(repoRoot: string, refRange?: string): Promise<string> {
  const git = simpleGit({ baseDir: repoRoot })
  if (refRange) return git.diff([refRange])
  return git.diff(['HEAD'])
}

export async function changedFiles(repoRoot: string): Promise<string[]> {
  const git = simpleGit({ baseDir: repoRoot })
  const status = await git.status()
  return [...status.modified, ...status.created, ...status.deleted]
}