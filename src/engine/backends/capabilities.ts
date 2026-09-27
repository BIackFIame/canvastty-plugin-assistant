import {
  answerVector, s1ErrorClass, scoreAnswer,
  type BackendCaps, type S1Answer, type S1BoundCredential, type S1ErrorClass, type S1Question, type S1Request
} from '../../shared/systemOne.ts';
import { decodeResponse, detectDialect, detectHealthDialect, type DecodedResponse, type HttpDialect } from './dialects.ts';
import { capsWithinDialect, modelLabel, presetCaps, sha256Hex } from './systemOneRoutes.ts';
import type { RawExchange, SystemOneHttpBackend } from './SystemOneHttpBackend.ts';

/**
 * Capability detection and the conformance battery (§2.4). It runs only on an explicit action (adding a
 * backend, «Проверить», or the first use after a version or fingerprint change), never in the background.
 * The battery is fixed, synthetic and holds no user data, so it may be sent before any grant.
 */
export const BATTERY_STATE = Object.freeze({ event: 'CI run finished', exit_code: 0, tests: Object.freeze({ passed: 12, failed: 0 }), changed_files: Object.freeze(['docs/README.md']) });
const Q_NOUL: S1Question = { type: 'noul', instructions: 'Did every test in `tests` pass?', criteria: { true: 'Every test passed', false: 'At least one test failed' } };
const CHOICE_OPTIONS: [string, string][] = [['billing', 'Payment or invoice code'], ['database', 'Database schema or migrations'], ['none_of_these', 'None of the listed areas']];
const SCORE_LEVELS = ['Harmless: documentation only', 'Code that needs a quick review', 'Code that could break production'];

/** The battery request; `reversed` reverses the choice options and the score levels (run B). */
export function batteryRequest(model: string, reversed = false): S1Request {
  const options = reversed ? [...CHOICE_OPTIONS].reverse() : CHOICE_OPTIONS;
  return {
    model, state: structuredClone(BATTERY_STATE) as unknown as Record<string, unknown>,
    questions: {
      q_noul: Q_NOUL,
      q_choice: { type: 'choice', instructions: 'Which area of the code do `changed_files` belong to?', criteria: Object.fromEntries(options) },
      q_score: { type: 'score', instructions: 'How risky is merging a change to `changed_files`?', criteria: reversed ? [...SCORE_LEVELS].reverse() : [...SCORE_LEVELS] }
    }
  };
}

/** A score question asked as a choice over its levels, for a backend without score support (§2.4 step 4). */
function scoreAsChoice(request: S1Request): S1Request {
  const questions = { ...request.questions };
  const score = questions.q_score;
  if (score?.type === 'score') questions.q_score = { type: 'choice', instructions: score.instructions, criteria: Object.fromEntries(score.criteria.map((level, i) => [String(i), level])) };
  return { ...request, questions };
}

export type ConformanceCheckId = 'probe' | 'route' | 'shape' | 'score' | 'known-answers' | 'determinism' | 'option-order' | 'model-identity' | 'latency' | 'sessions' | 'max-questions' | 'key';
export interface ConformanceCheck { id: ConformanceCheckId; status: 'pass' | 'warn' | 'fail' | 'skip'; detail: string }
export interface ConformanceReport {
  /** No check failed: the backend may be connected (it starts in Learning). */
  added: boolean;
  caps: BackendCaps;
  checks: ConformanceCheck[];
  dialect: HttpDialect;
  /** `id`, `provider` or `usage.cost` seen: an OpenRouter-style gateway. */
  gateway: boolean;
  /** Never the raw id: an Eikos path becomes basename#hash. */
  modelLabel: string | null;
  /** 'changed' is «модель сменилась»: the first vector moved by L∞ > 0.03 from the stored fingerprint. */
  drift: 'first' | 'same' | 'changed';
  /** POSTs and DELETEs this run sent (read-only probes excluded); at most 10. */
  requests: number;
  failure: S1ErrorClass | null;
}

export interface ConformanceOptions {
  credential: string | S1BoundCredential | null;
  signal: AbortSignal;
  /** The caps stored by the previous run (drift, calibration). */
  previous?: BackendCaps | null;
  now?: () => number;
  /** Per request; the preset's cold attempt timeout by default. */
  timeoutMs?: number;
}

const PROBE_PATHS = ['/v1/limits', '/api/capabilities', '/v1/models', '/health', '/v1/health', '/healthz'];
export const DRIFT_LIMIT = 0.03;
const SESSION_TOLERANCE = 0.02;

function positiveInt(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }

/** Limits a server reports (`/v1/limits`) may only lower the preset's. */
export function lowerLimits(caps: BackendCaps, reported: unknown): BackendCaps {
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) return caps;
  const limits = reported as Record<string, unknown>;
  const next = structuredClone(caps);
  const lower = (key: 'maxQuestions' | 'maxOptions' | 'maxStateTokensPerQuestion', value: number | null): void => {
    if (value !== null && value < next[key]) { next[key] = value; next.limitsSource = 'server'; }
  };
  lower('maxQuestions', positiveInt(limits.max_questions));
  lower('maxOptions', positiveInt(limits.max_answers_per_question));
  const tokens = positiveInt(limits.max_input_tokens);
  lower('maxStateTokensPerQuestion', tokens);
  if (tokens !== null && next.contextTokens > 0 && tokens < next.contextTokens) { next.contextTokens = tokens; next.limitsSource = 'server'; }
  return next;
}

/** The battery's probability vector in a fixed order: q_noul, q_choice by label, q_score by level. */
export function batteryVector(answers: Record<string, S1Answer>): number[] {
  return [
    ...answerVector(answers.q_noul!).slice(0, 1),
    ...answerVector(answers.q_choice!, CHOICE_OPTIONS.map(([label]) => label)),
    ...answerVector(answers.q_score!)
  ];
}

/** sha256 of the vector rounded to 3 decimals (§2.2). */
export function fingerprintOf(vector: readonly number[]): string {
  return sha256Hex(JSON.stringify(vector.map(value => Math.round(value * 1000) / 1000)));
}

export function driftOf(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  return a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i]!)), 0);
}

/** Run B's answers mapped back to run A's labels: choice by label, score level′ = n − 1 − level. */
function unreverse(answers: Record<string, S1Answer>): Record<string, S1Answer> {
  const score = answers.q_score;
  if (score?.type !== 'score') return answers;
  return { ...answers, q_score: { ...score, probabilities: [...score.probabilities].reverse() } };
}

function totalVariation(a: readonly number[], b: readonly number[]): number {
  return 0.5 * a.reduce((sum, value, i) => sum + Math.abs(value - (b[i] ?? 0)), 0);
}

function argmax(vector: readonly number[]): number { return vector.indexOf(Math.max(...vector)); }

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

const ROUTE_DETAIL: Partial<Record<S1ErrorClass, string>> = {
  auth: 'The key was refused.',
  quota: 'The account has no credit left.',
  'not-found': 'There is no /v1/systemone at this address.',
  transport: 'The server did not answer. Is it running?',
  timeout: 'The server did not answer in time.',
  'unknown-model': 'The server does not know this model.',
  'invalid-response': 'The server did not answer like a System One server.',
  'incomplete-answer': 'The server left out answer probabilities.',
  'version-mismatch': 'The server answered with another model.'
};

/**
 * Runs the probes and the battery against `backend` and returns the new caps. A full run sends at most
 * 10 requests: A1, A2 and B, the 16-question probe, the wrong-key probe (a loopback server with a key) and,
 * on the eikos dialect only, 5 sessions calls.
 */
export async function runConformance(backend: SystemOneHttpBackend, options: ConformanceOptions): Promise<ConformanceReport> {
  const preset = backend.presetInfo;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? Math.max(preset.attemptTimeoutMs.cold, 5_000);
  const call = () => ({ signal: options.signal, deadlineAt: now() + timeoutMs, credential: options.credential });
  const checks: ConformanceCheck[] = [];
  const check = (id: ConformanceCheckId, status: ConformanceCheck['status'], detail: string): void => { checks.push({ id, status, detail }); };
  let requests = 0;
  let caps = presetCaps(preset, backend.model);
  let dialect: HttpDialect = preset.dialect;
  let gateway = false;

  // Read-only probes, a person's server only; the first route that answers is used.
  let healthDialect: HttpDialect | null = null;
  if (!preset.fixedUrl) {
    let answered = false;
    for (const path of PROBE_PATHS) {
      const probe = await backend.probe(path, call());
      if (probe.status !== 200 || probe.json === null) continue;
      if (path === '/v1/limits') caps = lowerLimits(caps, probe.json);
      healthDialect = detectHealthDialect(probe.json);
      check('probe', 'pass', `${path} answered${healthDialect ? ` (${healthDialect})` : ''}.`);
      answered = true;
      break;
    }
    if (!answered) check('probe', 'skip', 'No read-only route answered; the battery decides.');
    if (preset.id === 'custom' && healthDialect) dialect = healthDialect;
  }

  const fail = (id: ConformanceCheckId, failure: S1ErrorClass | null, detail: string): ConformanceReport => {
    check(id, 'fail', detail);
    return { added: false, caps, checks, dialect, gateway, modelLabel: null, drift: 'first', requests, failure };
  };

  // A1. A score 422 (or an unreadable score answer) is the score probe: scores are then asked as choices.
  let scoreSupported = true;
  const send = async (request: S1Request): Promise<RawExchange> => {
    requests++;
    return backend.exchange(scoreSupported ? request : scoreAsChoice(request), { ...call(), dialect });
  };
  let a1: RawExchange;
  try {
    a1 = await send(batteryRequest(backend.model));
  } catch (error) {
    const failure = s1ErrorClass(error);
    if (failure !== 'bad-request') return fail('route', failure, ROUTE_DETAIL[failure ?? 'transport'] ?? `The server refused the request (${failure}).`);
    scoreSupported = false;
    try { a1 = await send(batteryRequest(backend.model)); }
    catch (retry) { const again = s1ErrorClass(retry); return fail('route', again, ROUTE_DETAIL[again ?? 'transport'] ?? `The server refused the request (${again}).`); }
  }
  if (preset.id === 'custom') ({ dialect, gateway } = detectDialect(a1.json));
  else gateway = detectDialect(a1.json).gateway;

  // Decodes one battery run; scores asked as choices come back as a score vector over the same levels.
  const decode = (exchange: RawExchange, reversed: boolean): { decoded: DecodedResponse; answers: Record<string, S1Answer> } => {
    const request = batteryRequest(backend.model, reversed);
    const decoded = decodeResponse(dialect, exchange.json, scoreSupported ? request : scoreAsChoice(request), { modelRule: backend.modelRule });
    const answers = { ...decoded.answers };
    const asked = answers.q_score;
    if (asked?.type === 'choice') answers.q_score = scoreAnswer(Object.keys(asked.probabilities).map(level => asked.probabilities[level]!));
    return { decoded, answers };
  };
  let run: { decoded: DecodedResponse; answers: Record<string, S1Answer> };
  try {
    run = decode(a1, false);
  } catch (error) {
    // A noul or choice failure refuses the backend; a score-only failure turns scores into choices.
    const shapeFailure = (cause: unknown): ConformanceReport => fail('shape', s1ErrorClass(cause), 'The answers do not have the System One shape.');
    if (!scoreSupported) return shapeFailure(error);
    const full = batteryRequest(backend.model);
    try { decodeResponse(dialect, a1.json, { ...full, questions: { q_noul: full.questions.q_noul!, q_choice: full.questions.q_choice! } }, { modelRule: backend.modelRule }); }
    catch (subset) { return shapeFailure(subset); }
    scoreSupported = false;
    try { a1 = await send(batteryRequest(backend.model)); run = decode(a1, false); }
    catch (retry) { return shapeFailure(retry); }
  }
  const first = run.decoded, answersA1 = run.answers;
  check('route', 'pass', `Answered in the ${dialect} shape.`);
  check('shape', 'pass', 'Every answer has the right type, labels and probabilities.');
  check('score', scoreSupported ? 'pass' : 'warn', scoreSupported ? 'Scores are supported.' : 'No scores: they are asked as a choice over the same levels.');
  caps.types.score = scoreSupported;
  caps.dialect = dialect;
  // A custom server found to be Laya or Eikos takes that dialect's limits (Laya per checkpoint, english when
  // the configured model names none), so a state it would truncate or refuse is skipped, never sent.
  caps = capsWithinDialect(caps, dialect, backend.model);

  // The pin rule of a cloud route.
  const reported = first.reportedModel;
  try { preset.acceptModel(backend.model, reported, { modelHash: null, fingerprint: null, routingModel: first.routingModel, unstable: false }); }
  catch (error) { return fail('model-identity', s1ErrorClass(error), 'The server answered with another model.'); }

  // Known answers.
  const noul = answersA1.q_noul!, choice = answersA1.q_choice!, score = answersA1.q_score!;
  const wrong: { id: string; top: number }[] = [];
  if (noul.type === 'noul' && noul.p < 0.7) wrong.push({ id: 'q_noul', top: noul.top });
  if (choice.type === 'choice' && (choice.choice !== 'none_of_these' || (choice.probabilities.none_of_these ?? 0) < 0.5)) wrong.push({ id: 'q_choice', top: choice.top });
  if (score.type === 'score' && score.level !== 0) wrong.push({ id: 'q_score', top: Math.max(...score.probabilities) });
  const confidentlyWrong = wrong.some(item => item.top >= 0.8);
  if (confidentlyWrong) return fail('known-answers', null, 'Confidently wrong on a simple question: not suitable for decisions.');
  check('known-answers', wrong.length ? 'warn' : 'pass', wrong.length ? `Unsure on ${wrong.map(item => item.id).join(', ')}: no automatic decisions until a calibration fit passes.` : 'All three simple questions answered right.');

  // A2 (determinism) and B (option order).
  const latencies: number[] = [];
  let answersA2: Record<string, S1Answer> | null = null, answersB: Record<string, S1Answer> | null = null;
  const models = new Set([reported]);
  try { const a2 = await send(batteryRequest(backend.model)); const decoded = decode(a2, false); answersA2 = decoded.answers; models.add(decoded.decoded.reportedModel); latencies.push(a2.latencyMs); } catch { answersA2 = null; }
  try { const b = await send(batteryRequest(backend.model, true)); const decoded = decode(b, true); answersB = unreverse(decoded.answers); models.add(decoded.decoded.reportedModel); latencies.push(b.latencyMs); } catch { answersB = null; }
  const vectorA1 = batteryVector(answersA1);
  const determinism = answersA2 ? driftOf(vectorA1, batteryVector(answersA2)) : Infinity;
  caps.deterministic = determinism <= preset.determinismTolerance;
  check('determinism', caps.deterministic ? 'pass' : 'warn', caps.deterministic ? `Repeat within ${preset.determinismTolerance}.` : 'A repeat gives another answer: hints only, no cache.');
  if (answersB) {
    let flip = false, variation = 0;
    for (const id of ['q_choice', 'q_score']) {
      const labels = id === 'q_choice' ? CHOICE_OPTIONS.map(([label]) => label) : undefined;
      const a = answerVector(answersA1[id]!, labels), b = answerVector(answersB[id]!, labels);
      flip ||= argmax(a) !== argmax(b);
      variation = Math.max(variation, totalVariation(a, b));
    }
    caps.orderSensitivity = flip || variation > 0.3 ? 'strong' : variation > 0.15 ? 'mild' : 'none';
    check('option-order', caps.orderSensitivity === 'none' ? 'pass' : 'warn', caps.orderSensitivity === 'none' ? 'Option order does not matter.' : caps.orderSensitivity === 'mild' ? 'Option order matters a little: both orders are asked and averaged.' : 'Option order changes the answer: both orders are asked, and it stays uncalibrated.');
  } else {
    caps.orderSensitivity = 'strong';
    check('option-order', 'warn', 'The reversed run failed: both orders are asked, and it stays uncalibrated.');
  }
  const stable = models.size === 1;
  caps.reportsVersion = stable ? preset.reportsVersion : 'none';
  check('model-identity', stable ? 'pass' : 'warn', stable ? `Answers as ${modelLabel(reported, preset.id)}.` : 'The reported model changes between calls: it cannot be pinned.');

  // Sessions, eikos only: create, append, ask, the same question stateless, delete.
  if (dialect === 'eikos') {
    const text = JSON.stringify(BATTERY_STATE), half = Math.floor(text.length / 2);
    let sessionId: string | null = null;
    let sessionP: number | null = null, statelessP: number | null = null, sessionMs = 0, statelessMs = 0;
    try {
      requests++;
      const created = await backend.call('POST', '/v1/sessions', { state: text.slice(0, half) }, call());
      const id = (created.json as { session_id?: unknown } | null)?.session_id;
      if (created.status === 200 && typeof id === 'string' && /^[0-9a-f]{16}$/u.test(id)) {
        sessionId = id;
        requests++;
        const appended = await backend.call('POST', `/v1/sessions/${id}/append`, { text: text.slice(half) }, call());
        if (appended.status === 200) {
          requests++;
          let started = now();
          const asked = await backend.call('POST', `/v1/sessions/${id}/systemone`, { questions: { q_noul: Q_NOUL } }, call());
          sessionMs = now() - started;
          const single = { model: backend.model, state: text, questions: { q_noul: Q_NOUL } };
          if (asked.status === 200) sessionP = (decodeResponse('eikos', asked.json, single, { modelRule: 'any' }).answers.q_noul as { p: number }).p;
          started = now();
          const stateless = await send(single);
          statelessMs = now() - started;
          statelessP = (decodeResponse('eikos', stateless.json, single, { modelRule: 'any' }).answers.q_noul as { p: number }).p;
          latencies.push(stateless.latencyMs);
        }
      }
    } catch { sessionP = null; }
    finally {
      if (sessionId) { requests++; await backend.call('DELETE', `/v1/sessions/${sessionId}`, undefined, call()).catch(() => undefined); }
    }
    caps.sessions = sessionP !== null && statelessP !== null && Math.abs(sessionP - statelessP) <= SESSION_TOLERANCE;
    caps.sessionSpeedup = caps.sessions && sessionMs > 0 ? statelessMs / sessionMs : null;
    check('sessions', caps.sessions ? 'pass' : 'skip', caps.sessions ? 'Sessions work and match stateless answers.' : 'No sessions: the whole state is sent each time.');
  } else check('sessions', 'skip', 'This server has no sessions.');

  // 16 trivial nouls confirm maxQuestions ≥ 16 (the largest catalog request has 10).
  if (caps.maxQuestions >= 16) {
    const questions = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`n${i}`, { type: 'noul', instructions: `Is \`n\` equal to ${i}?`, criteria: { true: `n is ${i}`, false: `n is not ${i}` } } satisfies S1Question]));
    try {
      const probe = await send({ model: backend.model, state: { n: 3 }, questions });
      decodeResponse(dialect, probe.json, { model: backend.model, state: { n: 3 }, questions }, { modelRule: backend.modelRule });
      latencies.push(probe.latencyMs);
      check('max-questions', 'pass', '16 questions in one request.');
    } catch {
      caps.maxQuestions = 3; caps.limitsSource = 'observed';
      check('max-questions', 'warn', 'Fewer than 16 questions per request: requests are split.');
    }
  }

  // A wrong key must be refused (a loopback server with a key configured).
  if (backend.locality === 'loopback' && options.credential !== null) {
    requests++;
    const wrongKey = typeof options.credential === 'string' ? `wrong-${sha256Hex(options.credential).slice(0, 12)}` : { origin: options.credential.origin, value: `wrong-${sha256Hex(options.credential.value).slice(0, 12)}` };
    try {
      await backend.exchange({ model: backend.model, state: 'x', questions: { q: Q_NOUL } }, { ...call(), credential: wrongKey, dialect });
      caps.keyEnforced = false;
    } catch (error) { caps.keyEnforced = s1ErrorClass(error) === 'auth' ? true : false; }
    check('key', caps.keyEnforced ? 'pass' : 'warn', caps.keyEnforced ? 'The server checks its key.' : 'The server does not check the key.');
  } else caps.keyEnforced = options.credential !== null && preset.fixedUrl ? true : null;

  const warm = latencies.length ? latencies : [a1.latencyMs];
  caps.latencyMs = { p50: percentile(warm, 0.5), p95: percentile(warm, 0.95), cold: a1.latencyMs };
  check('latency', 'pass', `Warm p50 ${caps.latencyMs.p50} ms, p95 ${caps.latencyMs.p95} ms; first answer ${a1.latencyMs} ms.`);

  const previous = options.previous ?? null;
  const drift = previous?.fingerprintVector?.length ? (driftOf(vectorA1, previous.fingerprintVector) > DRIFT_LIMIT ? 'changed' : 'same') : 'first';
  caps.fingerprintVector = vectorA1.map(value => Math.round(value * 1000) / 1000);
  caps.fingerprint = fingerprintOf(vectorA1);
  caps.modelHash = sha256Hex(reported);
  caps.decimals = first.decimals;
  caps.calibrated = wrong.length || caps.orderSensitivity === 'strong' ? 'uncalibrated'
    : previous?.calibrated === 'fitted' && drift === 'same' ? 'fitted' : preset.calibrated;
  caps.testedAt = now();
  return { added: !checks.some(item => item.status === 'fail'), caps, checks, dialect, gateway, modelLabel: modelLabel(reported, preset.id), drift, requests, failure: null };
}
