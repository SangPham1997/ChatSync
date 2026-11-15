import * as http from 'http';
import { ChatSyncConfig } from './config';

const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
  'chatsync.local',
]);

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

export interface OriginVerdict {
  ok: boolean;
  echo?: string;
  reason?: string;
}

function matchPattern(pattern: string, origin: string): boolean {
  const p = pattern.trim().toLowerCase();
  const o = origin.toLowerCase();
  if (!p) {
    return false;
  }
  if (p === '*') {
    return true;
  }
  if (p === o) {
    return true;
  }
  // scheme://*.domain[:port]
  const m = /^([a-z]+):\/\/(\*\.)?([^/:]+)(:\d+|\:\*)?$/.exec(p);
  if (!m) {
    return false;
  }
  const [, scheme, wild, domain, portPart] = m;
  const om = /^([a-z]+):\/\/([^/:]+)(:\d+)?$/.exec(o);
  if (!om) {
    return false;
  }
  const [, oScheme, oHost, oPort] = om;
  if (oScheme !== scheme) {
    return false;
  }
  const hostOk = wild ? oHost === domain || oHost.endsWith('.' + domain) : oHost === domain;
  if (!hostOk) {
    return false;
  }
  if (!portPart) {
    return true;
  }
  if (portPart === ':*') {
    return true;
  }
  return (oPort ?? '') === portPart;
}

/**
 * CORS gate.
 * - `Origin` present  -> must match the allowlist (or be a localhost origin).
 * - `Origin` absent   -> allowed: curl / native apps / GM_xmlhttpRequest (no CORS in play).
 */
export function checkOrigin(req: http.IncomingMessage, cfg: ChatSyncConfig): OriginVerdict {
  const origin = (req.headers.origin ?? '').toString().trim();
  if (!origin) {
    return { ok: true };
  }
  if (origin === 'null') {
    // sandboxed iframe / file:// — reject, cannot be verified
    return { ok: false, reason: 'opaque origin' };
  }
  if (LOCAL_ORIGIN_RE.test(origin)) {
    return { ok: true, echo: origin };
  }
  for (const pattern of cfg.allowedOrigins ?? []) {
    if (matchPattern(pattern, origin)) {
      return { ok: true, echo: origin };
    }
  }
  return { ok: false, reason: `origin not allowed: ${origin}` };
}

/**
 * Anti DNS-rebinding: the Host header must point at loopback.
 */
export function checkHost(req: http.IncomingMessage): boolean {
  const raw = (req.headers.host ?? '').toString().trim().toLowerCase();
  if (!raw) {
    return false;
  }
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  if (ALLOWED_HOSTS.has(host)) {
    return true;
  }
  // IPv6 without brackets, e.g. "::1:3847" — be permissive for loopback forms
  return host.endsWith('::1') || host === '127.0.0.1';
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function extractToken(req: http.IncomingMessage, url: URL): string | undefined {
  const header = req.headers['x-chatsync-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) {
    return fromHeader.toString().trim();
  }
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const q = url.searchParams.get('token');
  return q ? q.trim() : undefined;
}

/* ------------------------------------------------------------------ *
 * Simple sliding-window rate limiter (localhost only)
 * ------------------------------------------------------------------ */

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private limitPerMinute: number) {}

  setLimit(limitPerMinute: number): void {
    this.limitPerMinute = limitPerMinute;
  }

  allow(key: string, now = Date.now()): boolean {
    if (this.limitPerMinute <= 0) {
      return true;
    }
    const windowStart = now - 60_000;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 64) {
      // opportunistic cleanup
      for (const [k, v] of this.hits) {
        const fresh = v.filter((t) => t > windowStart);
        if (fresh.length === 0) {
          this.hits.delete(k);
        } else {
          this.hits.set(k, fresh);
        }
      }
    }
    return arr.length <= this.limitPerMinute;
  }
}
