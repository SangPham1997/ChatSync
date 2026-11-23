import { getConfig } from './config';
import { clamp } from './util';
import { DiagnosticInfo, collectDiagnostics } from './context';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DiagnosticDiff {
  settled: boolean;
  waitedMs: number;
  targetPaths: string[];
  before: DiagnosticInfo[];
  after: DiagnosticInfo[];
  newErrors: DiagnosticInfo[];
  fixedErrors: DiagnosticInfo[];
  unchangedErrors: DiagnosticInfo[];
  errorCountBefore: number;
  errorCountAfter: number;
  followUpText: string;
  followUpRecommended: boolean;
}

interface DiagKeyParts {
  file: string;
  message: string;
  severity: string;
}

function keyOf(d: DiagnosticInfo, ignorePosition: boolean): string {
  const p: DiagKeyParts = { file: d.file, message: d.message, severity: d.severity };
  return ignorePosition
    ? `${p.severity}|${p.file}|${p.message}`
    : `${p.severity}|${p.file}|${p.message}|${pPosition(d)}`;
}

function pPosition(d: DiagnosticInfo): string {
  return `${d.line}:${d.character}`;
}

function snapshot(paths?: string[], minSeverity = 'Error'): DiagnosticInfo[] {
  const all = collectDiagnostics({ minSeverity, limit: 2000 });
  if (!paths || paths.length === 0) {
    return all;
  }
  const wanted = paths.map((p) => p.replace(/\\/g, '/').toLowerCase());
  return all.filter((d) => {
    const file = d.file.replace(/\\/g, '/').toLowerCase();
    const abs = d.absPath.replace(/\\/g, '/').toLowerCase();
    return wanted.some((w) => file === w || abs === w || file.endsWith('/' + w) || w.endsWith('/' + file));
  });
}

/**
 * Poll `languages.getDiagnostics()` until the filtered set stops changing.
 * That is how we know the language server finished re-analysing the edit —
 * the alternative (a fixed sleep) either fires too early or wastes seconds.
 */
export async function settleDiagnostics(
  paths: string[],
  opts: { stableMs?: number; timeoutMs?: number; minWaitMs?: number; minSeverity?: string } = {},
): Promise<{ diagnostics: DiagnosticInfo[]; settled: boolean; waitedMs: number }> {
  const cfg = getConfig();
  const stableMs = clamp(opts.stableMs ?? cfg.diagnosticsSettleMs, 0, 10000, 1200);
  const timeoutMs = clamp(opts.timeoutMs ?? cfg.diagnosticsTimeoutMs, 200, 60000, 8000);
  // A slow tsserver may publish *after* a short quiet window, which would make
  // us report "settled, no errors" too early. So also wait this long overall.
  const minWaitMs = clamp(opts.minWaitMs ?? Math.max(cfg.diagnosticsMinWaitMs, stableMs * 2), 0, 30000, 900);
  const minSeverity = opts.minSeverity ?? 'Error';
  const startedAt = Date.now();

  let lastSig: string | undefined;
  let lastChange = Date.now();
  let current: DiagnosticInfo[] = [];

  // give the analyser a moment to notice the change at all
  await sleep(Math.min(200, stableMs || 200));

  for (;;) {
    current = snapshot(paths, minSeverity);
    const sig = current.map((d) => keyOf(d, false)).join('\u00a6');
    const now = Date.now();
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = now;
    }
    const elapsed = now - startedAt;
    if (now - lastChange >= stableMs && elapsed >= minWaitMs) {
      return { diagnostics: current, settled: true, waitedMs: elapsed };
    }
    if (elapsed >= timeoutMs) {
      return { diagnostics: current, settled: elapsed - lastChange >= stableMs, waitedMs: elapsed };
    }
    await sleep(Math.max(80, Math.min(400, stableMs / 3)));
  }
}

export function diffDiagnostics(before: DiagnosticInfo[], after: DiagnosticInfo[]): {
  newErrors: DiagnosticInfo[];
  fixedErrors: DiagnosticInfo[];
  unchangedErrors: DiagnosticInfo[];
} {
  // Compare on message+file first (positions shift when code is inserted),
  // then report the *current* positions for the still-present ones.
  const beforeKeys = new Map<string, DiagnosticInfo>();
  for (const d of before) {
    beforeKeys.set(keyOf(d, true), d);
  }
  const afterKeys = new Map<string, DiagnosticInfo>();
  for (const d of after) {
    afterKeys.set(keyOf(d, true), d);
  }

  const newErrors: DiagnosticInfo[] = [];
  const unchangedErrors: DiagnosticInfo[] = [];
  const fixedErrors: DiagnosticInfo[] = [];

  for (const [k, d] of afterKeys) {
    if (beforeKeys.has(k)) {
      unchangedErrors.push(d);
    } else {
      newErrors.push(d);
    }
  }
  for (const [k, d] of beforeKeys) {
    if (!afterKeys.has(k)) {
      fixedErrors.push(d);
    }
  }
  return { newErrors, fixedErrors, unchangedErrors };
}

const SEVERITY_LABEL: Record<string, string> = {
  Error: 'Lỗi',
  Warning: 'Cảnh báo',
  Information: 'Thông tin',
  Hint: 'Gợi ý',
};

export function buildFollowUpText(diff: {
  newErrors: DiagnosticInfo[];
  fixedErrors: DiagnosticInfo[];
  unchangedErrors: DiagnosticInfo[];
}, context: { path: string; mode: string; settled: boolean }): string {
  const { newErrors, fixedErrors } = diff;
  if (!newErrors.length && !fixedErrors.length) {
    return '';
  }

  const lines: string[] = [];
  if (newErrors.length) {
    lines.push(`VSCode báo ${newErrors.length} lỗi mới sau khi áp dụng code vào \`${context.path}\` (mode: ${context.mode}):`);
    lines.push('');
    const byFile = new Map<string, DiagnosticInfo[]>();
    for (const d of newErrors) {
      const list = byFile.get(d.file) ?? [];
      list.push(d);
      byFile.set(d.file, list);
    }
    for (const [file, ds] of byFile) {
      lines.push(`\`\`\`text`);
      for (const d of ds.slice(0, 12)) {
        lines.push(`${SEVERITY_LABEL[d.severity] ?? d.severity} ${file}:${d.line}:${d.character} — ${d.message}${d.source ? ` [${d.source}${d.code ? ':' + d.code : ''}]` : ''}`);
      }
      if (ds.length > 12) {
        lines.push(`… và ${ds.length - 12} lỗi khác trong file này`);
      }
      lines.push('```');
      lines.push('');
    }
    lines.push('Hãy sửa các lỗi trên (chỉ trả về phần code cần thay đổi, kèm comment đường dẫn file ở dòng đầu).');
  } else if (fixedErrors.length) {
    lines.push(`✅ Đã áp dụng \`${context.path}\` (mode: ${context.mode}) — ${fixedErrors.length} lỗi cũ đã biến mất, không phát sinh lỗi mới.`);
  }
  if (!context.settled && newErrors.length) {
    lines.push('');
    lines.push('_(lưu ý: bộ phân tích chưa ổn định hoàn toàn, có thể còn thay đổi)_');
  }
  return lines.join('\n').trim();
}

/**
 * Full "apply → re-analyse → what changed" report used by /apply and /apply/errors.
 */
export function makeDiffReport(args: {
  targetPaths: string[];
  before: DiagnosticInfo[];
  after: DiagnosticInfo[];
  settled: boolean;
  waitedMs: number;
  path: string;
  mode: string;
}): DiagnosticDiff {
  const cfg = getConfig();
  const { newErrors, fixedErrors, unchangedErrors } = diffDiagnostics(args.before, args.after);
  const diff: DiagnosticDiff = {
    settled: args.settled,
    waitedMs: args.waitedMs,
    targetPaths: args.targetPaths,
    before: args.before,
    after: args.after,
    newErrors,
    fixedErrors,
    unchangedErrors,
    errorCountBefore: args.before.filter((d) => d.severity === 'Error').length,
    errorCountAfter: args.after.filter((d) => d.severity === 'Error').length,
    followUpText: '',
    followUpRecommended: false,
  };
  if (cfg.errorFollowUpText && (newErrors.length > 0 || (fixedErrors.length > 0 && unchangedErrors.length === 0))) {
    diff.followUpText = buildFollowUpText(diff, {
      path: args.path,
      mode: args.mode,
      settled: args.settled,
    });
    diff.followUpRecommended = diff.followUpText.length > 0 && newErrors.length > 0;
  }
  return diff;
}
