import type { S1ErrorClass } from '../../shared/systemOne.ts';

/** The TypeSafe SDK policy (CONTRACT.md §5), bounded by the caller's deadline (§5.2). */
export const RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 5_000,
  jitter: 0.25,
  maxRetryAfterMs: 60_000,
  retryCountHeader: 'X-TypeSafe-Retry-Count'
});

/** 408, 429 and every 5xx (529 included). Never 400, 401, 402, 403, 413 or 422. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

/** How many retries a failure class may use: a server error gets one, rate limits and overload two. */
export function retriesFor(errorClass: S1ErrorClass, status: number | null): number {
  if (status === null || !retryableStatus(status)) return 0;
  if (errorClass === 'server') return 1;
  return errorClass === 'rate' || errorClass === 'overloaded' || errorClass === 'timeout' ? RETRY_POLICY.maxRetries : 0;
}

/** `retry-after-ms` first, then `Retry-After` (seconds or an HTTP date), capped at 60 s; null when absent or unreadable. */
export function retryAfterMs(headers: Pick<Headers, 'get'>, now: number = Date.now()): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\s*\d+(?:\.\d+)?\s*$/u.test(ms)) return Math.min(Number(ms), RETRY_POLICY.maxRetryAfterMs);
  const raw = headers.get('retry-after');
  if (raw === null || !raw.trim()) return null;
  if (/^\s*\d+(?:\.\d+)?\s*$/u.test(raw)) return Math.min(Number(raw) * 1000, RETRY_POLICY.maxRetryAfterMs);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - now), RETRY_POLICY.maxRetryAfterMs);
}

/** 500 ms × 2^attempt, capped at 5 s, ±25% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_POLICY.backoffInitialMs * 2 ** attempt, RETRY_POLICY.backoffMaxMs);
  return Math.max(0, Math.round(base * (1 + (random() * 2 - 1) * RETRY_POLICY.jitter)));
}

/**
 * Delay before zero-based retry `attempt`, or null when it does not fit: a retry happens only if
 * now + delay + expectedLatency < deadline.
 */
export function retryDelayMs(attempt: number, headers: Pick<Headers, 'get'>, timing: { now: number; deadlineAt: number; expectedLatencyMs: number; random?: () => number }): number | null {
  const delay = retryAfterMs(headers, timing.now) ?? backoffMs(attempt, timing.random);
  return timing.now + delay + timing.expectedLatencyMs < timing.deadlineAt ? delay : null;
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
