import {
  SystemOneError, choiceAnswer, decimalsOf, flattenEntry, isProbability, noulAnswer, normalizeDistribution, parseBoundedJson, questionLabels, scoreAnswer, stateText, utf8Length,
  type JsonValue, type S1Answer, type S1Question, type S1Request
} from '../../shared/systemOne.ts';

export { flattenEntry };

/**
 * One codec per HTTP dialect (§2.3). Server JSON never reaches a consumer: every answer is rebuilt into
 * S1Answer from its probability vector, and only the fields listed below are read.
 *
 *              typesafe-v1 (TypeSafe, OpenRouter, Vercel)   laya                       eikos (serve.py)
 * noul         noul                                           noul (P(true))            noul, else probability; both must agree
 * choice       choice, probabilities                          same, `type` may be absent  same; `type` always "choice"
 * score        probabilities ("0".."n−1"); `score` = mean      same                       probabilities; `score` = argmax and
 *              is ignored                                                                 `expected` = mean, both cross-checked only
 * confidence   spread statistic (logged only)                 normalized entropy (logged)  pmax (logged)
 */
export type HttpDialect = 'typesafe-v1' | 'laya' | 'eikos';

/** Eikos answers more than 26 options through a tournament; such answers are hints only. */
export const EIKOS_LETTERS = 26;
/** The server enforces nothing; CanvasTTY sends at most this many questions per request. */
export const EIKOS_MAX_QUESTIONS = 16;
export const LAYA_MAX_QUESTIONS = 64;
export const LAYA_MAX_STATE_CHARS = 50_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function eikosQuestion(question: S1Question): Record<string, unknown> {
  const instructions = flattenEntry(question.instructions);
  if (question.type === 'noul') return { type: 'noul', instructions, criteria: { true: question.criteria.true, false: question.criteria.false } };
  if (question.type === 'score') return { type: 'score', instructions, criteria: [...question.criteria] };
  return { type: 'choice', instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([label, description]) => [label, flattenEntry(description, label)])) };
}

/** Request normalization per dialect. The request has already passed the portable validator. */
export function encodeRequest(dialect: HttpDialect, request: S1Request, extraBody: Readonly<Record<string, JsonValue>> = {}): Record<string, unknown> {
  if (dialect === 'laya') {
    if (Object.keys(request.questions).length > LAYA_MAX_QUESTIONS) throw new SystemOneError('invalid-request', 'Laya accepts at most 64 questions.');
    // Laya counts str(state); refuse rather than let it answer 413 or truncate.
    if (stateText(request.state).length > LAYA_MAX_STATE_CHARS) throw new SystemOneError('context', 'State exceeds what Laya accepts.');
    return { model: request.model, state: request.state, questions: request.questions };
  }
  if (dialect === 'eikos') {
    if (Object.keys(request.questions).length > EIKOS_MAX_QUESTIONS) throw new SystemOneError('invalid-request', 'At most 16 questions go to an Eikos server per request.');
    // Never `mode:"verify"`; no extra top-level fields; the state stays an object for plain calls.
    return { model: request.model, state: request.state, questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, eikosQuestion(question)])) };
  }
  return { ...extraBody, model: request.model, state: request.state, questions: request.questions };
}

export interface DecodedResponse {
  answers: Record<string, S1Answer>;
  vendorConfidence: Record<string, number>;
  reportedModel: string;
  usage: { inputTokens: number | null; outputTokens: number | null; reportedCostUsd: number | null };
  /** OpenRouter `id` or Vercel `generationId`. */
  bodyRequestId: string | null;
  /** Laya's checkpoint (`routing.model`). */
  routingModel: string | null;
  /** Eikos `latency_s`, in ms. */
  serverLatencyMs: number | null;
  decimals: number | null;
}

const invalid = (message: string): never => { throw new SystemOneError('invalid-response', message); };
const TYPESAFE_MODEL = /^[^\u0000- \u007f]{1,100}$/u;

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readUsage(value: unknown): DecodedResponse['usage'] {
  if (!isRecord(value)) return { inputTokens: null, outputTokens: null, reportedCostUsd: null };
  const cost = typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : null;
  return {
    inputTokens: tokenCount(value.input_tokens) ?? tokenCount(value.prompt_tokens) ?? tokenCount(value.inputTokens),
    outputTokens: tokenCount(value.output_tokens) ?? tokenCount(value.completion_tokens) ?? tokenCount(value.outputTokens),
    reportedCostUsd: cost
  };
}

function shortId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) ? value : null;
}

/** Every probability value in the answers this request asked for: their precision sets the sum tolerance. */
function detectDecimals(answers: Record<string, unknown>, request: S1Request): number | null {
  let decimals: number | null = null;
  const see = (value: unknown): void => { if (typeof value === 'number' && Number.isFinite(value)) decimals = Math.max(decimals ?? 0, decimalsOf(value)); };
  for (const id of Object.keys(request.questions)) {
    const answer = answers[id];
    if (!isRecord(answer)) continue;
    see(answer.noul); see(answer.probability);
    if (isRecord(answer.probabilities)) Object.values(answer.probabilities).forEach(see);
  }
  return decimals;
}

function vendorConfidence(answer: Record<string, unknown>): number | null {
  if (answer.confidence === undefined) return null;
  // A broken vendor field means a broken server, even though the value is never used.
  if (!isProbability(answer.confidence)) invalid('Invalid System One confidence.');
  return answer.confidence as number;
}

function readAnswer(dialect: HttpDialect, question: S1Question, answer: Record<string, unknown>, decimals: number): S1Answer {
  const type = answer.type === undefined && dialect === 'laya' ? question.type : answer.type;
  if (type !== question.type) invalid('System One answer type mismatch.');
  if (question.type === 'noul') {
    if (dialect !== 'eikos') return noulAnswer(answer.noul as number);
    const hasNoul = answer.noul !== undefined, hasProbability = answer.probability !== undefined;
    if (hasNoul && hasProbability && (!isProbability(answer.noul) || !isProbability(answer.probability) || Math.abs(answer.noul - answer.probability) > 1e-6)) invalid('Eikos noul and probability disagree.');
    return noulAnswer((hasNoul ? answer.noul : answer.probability) as number);
  }
  const labels = questionLabels(question);
  const vector = normalizeDistribution(labels, answer.probabilities, decimals);
  if (question.type === 'choice') return choiceAnswer(labels, vector, answer.choice);
  const result = scoreAnswer(vector);
  if (dialect === 'eikos') {
    // Consistency checks only: `score` is Eikos's argmax label, `expected` its mean. Both are then discarded.
    const raw = labels.map(label => (answer.probabilities as Record<string, number>)[label]!);
    const peak = Math.max(...raw);
    if (!Number.isInteger(answer.score) || (answer.score as number) < 0 || (answer.score as number) >= raw.length || raw[answer.score as number]! + 1e-9 < peak) invalid('Eikos score is not the most probable level.');
    const mean = raw.reduce((sum, p, i) => sum + i * p, 0);
    if (typeof answer.expected !== 'number' || !Number.isFinite(answer.expected) || Math.abs(answer.expected - mean) > 0.01) invalid('Eikos expected score does not match its probabilities.');
  }
  return result;
}

/**
 * Response normalization. `request` is the one CanvasTTY built (its label order); `tournament` names the
 * questions an Eikos server answered with its > 26-option tournament. `modelRule` 'typesafe' is the model-id
 * validator of the cloud presets (≤ 100 characters, no spaces); a person's server may report anything up to
 * 4 KiB (Eikos reports a filesystem path), which is hashed, never shown.
 */
export function decodeResponse(dialect: HttpDialect, value: unknown, request: S1Request, options: { tournament?: readonly string[]; modelRule?: 'typesafe' | 'any' } = {}): DecodedResponse {
  if (!isRecord(value)) invalid('Invalid System One response.');
  const body = value as Record<string, unknown>;
  const model = body.model;
  if (typeof model !== 'string' || !model) invalid('Missing actual System One model.');
  const rule = options.modelRule ?? (dialect === 'eikos' ? 'any' : 'typesafe');
  if (rule === 'any' ? utf8Length(model as string) > 4096 : !TYPESAFE_MODEL.test(model as string)) invalid('Missing actual System One model.');
  if (!isRecord(body.answers)) invalid('Missing System One answers.');
  const given = body.answers as Record<string, unknown>;
  const decimals = detectDecimals(given, request);
  const answers: Record<string, S1Answer> = {};
  const confidence: Record<string, number> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = given[id];
    if (!isRecord(answer)) invalid('Missing System One answer.');
    const read = readAnswer(dialect, question, answer as Record<string, unknown>, decimals ?? 2);
    if (read.type === 'choice' && options.tournament?.includes(id)) read.uncalibrated = true;
    answers[id] = read;
    const vendor = vendorConfidence(answer as Record<string, unknown>);
    if (vendor !== null) confidence[id] = vendor;
  }
  const usage = readUsage(body.usage);
  const gateway = isRecord(body.provider_metadata) && isRecord(body.provider_metadata.gateway) ? body.provider_metadata.gateway : null;
  if (gateway && typeof gateway.cost === 'string' && /^\d+(?:\.\d+)?$/u.test(gateway.cost)) usage.reportedCostUsd = Number(gateway.cost);
  const latency = typeof body.latency_s === 'number' && Number.isFinite(body.latency_s) && body.latency_s >= 0 ? Math.round(body.latency_s * 1000) : null;
  return {
    answers, vendorConfidence: confidence, reportedModel: model as string, usage,
    bodyRequestId: shortId(body.id) ?? shortId(gateway?.generationId),
    routingModel: dialect === 'laya' && isRecord(body.routing) && typeof body.routing.model === 'string' && /^[A-Za-z0-9._/-]{1,100}$/u.test(body.routing.model) ? body.routing.model : null,
    serverLatencyMs: dialect === 'eikos' ? latency : null,
    decimals
  };
}

/**
 * The dialect a custom server speaks, read from the answer fields of one battery response (§2.4 step 3):
 * an `expected` field, a noul `probability` or a score without `legend` → eikos; `routing`, `answer_confidence`
 * or `action` → laya; otherwise typesafe-v1 (`id`, `provider` or `usage.cost` also mark a gateway).
 */
export function detectDialect(value: unknown): { dialect: HttpDialect; gateway: boolean } {
  if (!isRecord(value)) return { dialect: 'typesafe-v1', gateway: false };
  const answers = isRecord(value.answers) ? Object.values(value.answers).filter(isRecord) : [];
  if (answers.some(a => 'expected' in a || a.type === 'noul' && 'probability' in a || a.type === 'score' && !('legend' in a))) return { dialect: 'eikos', gateway: false };
  if ('routing' in value || answers.some(a => 'answer_confidence' in a || 'action' in a)) return { dialect: 'laya', gateway: false };
  const gateway = 'id' in value || 'provider' in value || 'provider_metadata' in value || isRecord(value.usage) && 'cost' in value.usage;
  return { dialect: 'typesafe-v1', gateway };
}

/** A read-only probe's body: `{ok, model}` suggests Eikos, `{status, loaded, device}` Laya, a jev-* model list the TypeSafe wire. */
export function detectHealthDialect(value: unknown): HttpDialect | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && typeof value.model === 'string') return 'eikos';
  if (typeof value.status === 'string' && 'loaded' in value && 'device' in value) return 'laya';
  if (Array.isArray(value.models) && value.models.some(m => isRecord(m) && typeof m.name === 'string' && /^jev-/u.test(m.name))) return 'typesafe-v1';
  return null;
}

export interface ErrorBodyFacts { unknownModel: boolean; unknownSession: boolean; loc: string[] | null }
const LOC_PART = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * What CanvasTTY takes from an error body: whether it names an unknown model or an unknown session, and for a
 * 422 the schema path (`detail[].loc`, never `input`). The body itself is dropped and never logged.
 */
export function decodeErrorBody(text: string, status: number): ErrorBodyFacts {
  const facts: ErrorBodyFacts = { unknownModel: false, unknownSession: false, loc: null };
  let value: unknown;
  try { value = parseBoundedJson(text, { maxBytes: 16 * 1024, maxNodes: 2048, maxDepth: 12 }); } catch { return facts; }
  if (!isRecord(value)) return facts;
  const detail = value.detail, error = value.error;
  const messages = [
    isRecord(detail) ? detail.message : detail,
    isRecord(error) ? error.message : error,
    value.message
  ].filter((item): item is string => typeof item === 'string');
  facts.unknownModel = messages.some(message => /unknown model|not a valid model|model .*not found/iu.test(message));
  facts.unknownSession = status === 404 && error === 'unknown session';
  if (status === 422 && Array.isArray(detail) && isRecord(detail[0]) && Array.isArray(detail[0].loc)) {
    facts.loc = detail[0].loc.slice(0, 12).map(part => typeof part === 'number' && Number.isSafeInteger(part) ? String(part) : typeof part === 'string' && LOC_PART.test(part) ? part : '?');
  }
  return facts;
}
