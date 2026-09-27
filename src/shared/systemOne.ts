/**
 * The System One wire contract (TypeSafe Jev and every compatible server) and CanvasTTY's canonical
 * answer shape. Every probability-derived number a consumer sees is computed here from the normalized
 * vector; a backend's own `confidence`, `score`, `expected` and `value` never decide anything.
 *
 * Shared by main and renderer: no Node APIs.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type S1Instructions = string | { question: string; [field: string]: string | string[] };
/** A `null` description means "read the label alone" (TypeSafe); the eikos codec sends the label instead. */
export type S1ChoiceDescription = string | Record<string, string | string[]> | null;
export type S1Question =
  | { type: 'noul'; instructions: S1Instructions; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: S1Instructions; criteria: Record<string, S1ChoiceDescription> } // 2..255 labels
  | { type: 'score'; instructions: S1Instructions; criteria: string[] };                             // 2..10 levels, index 0 lowest
export type S1State = string | Record<string, unknown> | unknown[];
export interface S1Request { model: string; state: S1State; questions: Record<string, S1Question> }

// ---------------------------------------------------------------------------
// Canonical answers
// ---------------------------------------------------------------------------

/**
 * What every consumer sees. The backend's own `confidence` is kept as vendorConfidence and never gated on.
 * `uncalibrated` marks an answer that is a hint only, never `confident` and never fitted: a tournament over
 * more options than one pass can read, or the emulated JSON-schema mode (verbalized probabilities, §2.5).
 */
export type S1Answer =
  | { type: 'noul'; p: number; top: number; margin: number; conf: number; uncalibrated?: true }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; top: number; second: number; margin: number; n: number; conf: number; uncalibrated?: true }
  | { type: 'score'; level: number; expectation: number; probabilities: number[]; top: number; margin: number; n: number; conf: number; adjacentMass: number; uncalibrated?: true };

export type S1CostSource = 'reported' | 'price-table' | 'none';
export interface S1Usage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: S1CostSource }

export interface S1Result {
  answers: Record<string, S1Answer>;
  /** As returned; kept in memory only. Logs and the UI get `modelLabel`, because Eikos returns a filesystem path. */
  reportedModel: string;
  modelLabel: string;
  /** Parsed per preset: jev-1.13.0, typesafe/jev-1.13-20260917, a Laya checkpoint, an Eikos fingerprint; null when unpinnable. */
  resolvedVersion: string | null;
  usage: S1Usage;
  /** x-typesafe-request-id, OpenRouter `id`, Vercel `generationId`. Not secret. */
  requestId: string | null;
  latencyMs: number;
  attempts: number;
  decimals: number | null;
  /** The backend's own `confidence` per question, for the log only (its meaning differs per dialect). */
  vendorConfidence: Record<string, number>;
  /** Questions this backend could not take (never truncated); the engine moves them to the next step. */
  skipped: Record<string, 'context' | 'unsupported'>;
  /** Emulated backends only (§2.5): how each answer was read. */
  emulated?: S1EmulatedDiagnostics;
}

/** `letter`: one letter-logprob pass (two when symmetric); `tournament`: more options than one pass reads;
 * `json`: the JSON-schema mode (uncalibrated). */
export type S1Readout = 'letter' | 'tournament' | 'json';
export interface S1EmulatedDiagnostics {
  promptProfile: 'semif-v1' | 'eikos-v1';
  readout: Record<string, S1Readout>;
  /** Σ exp(logprob) over the option letters before renormalizing; the lowest of a question's passes. */
  letterMass: Record<string, number>;
  /** Both option orders were asked and averaged by label. */
  symmetric: boolean;
  /** Letter passes whose readout failed (a missing letter, low letter mass) and went to the JSON mode once. */
  fellBack: string[];
}

// ---------------------------------------------------------------------------
// Backends and capabilities (§2.4)
// ---------------------------------------------------------------------------

export type S1Dialect = 'typesafe-v1' | 'laya' | 'eikos' | 'semif-letter';
export type S1Locality = 'vendor-cloud' | 'gateway-cloud' | 'loopback' | 'remote-host' | 'ollama-cloud';
export type S1ReportsVersion = 'versioned' | 'dated' | 'alias' | 'checkpoint' | 'digest' | 'fingerprint' | 'none';

export interface BackendCaps {
  types: { noul: boolean; choice: boolean; score: boolean };
  maxQuestions: number; maxOptions: number; contextTokens: number; maxStateTokensPerQuestion: number;
  /** Laya: tokens every option's `label: description` shares before Laya trims them silently (192 on
   * `english`, 256 otherwise). A question past it is skipped. Absent = no option head. */
  optionHeadTokens?: number;
  /** A server's own limits may only lower the preset's. */
  limitsSource: 'server' | 'preset' | 'observed';
  decimals: number | null; reportsVersion: S1ReportsVersion;
  /** create/append/ask/delete proven by the battery (eikos only). */
  sessions: boolean;
  /** Stateless p50 divided by session p50 for the same state. */
  sessionSpeedup: number | null;
  /** null = no key configured. */
  keyEnforced: boolean | null;
  logprobs?: 'native' | 'openai' | 'llama-server' | 'none';
  promptProfile?: 'semif-v1' | 'eikos-v1';
  letterMass?: number; letterCoverage?: number;
  deterministic: boolean;
  /** 'mild' | 'strong' turn on symmetric averaging. */
  orderSensitivity: 'none' | 'mild' | 'strong';
  calibrated: 'vendor' | 'fitted' | 'uncalibrated';
  /** Behavioural fingerprint: sha256 of the battery's first probability vector rounded to 3 decimals. */
  fingerprint: string;
  /** That vector, so a later run can measure drift (L∞). */
  fingerprintVector: number[];
  /** sha256 of the model id the server reported at the last run; eikos/custom answers must match it. */
  modelHash: string | null;
  /** The dialect the battery settled (custom servers); `semif-letter` on emulated backends. */
  dialect: S1Dialect;
  /** 0 = never tested. */
  testedAt: number;
  latencyMs: { p50: number; p95: number; cold?: number };
}

/** A credential together with the origin its secret owner is bound to (§5.9). */
export interface S1BoundCredential { value: string; origin: string }
export interface S1EvaluateOptions {
  signal: AbortSignal;
  deadlineAt: number;
  /** A key bound to its origin (DecisionSecrets.getBound). A bare string is taken only by a cloud route, bound
   * to that route's fixed origin; a person's server refuses it before anything is sent (§5.9). */
  credential: string | S1BoundCredential | null;
  /** Ask both option orders and average by label (§2.5: on for command.review). Emulated backends honour it,
   * and turn it on themselves when the battery found the backend order-sensitive. */
  symmetric?: boolean;
}

/** Sessions exist only on the eikos dialect (§2.8); the pool arrives with the orchestrator assessments. */
export interface SystemOneSessions {
  create(state: string, opts: S1EvaluateOptions): Promise<{ sessionId: string; chars: number }>;
  append(sessionId: string, text: string, opts: S1EvaluateOptions): Promise<{ chars: number }>;
  ask(sessionId: string, questions: Record<string, S1Question>, opts: S1EvaluateOptions): Promise<S1Result>;
  delete(sessionId: string, opts: S1EvaluateOptions): Promise<void>;
}

export interface SystemOneBackend {
  readonly id: string; readonly kind: 'systemone-http' | 'emulated'; readonly preset: string;
  readonly dialect: S1Dialect;
  readonly locality: S1Locality;
  /** Cached result of the last conformance test (or the preset defaults before one). */
  caps(): BackendCaps;
  evaluate(req: S1Request, opts: S1EvaluateOptions): Promise<S1Result>;
  readonly sessions?: SystemOneSessions;
}

// ---------------------------------------------------------------------------
// Errors (§2.3)
// ---------------------------------------------------------------------------

export const S1_ERROR_CLASSES = [
  // Returned by a server.
  'auth', 'quota', 'rate', 'overloaded', 'server', 'bad-request', 'unknown-model', 'not-found',
  // Observed by the client on the way. `invalid-output`: an emulated letter readout that failed closed (a
  // missing option letter, or letter mass below 0.5), which goes to the JSON mode once (§2.5).
  'transport', 'timeout', 'invalid-response', 'incomplete-answer', 'invalid-output', 'version-mismatch',
  // Decided locally; nothing was sent, so none of these touch the breaker.
  'invalid-request', 'context', 'breaker-open', 'aborted'
] as const;
export type S1ErrorClass = typeof S1_ERROR_CLASSES[number];

/** Carries the class, the status and (TypeSafe 422 only) the schema path. Never a response body. */
export class SystemOneError extends Error {
  readonly errorClass: S1ErrorClass;
  readonly status: number | null;
  readonly loc: string[] | null;
  /** 404 `{"error":"unknown session"}` from an Eikos server that restarted. */
  readonly unknownSession: boolean;
  constructor(errorClass: S1ErrorClass, message: string, options: { status?: number | null; loc?: string[] | null; unknownSession?: boolean } = {}) {
    super(message);
    this.name = 'SystemOneError';
    this.errorClass = errorClass;
    this.status = options.status ?? null;
    this.loc = options.loc ?? null;
    this.unknownSession = options.unknownSession ?? false;
  }
}

export function s1ErrorClass(error: unknown): S1ErrorClass | null {
  return error instanceof SystemOneError ? error.errorClass : null;
}

/** HTTP status → class. `unknownModel` and `unknownSession` come from the (discarded) body. */
export function classifyStatus(status: number, detail: { unknownModel?: boolean; unknownSession?: boolean; quota409?: boolean } = {}): S1ErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 409 && detail.quota409) return 'quota';
  if (status === 429) return 'rate';
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  if (status === 404) return 'not-found';
  if (status === 400 && detail.unknownModel) return 'unknown-model';
  return 'bad-request';
}

// ---------------------------------------------------------------------------
// Bounded JSON (duplicate and forbidden keys, byte/node/depth caps)
// ---------------------------------------------------------------------------

export interface JsonCaps { maxBytes: number; maxNodes: number; maxDepth: number }
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/uy;

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

/** Rejects duplicate keys (JSON.parse would silently keep the last), forbidden keys, non-finite numbers and
 * anything past the caps, then returns JSON.parse's value. */
export function parseBoundedJson(text: string, caps: JsonCaps, errorClass: S1ErrorClass = 'invalid-response'): unknown {
  const fail = (message: string): never => { throw new SystemOneError(errorClass, message); };
  if (utf8Length(text) > caps.maxBytes) fail('System One JSON exceeds its byte limit.');
  let i = 0, nodes = 0;
  const ws = (): void => { for (;;) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else return; } };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === 92) i++;
      else if (c === 34) {
        try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail('Invalid JSON string.'); }
      }
    }
    return fail('Invalid JSON string.');
  };
  const value = (depth: number): void => {
    if (depth > caps.maxDepth || ++nodes > caps.maxNodes) fail('System One JSON structure limit exceeded.');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      const keys = new Set<string>();
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Invalid JSON key.');
        const key = string();
        if (keys.has(key) || FORBIDDEN_KEYS.has(key)) fail('Duplicate or forbidden JSON key.');
        keys.add(key); ws();
        if (text[i++] !== ':') fail('Invalid JSON object.');
        value(depth + 1); ws();
        if (text[i] === '}') { i++; return; }
        if (text[i++] !== ',') fail('Invalid JSON object.');
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(depth + 1); ws();
        if (text[i] === ']') { i++; return; }
        if (text[i++] !== ',') fail('Invalid JSON array.');
      }
    }
    if (c === '"') { string(); return; }
    LITERAL.lastIndex = i;
    const match = LITERAL.exec(text);
    if (!match) return fail('Invalid JSON value.');
    i += match[0].length;
    if (match[0] !== 'true' && match[0] !== 'false' && match[0] !== 'null' && !Number.isFinite(Number(match[0]))) fail('Nonfinite JSON number.');
  };
  value(0); ws();
  if (i !== text.length) fail('Trailing JSON.');
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Request validation: the portable subset (§2.1)
// ---------------------------------------------------------------------------

export const S1_LIMITS = Object.freeze({
  questionsMax: 64,
  choiceOptionsMin: 2,
  choiceOptionsMax: 255,
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
  /** Laya's body cap; no route documents a smaller one. */
  requestBytes: 2 * 1024 * 1024,
  requestNodes: 200_000,
  requestDepth: 20,
  labelChars: 200,
  modelChars: 200
});
const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function invalid(message: string): never { throw new SystemOneError('invalid-request', message); }

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unexpected field in ${what}.`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) invalid(`Missing field in ${what}.`);
}

function nonEmptyText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

function validInstructions(value: unknown): boolean {
  if (nonEmptyText(value)) return true;
  if (!isPlainRecord(value) || !nonEmptyText(value.question)) return false;
  return Object.values(value).every(item => typeof item === 'string' || Array.isArray(item) && item.every(part => typeof part === 'string'));
}

function validDescription(value: unknown): boolean {
  if (value === null || typeof value === 'string') return true;
  return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'string' || Array.isArray(item) && item.every(part => typeof part === 'string'));
}

/** Number of options a question offers the model: 2 for a noul, the labels of a choice, the levels of a score. */
export function optionCount(question: S1Question): number {
  if (question.type === 'noul') return 2;
  return question.type === 'score' ? question.criteria.length : Object.keys(question.criteria).length;
}

/** Labels in CanvasTTY's order: `true`/`false` for a noul, the catalog order for a choice, `"0".."n−1"` for a score. */
export function questionLabels(question: S1Question): string[] {
  if (question.type === 'noul') return ['true', 'false'];
  if (question.type === 'score') return question.criteria.map((_level, index) => String(index));
  return Object.keys(question.criteria);
}

function serializeStrict(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
      || typeof item === 'number' && !Number.isFinite(item)) invalid('Non-JSON System One input.');
    return item;
  });
}

/** The portable subset every route accepts. Throws `invalid-request`; returns the serialized request. */
export function validateS1Request(request: unknown): string {
  if (!isPlainRecord(request)) invalid('System One request must be an object.');
  exactKeys(request, ['model', 'state', 'questions'], 'the request');
  if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > S1_LIMITS.modelChars || CONTROL.test(request.model)) invalid('Invalid System One model.');
  const state = request.state;
  if (!(typeof state === 'string' || Array.isArray(state) || isPlainRecord(state))) invalid('System One state must be a string, an object or an array.');
  if (!isPlainRecord(request.questions)) invalid('System One questions must be an object.');
  const entries = Object.entries(request.questions);
  if (entries.length < 1 || entries.length > S1_LIMITS.questionsMax) invalid('System One question count must be 1..64.');
  for (const [id, question] of entries) {
    if (!QUESTION_ID.test(id)) invalid('Invalid System One question ID.');
    if (!isPlainRecord(question)) invalid('Invalid System One question.');
    exactKeys(question, ['type', 'instructions', 'criteria'], 'a question');
    if (!validInstructions(question.instructions)) invalid('Instructions must be a non-empty string or an object with a question.');
    const criteria = question.criteria;
    if (question.type === 'noul') {
      if (!isPlainRecord(criteria)) invalid('A noul needs both criteria.');
      exactKeys(criteria, ['true', 'false'], 'noul criteria');
      if (!nonEmptyText(criteria.true) || !nonEmptyText(criteria.false)) invalid('A noul needs both criteria.');
    } else if (question.type === 'choice') {
      if (!isPlainRecord(criteria)) invalid('A choice needs a label map.');
      const labels = Object.keys(criteria);
      if (labels.length < S1_LIMITS.choiceOptionsMin || labels.length > S1_LIMITS.choiceOptionsMax) invalid('A choice needs 2..255 labels.');
      for (const label of labels) {
        if (!label.trim() || label.length > S1_LIMITS.labelChars || CONTROL.test(label) || FORBIDDEN_KEYS.has(label)) invalid('Invalid choice label.');
        if (!validDescription(criteria[label])) invalid('Choice descriptions must be a string, an object or null.');
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < S1_LIMITS.scoreLevelsMin || criteria.length > S1_LIMITS.scoreLevelsMax) invalid('A score needs 2..10 levels.');
      if (!criteria.every(nonEmptyText)) invalid('Score levels must be non-empty strings.');
    } else invalid('Unsupported System One question type.');
  }
  const serialized = serializeStrict(request);
  parseBoundedJson(serialized, { maxBytes: S1_LIMITS.requestBytes, maxNodes: S1_LIMITS.requestNodes, maxDepth: S1_LIMITS.requestDepth }, 'invalid-request');
  return serialized;
}

// ---------------------------------------------------------------------------
// Token budget (chars / 3.5, CJK one token per character)
// ---------------------------------------------------------------------------

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

export function stateText(state: S1State): string { return typeof state === 'string' ? state : JSON.stringify(state); }
export function questionTokens(question: S1Question): number { return estimateTokens(JSON.stringify(question)); }

function joinValue(value: string | string[]): string { return Array.isArray(value) ? value.join('; ') : value; }

/**
 * One string for a structured entry: the question (instructions) or `what` (a choice description) first,
 * then one `name: value` line per other field, lists joined with `; `. A `null` description becomes the label,
 * so no Python repr (`None`, `{'what': …}`) can reach a model.
 */
export function flattenEntry(value: S1Instructions | S1ChoiceDescription, label = ''): string {
  if (value === null) return label;
  if (typeof value === 'string') return value;
  const lead = typeof value.question === 'string' ? 'question' : typeof value.what === 'string' ? 'what' : null;
  const lines = lead ? [joinValue(value[lead]!)] : [];
  for (const [name, item] of Object.entries(value)) if (name !== lead) lines.push(`${name}: ${joinValue(item)}`);
  return lines.join('\n');
}

/** Tokens a question's options take as `label: description` lines (Laya's option head): both noul criteria,
 * every choice option, every score level. */
export function optionHeadTokens(question: S1Question): number {
  if (question.type === 'noul') return estimateTokens(`true: ${question.criteria.true}`) + estimateTokens(`false: ${question.criteria.false}`);
  if (question.type === 'score') return question.criteria.reduce((sum, level, index) => sum + estimateTokens(`${index}: ${level}`), 0);
  return Object.entries(question.criteria).reduce((sum, [label, description]) => sum + estimateTokens(`${label}: ${flattenEntry(description, label)}`), 0);
}

export interface S1BatchLimits {
  maxQuestions: number; maxOptions: number;
  /** Whole request (state + every question); null = no request cap (each question is its own prompt). */
  contextTokens: number | null;
  /** The state plus the longest question. */
  maxStateTokensPerQuestion: number;
  /** Tokens a question's options may take together (Laya's option head); null or absent = no such limit. */
  optionHeadTokens?: number | null;
}

/** Splits a request into fan-out batches that share the state. A question that cannot fit is skipped with
 * a reason, never truncated. */
export function planS1Batches(request: S1Request, limits: S1BatchLimits): { batches: string[][]; skipped: Record<string, 'context' | 'unsupported'> } {
  const state = estimateTokens(stateText(request.state));
  const skipped: Record<string, 'context' | 'unsupported'> = {};
  const batches: string[][] = [];
  let current: string[] = [], used = state;
  for (const [id, question] of Object.entries(request.questions)) {
    // More options than the backend takes, or options that would overflow Laya's option head (which trims
    // them silently), is a context limit too.
    if (optionCount(question) > limits.maxOptions) { skipped[id] = 'context'; continue; }
    if (limits.optionHeadTokens != null && optionHeadTokens(question) > limits.optionHeadTokens) { skipped[id] = 'context'; continue; }
    const tokens = questionTokens(question);
    if (state + tokens > limits.maxStateTokensPerQuestion || limits.contextTokens !== null && state + tokens > limits.contextTokens) { skipped[id] = 'context'; continue; }
    if (current.length >= limits.maxQuestions || limits.contextTokens !== null && used + tokens > limits.contextTokens) { batches.push(current); current = []; used = state; }
    current.push(id); used += tokens;
  }
  if (current.length) batches.push(current);
  return { batches, skipped };
}

// ---------------------------------------------------------------------------
// Response size caps, derived from the request
// ---------------------------------------------------------------------------

/** A response escapes at most 6 bytes per UTF-8 byte of echoed text (`\u00XX`). */
const ECHO_ESCAPE = 6;

/** Request text a response sends back: score levels (TypeSafe's and Laya's `legend`) and choice labels (the
 * `probabilities` keys and `choice`). Tolerates the legacy routing shapes (no noul criteria). */
function echoedBytes(question: S1Question): number {
  if (question.type === 'score') return Array.isArray(question.criteria) ? utf8Length(JSON.stringify(question.criteria)) : 0;
  if (question.type === 'choice' && question.criteria && typeof question.criteria === 'object') return utf8Length(JSON.stringify(Object.keys(question.criteria)));
  return 0;
}

/** 8 KiB + Σ(1 KiB + options × 64 B + echoed text × 6), at most 1 MiB. */
export function s1ResponseCaps(request: Pick<S1Request, 'questions'>): JsonCaps {
  const questions = Object.values(request.questions);
  const options = questions.reduce((sum, question) => sum + optionCount(question), 0);
  const bytes = 8 * 1024 + questions.reduce((sum, question) => sum + 1024 + optionCount(question) * 64 + ECHO_ESCAPE * echoedBytes(question), 0);
  return { maxBytes: Math.min(1024 * 1024, bytes), maxNodes: 4 * options + 256, maxDepth: 16 };
}

// ---------------------------------------------------------------------------
// Distributions, rounding tolerance and derived numbers (§2.1)
// ---------------------------------------------------------------------------

export function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Decimals written for one value, capped at 6 (exponent forms count as 6). */
export function decimalsOf(value: number): number {
  const text = String(value);
  if (/e/iu.test(text)) return 6;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** Half a unit in the last place per value, never below 0.01. `decimals` is floored at 2: no route rounds coarser. */
export function sumTolerance(count: number, decimals: number): number {
  return Math.max(0.01, count * 0.5 * 10 ** -Math.max(2, decimals)) + 1e-9;
}

/** TypeSafe's documented confidence, (n·top − 1)/(n − 1), clamped to [0, 1]. */
export function spreadConf(n: number, top: number): number {
  if (n < 2) return 1;
  return Math.min(1, Math.max(0, (n * top - 1) / (n - 1)));
}

function fault(errorClass: 'invalid-response' | 'incomplete-answer', message: string): never { throw new SystemOneError(errorClass, message); }

/**
 * Reads a label → probability map in the given label order. Every label must be present (missing ones are an
 * incomplete answer), none other may appear, each value lies in [0, 1], and the sum lies within the rounding
 * tolerance for `decimals` (the response's detected precision). The result is renormalized to sum 1.
 */
export function normalizeDistribution(labels: readonly string[], given: unknown, decimals: number): number[] {
  if (given === undefined || given === null) fault('incomplete-answer', 'System One answer has no probabilities.');
  if (!isPlainRecord(given)) fault('invalid-response', 'Invalid System One probabilities.');
  for (const key of Object.keys(given)) if (!labels.includes(key)) fault('invalid-response', 'System One answer names an unknown option.');
  const raw = labels.map(label => {
    if (!Object.hasOwn(given, label)) fault('incomplete-answer', 'System One answer omits an option probability.');
    const value = given[label];
    if (!isProbability(value)) fault('invalid-response', 'Invalid System One probability.');
    return value;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || Math.abs(total - 1) > sumTolerance(labels.length, decimals)) fault('invalid-response', 'System One probability distribution does not sum to 1.');
  return raw.map(value => value / total);
}

export function noulAnswer(p: number): Extract<S1Answer, { type: 'noul' }> {
  if (!isProbability(p)) fault('invalid-response', 'Invalid System One noul probability.');
  const margin = Math.abs(2 * p - 1);
  return { type: 'noul', p, top: Math.max(p, 1 - p), margin, conf: margin };
}

function topTwo(vector: readonly number[]): { top: number; second: number; index: number } {
  let top = -1, second = 0, index = 0;
  vector.forEach((value, i) => {
    if (value > top) { second = Math.max(top, 0); top = value; index = i; } else if (value > second) second = value;
  });
  return { top, second, index };
}

/** `choice` must be an argmax label of the vector (ties allowed). */
export function choiceAnswer(labels: readonly string[], vector: readonly number[], choice: unknown): Extract<S1Answer, { type: 'choice' }> {
  if (typeof choice !== 'string' || !labels.includes(choice)) fault('invalid-response', 'System One answer chose an unknown option.');
  const { top, second } = topTwo(vector);
  if (vector[labels.indexOf(choice)]! + 1e-9 < top) fault('invalid-response', 'System One choice is not the most probable option.');
  const n = labels.length;
  return { type: 'choice', choice, probabilities: Object.fromEntries(labels.map((label, i) => [label, vector[i]!])), top, second, margin: top - second, n, conf: spreadConf(n, top) };
}

/** `level` is the (lowest) argmax, `expectation` is always Σ i·pᵢ; a backend's `score` field is never read here. */
export function scoreAnswer(vector: readonly number[]): Extract<S1Answer, { type: 'score' }> {
  const { top, second, index } = topTwo(vector);
  const n = vector.length;
  let adjacentMass = 0;
  for (let i = 0; i + 1 < n; i++) adjacentMass = Math.max(adjacentMass, vector[i]! + vector[i + 1]!);
  return {
    type: 'score', level: index, expectation: vector.reduce((sum, p, i) => sum + i * p, 0), probabilities: [...vector],
    top, margin: top - second, n, conf: spreadConf(n, top), adjacentMass
  };
}

/** The probability vector of an answer in CanvasTTY's label order (noul: [p, 1 − p]). */
export function answerVector(answer: S1Answer, labels?: readonly string[]): number[] {
  if (answer.type === 'noul') return [answer.p, 1 - answer.p];
  if (answer.type === 'score') return [...answer.probabilities];
  return (labels ?? Object.keys(answer.probabilities)).map(label => answer.probabilities[label] ?? 0);
}
