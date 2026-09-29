import { LOCAL_CONCURRENCY, USE_CASE_PER_MINUTE, type AssistantUseCase } from '../shared/catalog.ts';

/**
 * Budgets (assistant spec §5.5). Every slot is reserved synchronously, before any `await`, so concurrent calls
 * can never overshoot a cap. A spent budget is a fallback (R4): the assistant-off behaviour, never an allow.
 */

export interface BudgetLimits { perMinute: number; perDay: number; cloudUsdPerDay: number }
export interface BudgetRequest {
  useCase: AssistantUseCase; cloud: boolean; sessionId?: string;
  /** A cloud call's most it can cost: held against the day's cap while it runs, so parallel calls cannot overshoot. */
  estimateUsd?: number;
}
export interface Reservation {
  /** The request was sent: keep the slot, and add its cost to the day (the held estimate when the cost is unknown). */
  commit(costUsd: number | null): void;
  /** Nothing was sent: give the slot back. */
  release(): void;
}
export type BudgetRefusal = 'assistant-minute' | 'assistant-day' | 'cloud-spend' | 'use-case-minute';

const MINUTE = 60_000;

function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export class AssistantBudget {
  private readonly limits: () => BudgetLimits;
  private readonly now: () => number;
  private minute: number[] = [];
  private readonly useCaseMinute = new Map<AssistantUseCase, number[]>();
  private day = '';
  private dayCalls = 0;
  private daySpend = 0;
  /** Estimates of cloud calls still running today. */
  private dayHeld = 0;
  private localActive = 0;
  private readonly localQueue: Array<() => void> = [];

  constructor(options: { limits: () => BudgetLimits; now?: () => number }) {
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
  }

  private roll(at: number): void {
    const key = dayKey(at);
    if (key !== this.day) { this.day = key; this.dayCalls = 0; this.daySpend = 0; this.dayHeld = 0; }
    const cutoff = at - MINUTE;
    this.minute = this.minute.filter(t => t > cutoff);
    for (const [key2, list] of this.useCaseMinute) this.useCaseMinute.set(key2, list.filter(t => t > cutoff));
  }

  /** What would refuse this request now, or null. */
  refusal(request: BudgetRequest): BudgetRefusal | null {
    const at = this.now();
    this.roll(at);
    const limits = this.limits();
    if (this.minute.length >= limits.perMinute) return 'assistant-minute';
    if (this.dayCalls >= limits.perDay) return 'assistant-day';
    if (request.cloud) {
      const committed = this.daySpend + this.dayHeld;
      if (committed >= limits.cloudUsdPerDay || committed + estimate(request) > limits.cloudUsdPerDay) return 'cloud-spend';
    }
    if ((this.useCaseMinute.get(request.useCase)?.length ?? 0) >= USE_CASE_PER_MINUTE[request.useCase]) return 'use-case-minute';
    return null;
  }

  /** Synchronous: a slot, or null when any cap is reached. */
  reserve(request: BudgetRequest): Reservation | null {
    if (this.refusal(request)) return null;
    const at = this.now();
    this.minute.push(at);
    this.dayCalls++;
    const perUseCase = this.useCaseMinute.get(request.useCase) ?? [];
    perUseCase.push(at); this.useCaseMinute.set(request.useCase, perUseCase);
    const held = request.cloud ? estimate(request) : 0;
    this.dayHeld += held;
    const day = this.day;
    let settled = false;
    const unhold = (): void => { if (day === this.day) this.dayHeld = Math.max(0, this.dayHeld - held); };
    return {
      commit: (costUsd) => {
        if (settled) return;
        settled = true;
        unhold();
        const known = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0;
        const cost = known ? costUsd : held;
        if (request.cloud && cost > 0 && day === this.day) this.daySpend += cost;
      },
      release: () => {
        if (settled) return;
        settled = true;
        unhold();
        const drop = (list: number[] | undefined): void => { const i = list?.lastIndexOf(at) ?? -1; if (list && i >= 0) list.splice(i, 1); };
        drop(this.minute); drop(this.useCaseMinute.get(request.useCase));
        if (day !== this.day) return;
        this.dayCalls = Math.max(0, this.dayCalls - 1);
      }
    };
  }

  /**
   * A local backend runs one request at a time with a queue of at most 4 (§5.5). Admission is synchronous:
   * null means the queue is full (`budget`). The returned promise resolves when it is this call's turn.
   */
  local(signal?: AbortSignal): { ready: Promise<void>; release(): void } | null {
    if (this.localActive < LOCAL_CONCURRENCY.inFlight) {
      this.localActive++;
      return { ready: Promise.resolve(), release: once(() => this.releaseLocal()) };
    }
    if (this.localQueue.length >= LOCAL_CONCURRENCY.queue) return null;
    // An abort that already happened fires no event: never queue such a call.
    if (signal?.aborted) {
      const ready = Promise.reject(signal.reason ?? new Error('aborted'));
      ready.catch(() => undefined);
      return { ready, release: () => undefined };
    }
    let admitted = false;
    let wake!: () => void;
    let onAbort: (() => void) | null = null;
    const unlisten = (): void => { if (onAbort) signal?.removeEventListener('abort', onAbort); onAbort = null; };
    const ready = new Promise<void>((resolve, reject) => {
      wake = () => { admitted = true; unlisten(); resolve(); };
      if (!signal) return;
      onAbort = () => {
        unlisten();
        const i = this.localQueue.indexOf(wake);
        if (i >= 0) { this.localQueue.splice(i, 1); reject(signal.reason ?? new Error('aborted')); }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    this.localQueue.push(wake);
    return { ready, release: once(() => { unlisten(); if (admitted) this.releaseLocal(); else { const i = this.localQueue.indexOf(wake); if (i >= 0) this.localQueue.splice(i, 1); } }) };
  }

  private releaseLocal(): void {
    const next = this.localQueue.shift();
    if (next) next(); else this.localActive = Math.max(0, this.localActive - 1);
  }

  /** For the checklist: whether the day's cloud spend or calls ran out. */
  spent(): { calls: number; usd: number } { this.roll(this.now()); return { calls: this.dayCalls, usd: this.daySpend }; }
}

function estimate(request: BudgetRequest): number {
  const value = request.estimateUsd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function once(fn: () => void): () => void {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}
