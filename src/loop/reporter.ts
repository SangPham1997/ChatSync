// M1 reporter -- redact then post back to chat.
// secretlint deferred to M2; MVP regex here is the plan's fallback path.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
]

export function redact(input: string): string {
  let out = input
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

export function buildReport(roundId: string, exitCode: number, stdout: string, stderr: string) {
  return {
    roundId,
    exitCode,
    summary: exitCode === 0 ? 'green' : 'red',
    stdout: redact(stdout.slice(-4000)),
    stderr: redact(stderr.slice(-4000)),
  }
}