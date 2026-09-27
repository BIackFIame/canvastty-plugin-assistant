import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ASSISTANT_CATALOG_VERSION, SYNTHETIC_STATES, USE_CASE_DEADLINES_MS, type AssistantUseCase, type QuestionSetId } from '../shared/catalog.ts';
import { answerVector, s1ErrorClass, type BackendCaps, type S1Answer, type S1BoundCredential, type S1Dialect, type S1Question } from '../shared/systemOne.ts';
import type { AssistantBackendSettings } from '../shared/settings.ts';
import { batteryRequest, batteryVector, driftOf, DRIFT_LIMIT, fingerprintOf, runConformance, type ConformanceCheck, type ConformanceReport } from './backends/capabilities.ts';
import { SystemOneHttpBackend } from './backends/SystemOneHttpBackend.ts';
import type { EmulatedSystemOneBackend } from './backends/EmulatedSystemOneBackend.ts';
import { canonicalJson, sha256 } from './AssistantCache.ts';

/**
 * The engine side of the conformance battery (assistant spec §2.4): where results live, what they switch on or
 * off in the engine, the battery for emulated backends, and the rule that one odd real 422 never disables a
 * question set unless the synthetic request reproduces it.
 *
 * The battery runs only on an explicit action («Проверить»); it is synthetic, holds no user data, and is the
 * only thing sent to a backend before a grant.
 */

// ---------------------------------------------------------------------------
// What the caps allow
// ---------------------------------------------------------------------------

/** Before any battery run the caps say `deterministic:false` and `testedAt:0`: no cache and no AUTO. */
export function engineUse(caps: BackendCaps, useCase: AssistantUseCase): { tested: boolean; cacheable: boolean; autoCapable: boolean; pinnable: boolean; fitsDeadline: boolean } {
  const tested = caps.testedAt > 0;
  const pinnable = caps.reportsVersion !== 'alias' && caps.reportsVersion !== 'none';
  return {
    tested,
    // A moving target cannot be cached or calibrated.
    cacheable: tested && caps.deterministic,
    autoCapable: tested && caps.deterministic && pinnable && caps.calibrated !== 'uncalibrated' && (caps.orderSensitivity !== 'strong' || caps.calibrated === 'fitted'),
    pinnable,
    // A use case whose deadline is below the warm p95 does not use this backend.
    fitsDeadline: !tested || caps.latencyMs.p95 <= USE_CASE_DEADLINES_MS[useCase]
  };
}

/** Which question types a backend can take for a set; a set with a type the backend lacks and cannot compile is skipped. */
export function supportsSet(caps: BackendCaps, questions: Readonly<Record<string, S1Question>>): boolean {
  return Object.values(questions).every(question => question.type === 'score' ? caps.types.score || caps.types.choice : caps.types[question.type]);
}

// ---------------------------------------------------------------------------
// Stored results
// ---------------------------------------------------------------------------

/** The part of a backend's settings its caps belong to: a changed address, model or profile is another backend. */
export function capsConfigKey(entry: AssistantBackendSettings): string {
  return sha256(canonicalJson([entry.id, entry.preset, entry.url ?? null, entry.model ?? null, entry.runtime ?? null, entry.profile ?? null]));
}

/**
 * Battery results in `userData/assistant/caps.json` (0600), written only by main after a run: the renderer
 * cannot claim a backend is calibrated. Nothing is read until the assistant needs it.
 */
export class CapsStore {
  private readonly path: string;
  private entries: Record<string, { config: string; caps: BackendCaps }> | null = null;
  private loading: Promise<void> | null = null;

  constructor(directory: string) { this.path = join(directory, 'caps.json'); }

  async load(): Promise<void> {
    if (this.entries) return;
    this.loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
        this.entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, { config: string; caps: BackendCaps }> : {};
      } catch { this.entries = {}; }
    })();
    await this.loading;
  }

  get(entry: AssistantBackendSettings): BackendCaps | null {
    const stored = this.entries?.[entry.id];
    return stored && stored.config === capsConfigKey(entry) && stored.caps && typeof stored.caps === 'object' ? structuredClone(stored.caps) : null;
  }

  async set(entry: AssistantBackendSettings, caps: BackendCaps): Promise<void> {
    await this.load();
    this.entries![entry.id] = { config: capsConfigKey(entry), caps: structuredClone(caps) };
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.entries), { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

/** A battery run on any backend kind: the settled dialect is `semif-letter` for emulated backends. */
export type BatteryReport = Omit<ConformanceReport, 'dialect' | 'gateway'> & { dialect: S1Dialect };

// ---------------------------------------------------------------------------
// The battery on an emulated backend
// ---------------------------------------------------------------------------

function knownAnswers(answers: Record<string, S1Answer>): { wrong: string[]; confidentlyWrong: boolean } {
  const wrong: string[] = [];
  let confidentlyWrong = false;
  const noul = answers.q_noul, choice = answers.q_choice, score = answers.q_score;
  if (noul?.type === 'noul' && noul.p < 0.7) { wrong.push('q_noul'); if (noul.p <= 0.2) confidentlyWrong = true; }
  if (choice?.type === 'choice' && (choice.probabilities.none_of_these ?? 0) < 0.5) { wrong.push('q_choice'); if (choice.choice !== 'none_of_these' && choice.top >= 0.8) confidentlyWrong = true; }
  if (score?.type === 'score' && score.level !== 0) { wrong.push('q_score'); if (score.top >= 0.8) confidentlyWrong = true; }
  return { wrong, confidentlyWrong };
}

/** A1, A2 and B (reversed options) through the emulated readout; the same checks as §2.4 where they apply. */
export async function runEmulatedBattery(backend: EmulatedSystemOneBackend, options: { signal: AbortSignal; credential: S1BoundCredential | null; previous?: BackendCaps | null; now?: () => number }): Promise<BatteryReport> {
  const now = options.now ?? Date.now;
  const checks: ConformanceCheck[] = [];
  const check = (id: ConformanceCheck['id'], status: ConformanceCheck['status'], detail: string): void => { checks.push({ id, status, detail }); };
  let caps = backend.caps();
  const call = () => ({ signal: options.signal, deadlineAt: now() + 60_000, credential: options.credential });
  const fail = (id: ConformanceCheck['id'], failure: ConformanceReport['failure'], detail: string, requests: number): BatteryReport => {
    check(id, 'fail', detail);
    return { added: false, caps, checks, dialect: 'semif-letter', modelLabel: null, drift: 'first', requests, failure };
  };
  let a1;
  try { a1 = await backend.evaluate(batteryRequest(backend.model), call()); } catch (error) { return fail('route', s1ErrorClass(error), 'The model did not answer the synthetic questions.', 1); }
  check('route', 'pass', 'Answered the synthetic questions.');
  const mass = Math.min(...Object.values(a1.emulated?.letterMass ?? { any: 1 }));
  if (mass < 0.5) return fail('shape', 'invalid-output', 'The model did not understand the format (letter mass below 0.5).', 1);
  const known = knownAnswers(a1.answers);
  if (known.confidentlyWrong) return fail('known-answers', null, 'Confidently wrong on a simple question: not suitable for decisions.', 1);
  check('known-answers', known.wrong.length ? 'warn' : 'pass', known.wrong.length ? `Unsure on ${known.wrong.join(', ')}.` : 'All three simple questions answered right.');
  const vector = batteryVector(a1.answers);
  let deterministic = false, orderSensitivity: BackendCaps['orderSensitivity'] = 'strong', requests = 1;
  try {
    const a2 = await backend.evaluate(batteryRequest(backend.model), call()); requests++;
    deterministic = driftOf(vector, batteryVector(a2.answers)) <= (a1.emulated?.readout && Object.values(a1.emulated.readout).includes('json') ? 0.05 : 0.01);
    const b = await backend.evaluate(batteryRequest(backend.model, true), call()); requests++;
    const score = b.answers.q_score;
    const back = score?.type === 'score' ? { ...b.answers, q_score: { ...score, probabilities: [...score.probabilities].reverse() } } : b.answers;
    const vb = batteryVector(back as Record<string, S1Answer>);
    const flip = ['q_choice', 'q_score'].some(id => {
      const x = answerVector(a1.answers[id]!, id === 'q_choice' ? ['billing', 'database', 'none_of_these'] : undefined);
      const y = answerVector((back as Record<string, S1Answer>)[id]!, id === 'q_choice' ? ['billing', 'database', 'none_of_these'] : undefined);
      return x.indexOf(Math.max(...x)) !== y.indexOf(Math.max(...y));
    });
    const variation = 0.5 * vector.reduce((sum, value, i) => sum + Math.abs(value - (vb[i] ?? 0)), 0);
    orderSensitivity = flip || variation > 0.3 ? 'strong' : variation > 0.15 ? 'mild' : 'none';
  } catch { /* a repeat that fails leaves the backend non-deterministic and order-sensitive */ }
  check('determinism', deterministic ? 'pass' : 'warn', deterministic ? 'A repeat gives the same answer.' : 'A repeat gives another answer: hints only, no cache.');
  check('option-order', orderSensitivity === 'none' ? 'pass' : 'warn', `Option order sensitivity: ${orderSensitivity}.`);
  const previous = options.previous;
  const drift: BatteryReport['drift'] = previous?.fingerprintVector?.length ? (driftOf(previous.fingerprintVector, vector) > DRIFT_LIMIT ? 'changed' : 'same') : 'first';
  caps = {
    ...caps, deterministic, orderSensitivity, letterMass: mass,
    // Emulated answers start uncalibrated; only a passing fit (§4.4) can change that.
    calibrated: drift === 'changed' ? 'uncalibrated' : caps.calibrated === 'fitted' && drift === 'same' ? 'fitted' : 'uncalibrated',
    fingerprint: fingerprintOf(vector), fingerprintVector: vector.map(value => Math.round(value * 1000) / 1000),
    testedAt: now(), latencyMs: { p50: a1.latencyMs, p95: a1.latencyMs }
  };
  if (mass < 0.9) check('shape', 'warn', 'Letter mass between 0.5 and 0.9: no automatic decisions.');
  return { added: true, caps, checks, dialect: 'semif-letter', modelLabel: a1.modelLabel, drift, requests, failure: null };
}

/** «Проверить» on any backend kind. */
export async function runBattery(backend: SystemOneHttpBackend | EmulatedSystemOneBackend, options: { signal: AbortSignal; credential: S1BoundCredential | null; previous?: BackendCaps | null; now?: () => number }): Promise<BatteryReport> {
  if (backend instanceof SystemOneHttpBackend) return runConformance(backend, { credential: options.credential, signal: options.signal, previous: options.previous ?? null, ...(options.now ? { now: options.now } : {}) });
  return runEmulatedBattery(backend, options);
}

// ---------------------------------------------------------------------------
// bad-request: incompatible only when the synthetic request reproduces it (§2.3)
// ---------------------------------------------------------------------------

export class IncompatibilityTracker {
  private readonly incompatible = new Set<string>();
  private readonly checking = new Map<string, Promise<boolean>>();

  private key(backendId: string, setId: QuestionSetId): string { return `${backendId}/${ASSISTANT_CATALOG_VERSION}/${setId}`; }

  isIncompatible(backendId: string, setId: QuestionSetId): boolean { return this.incompatible.has(this.key(backendId, setId)); }

  /**
   * After a real `bad-request`: sends the set once over its synthetic state. Only a second `bad-request` marks the
   * set incompatible with this backend (for this catalog version).
   */
  confirm(backendId: string, setId: QuestionSetId, send: (state: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
    const key = this.key(backendId, setId);
    if (this.incompatible.has(key)) return Promise.resolve(true);
    const running = this.checking.get(key);
    if (running) return running;
    const check = send(structuredClone(SYNTHETIC_STATES[setId]) as Record<string, unknown>)
      .then(() => false, error => s1ErrorClass(error) === 'bad-request')
      .then(reproduced => { if (reproduced) this.incompatible.add(key); this.checking.delete(key); return reproduced; });
    this.checking.set(key, check);
    return check;
  }

  forget(backendId: string): void { for (const key of [...this.incompatible]) if (key.startsWith(`${backendId}/`)) this.incompatible.delete(key); }
}
