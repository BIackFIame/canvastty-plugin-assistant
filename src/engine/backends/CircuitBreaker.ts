import { SystemOneError, type S1ErrorClass } from '../../shared/systemOne.ts';

/** Failures that count toward the five-in-a-row threshold. */
const COUNTED: ReadonlySet<S1ErrorClass> = new Set(['transport', 'timeout', 'server', 'overloaded', 'invalid-response', 'incomplete-answer', 'invalid-output', 'bad-request', 'version-mismatch']);
/** Failures that open the breaker at once. `auth` holds until the credential changes; the others until «Проверить снова». */
const IMMEDIATE: ReadonlySet<S1ErrorClass> = new Set(['auth', 'quota', 'unknown-model', 'not-found']);

export type BreakerHold = 'timed' | 'credential' | 'recheck';
/** What acquire() admitted: whether the call is the half-open probe, and the breaker generation it was admitted in. */
export interface BreakerAdmission { probe: boolean; generation: number }
export interface BreakerSnapshot {
  state: 'closed' | 'open' | 'half-open';
  reason: S1ErrorClass | null;
  consecutiveFailures: number;
  /** When a timed hold ends (the next real call then probes); null for other holds. */
  retryAt: number | null;
  hold: BreakerHold | null;
}

/**
 * One breaker per backend id (§5.3). There is no background probing: once a timed hold ends, or the
 * credential behind an `auth` hold changes, the next real call is the single half-open probe.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;
  private state: BreakerSnapshot['state'] = 'closed';
  private failures = 0;
  private opens = 0;
  private openUntil = 0;
  private hold: BreakerHold | null = null;
  private reason: S1ErrorClass | null = null;
  private credentialGeneration = 0;
  private probing = false;
  /** The state the probe in flight was admitted from, restored when it ends without a verdict. */
  private probeFrom: 'open' | 'half-open' | null = null;
  /** Bumped whenever the breaker opens: a call admitted before that has no say about the server any more. */
  private generation = 0;

  constructor(options: { threshold?: number; baseOpenMs?: number; maxOpenMs?: number; now?: () => number } = {}) {
    this.threshold = options.threshold ?? 5;
    this.baseOpenMs = options.baseOpenMs ?? 30_000;
    this.maxOpenMs = options.maxOpenMs ?? 600_000;
    this.now = options.now ?? Date.now;
  }

  /** Admits a real call or throws `breaker-open`. Returns whether this call is the half-open probe. */
  acquire(credentialGeneration = 0): BreakerAdmission {
    if (this.state === 'closed') return { probe: false, generation: this.generation };
    if (this.state === 'half-open') {
      if (this.probing) throw this.refusal();
      this.probing = true; this.probeFrom = 'half-open';
      return { probe: true, generation: this.generation };
    }
    const due = this.hold === 'timed' ? this.now() >= this.openUntil : this.hold === 'credential' && credentialGeneration !== this.credentialGeneration;
    if (!due) throw this.refusal();
    this.state = 'half-open'; this.probing = true; this.probeFrom = 'open';
    return { probe: true, generation: this.generation };
  }

  /**
   * A call the server answered. With its admission, a late answer to a call admitted before the breaker last opened
   * changes nothing, and only the half-open probe closes a breaker that is not closed.
   */
  success(admission?: BreakerAdmission): void {
    if (admission && (admission.generation !== this.generation || this.state !== 'closed' && !(admission.probe && this.probing))) return;
    this.state = 'closed'; this.failures = 0; this.opens = 0; this.hold = null; this.reason = null; this.probing = false; this.probeFrom = null; this.openUntil = 0;
  }

  /**
   * An admitted call that ended without a verdict on the server: nothing was sent (a deadline that ran out
   * first), or the caller cancelled it. Nothing is counted, and a probe gives its slot back, so the next real
   * call is the probe again. `admission` is what acquire() returned: a call that was not the probe leaves the
   * slot alone.
   */
  release(admission?: { probe: boolean }): void {
    if (!this.probing || admission && !admission.probe) return;
    if (this.probeFrom === 'open') this.state = 'open';
    this.probing = false; this.probeFrom = null;
  }

  failure(errorClass: S1ErrorClass, credentialGeneration = 0, admission?: BreakerAdmission): void {
    // Rate limits and cancelled calls say nothing about the server's health.
    if (!IMMEDIATE.has(errorClass) && !COUNTED.has(errorClass)) { this.release(admission); return; }
    // A call admitted before the breaker last opened: that opening already counted the server's state.
    if (admission && admission.generation !== this.generation) return;
    const probe = this.state === 'half-open';
    this.probing = false; this.probeFrom = null;
    if (IMMEDIATE.has(errorClass)) {
      this.open(errorClass, errorClass === 'auth' ? 'credential' : 'recheck');
      this.credentialGeneration = credentialGeneration;
      return;
    }
    this.failures++;
    if (probe || this.failures >= this.threshold) this.open(errorClass, 'timed');
  }

  /** «Проверить снова»: lifts timed, quota, unknown-model and not-found holds. An `auth` hold waits for a new key. */
  recheck(): void {
    if (this.state === 'closed' || this.hold === 'credential') return;
    this.state = 'half-open'; this.probing = false; this.probeFrom = null;
  }

  snapshot(): BreakerSnapshot {
    return { state: this.state, reason: this.reason, consecutiveFailures: this.failures, retryAt: this.state === 'open' && this.hold === 'timed' ? this.openUntil : null, hold: this.state === 'closed' ? null : this.hold };
  }

  private open(reason: S1ErrorClass, hold: BreakerHold): void {
    this.opens++; this.generation++;
    this.state = 'open'; this.hold = hold; this.reason = reason;
    this.openUntil = hold === 'timed' ? this.now() + Math.min(this.maxOpenMs, this.baseOpenMs * 2 ** (this.opens - 1)) : 0;
  }

  private refusal(): SystemOneError {
    return new SystemOneError('breaker-open', `System One backend is paused (${this.reason ?? 'probe in flight'}).`);
  }
}
