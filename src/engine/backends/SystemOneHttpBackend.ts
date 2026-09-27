import {
  SystemOneError, classifyStatus, optionCount, parseBoundedJson, planS1Batches, s1ErrorClass, s1ResponseCaps, scoreAnswer, validateS1Request,
  type BackendCaps, type JsonCaps, type S1Answer, type S1EvaluateOptions, type S1Locality, type S1Question, type S1Request, type S1Result, type SystemOneBackend
} from '../../shared/systemOne.ts';
import { decodeErrorBody, decodeResponse, encodeRequest, EIKOS_LETTERS, type DecodedResponse, type HttpDialect } from './dialects.ts';
import { retriesFor, retryDelayMs, sleep } from './retry.ts';
import { assertRequestModel, dialectLimits, FIXED_SECRET_ORIGINS, modelLabel, presetCaps, resolveEndpoint, S1_PRESETS, secretOwnerFor, type S1Preset, type S1PresetId } from './systemOneRoutes.ts';
import type { CircuitBreaker } from './CircuitBreaker.ts';

export interface SystemOneHttpBackendOptions {
  id: string;
  preset: S1PresetId;
  /** A person's server (laya, eikos, custom); cloud routes are fixed. */
  url?: string;
  /** The model this backend is configured with (the battery sends it); requests name their own. */
  model?: string;
  /** The last conformance result; the preset defaults until one exists. */
  caps?: BackendCaps | null;
  transport?: typeof fetch;
  breaker?: CircuitBreaker;
  /** Changes whenever this backend's key changes; an `auth` breaker hold waits for it. */
  credentialGeneration?: () => number;
  now?: () => number;
  random?: () => number;
}

export interface RawExchange { json: unknown; headers: Headers; attempts: number; latencyMs: number }
export interface ExchangeOptions extends S1EvaluateOptions {
  /** The codec to send with (custom servers before the battery has settled theirs). */
  dialect?: HttpDialect;
}

/** Counts the attempts of one call that reached the transport. */
interface SendTracker { sent: number }

const ERROR_BODY_BYTES = 16 * 1024;
const PROBE_CAPS: JsonCaps = { maxBytes: 64 * 1024, maxNodes: 4096, maxDepth: 12 };

/** Bytes of a streamed body up to `maxBytes`, decoded as strict UTF-8. */
async function readBody(response: Response, maxBytes: number, signal: AbortSignal, onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new SystemOneError('invalid-response', 'System One response exceeds its byte limit.');
  if (!response.body) throw new SystemOneError('invalid-response', 'System One response has no body.');
  const reader = response.body.getReader();
  onReader(reader);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    signal.throwIfAborted();
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) throw new SystemOneError('invalid-response', 'System One response exceeds its byte limit.');
    chunks.push(chunk.value);
  }
  signal.throwIfAborted();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new SystemOneError('invalid-response', 'System One response is not UTF-8.'); }
}

function statusError(status: number, text: string, preset: S1PresetId): SystemOneError {
  const facts = decodeErrorBody(text, status);
  const errorClass = classifyStatus(status, { unknownModel: facts.unknownModel, unknownSession: facts.unknownSession, quota409: preset === 'vercel' });
  // Only the class, the status and a 422 schema path; the body can hold exception text or echo the input.
  return new SystemOneError(errorClass, `System One ${errorClass} (${status})${facts.loc ? ` at ${facts.loc.join('.')}` : ''}.`, { status, loc: facts.loc, unknownSession: facts.unknownSession });
}

/** A score a backend cannot answer is asked as a choice over the same levels (§2.4 step 4). */
function compileForCaps(request: S1Request, caps: BackendCaps): { request: S1Request; rewritten: Set<string> } {
  if (caps.types.score) return { request, rewritten: new Set() };
  const rewritten = new Set<string>();
  const questions: Record<string, S1Question> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'score') { questions[id] = question; continue; }
    rewritten.add(id);
    questions[id] = { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) };
  }
  return { request: { ...request, questions }, rewritten };
}

/**
 * The `systemone-http` kind (§1.4, §2.4): one class for every System One server, shaped by its preset and
 * dialect. It validates before egress, never truncates, reads responses under caps derived from the request,
 * retries only within the deadline, and attaches a key only to the origin that key is bound to.
 */
export class SystemOneHttpBackend implements SystemOneBackend {
  readonly id: string;
  readonly kind = 'systemone-http' as const;
  readonly preset: S1PresetId;
  readonly locality: S1Locality;
  readonly endpoint: string;
  readonly origin: string;
  readonly base: string;
  readonly model: string;
  /** Where this backend's key lives in DecisionSecrets. */
  readonly secretOwner: string;
  private record: BackendCaps;
  private readonly transport: typeof fetch;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly credentialGeneration: () => number;
  private readonly now: () => number;
  private readonly random: () => number;
  private warm = false;

  constructor(options: SystemOneHttpBackendOptions) {
    const preset = S1_PRESETS[options.preset];
    if (!preset) throw new SystemOneError('invalid-request', 'Unknown System One preset.');
    this.id = options.id;
    this.preset = preset.id;
    const resolved = resolveEndpoint(preset, options.url);
    this.endpoint = resolved.endpoint; this.origin = resolved.origin; this.base = resolved.base; this.locality = resolved.locality;
    this.model = options.model ?? preset.defaultModel;
    assertRequestModel(preset, this.model);
    this.secretOwner = secretOwnerFor(preset, options.id, resolved.locality);
    this.record = structuredClone(options.caps ?? presetCaps(preset, this.model));
    this.transport = options.transport ?? fetch;
    this.breaker = options.breaker;
    this.credentialGeneration = options.credentialGeneration ?? (() => 0);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** The stored caps' dialect; a record that is not an HTTP dialect (never stored for this kind) falls back to the preset's. */
  get dialect(): HttpDialect { const dialect = this.record.dialect; return dialect === 'semif-letter' ? this.presetInfo.dialect : dialect; }
  /** The cloud presets' model-id validator; a person's server may report any id (hashed for display). */
  get modelRule(): 'typesafe' | 'any' { return this.preset === 'eikos' || this.preset === 'custom' ? 'any' : 'typesafe'; }
  get presetInfo(): S1Preset { return S1_PRESETS[this.preset]; }
  caps(): BackendCaps { return structuredClone(this.record); }
  setCaps(caps: BackendCaps): void { this.record = structuredClone(caps); }

  async evaluate(request: S1Request, opts: S1EvaluateOptions): Promise<S1Result> {
    if (opts.signal.aborted) throw new SystemOneError('aborted', 'System One call cancelled.');
    validateS1Request(request);
    const preset = this.presetInfo;
    assertRequestModel(preset, request.model);
    const credential = this.bindCredential(opts.credential);
    const caps = this.record;
    const compiled = compileForCaps(request, caps);
    // The dialect's own limits apply on top of the stored caps, whichever preset reached the server: Laya's
    // room, option count and option head follow the checkpoint this request names (english when it names none).
    const dialect = dialectLimits(this.dialect, request.model);
    const head = Math.min(caps.optionHeadTokens ?? Infinity, dialect?.optionHeadTokens ?? Infinity);
    const plan = planS1Batches(compiled.request, {
      maxQuestions: Math.min(caps.maxQuestions, dialect?.maxQuestions ?? Infinity),
      maxOptions: Math.min(caps.maxOptions, dialect?.maxOptions ?? Infinity),
      contextTokens: caps.contextTokens > 0 ? caps.contextTokens : null,
      maxStateTokensPerQuestion: Math.min(caps.maxStateTokensPerQuestion, dialect?.maxStateTokensPerQuestion ?? Infinity),
      optionHeadTokens: Number.isFinite(head) ? head : null
    });
    if (!plan.batches.length) throw new SystemOneError('context', 'No question fits this System One backend.');
    // Everything is encoded before the breaker is asked, so a request refused here costs nothing.
    const batches = plan.batches.map(ids => {
      const sub: S1Request = { model: request.model, state: compiled.request.state, questions: Object.fromEntries(ids.map(id => [id, compiled.request.questions[id]!])) };
      const tournament = this.dialect === 'eikos' ? ids.filter(id => optionCount(sub.questions[id]!) > EIKOS_LETTERS) : [];
      return { sub, tournament, body: JSON.stringify(encodeRequest(this.dialect, sub, preset.extraBody)) };
    });
    // A deadline that has already passed is refused before the breaker is asked: it says nothing about the server.
    if (opts.deadlineAt <= this.now()) throw new SystemOneError('timeout', 'System One deadline exceeded.');
    const admission = this.breaker?.acquire(this.credentialGeneration());
    const generation = this.credentialGeneration();
    const tracker: SendTracker = { sent: 0 };
    try {
      const result = await this.run(request, batches, compiled.rewritten, plan.skipped, opts, credential, tracker);
      this.breaker?.success();
      return result;
    } catch (error) {
      const failure = error instanceof SystemOneError ? error : new SystemOneError('transport', 'System One call failed.');
      // Nothing reached the server: the breaker learns nothing, and a half-open probe keeps its slot.
      if (tracker.sent === 0) this.breaker?.release(admission);
      else this.breaker?.failure(failure.errorClass, generation, admission);
      throw failure;
    }
  }

  private async run(request: S1Request, batches: { sub: S1Request; tournament: string[]; body: string }[], rewritten: Set<string>, skipped: S1Result['skipped'], opts: S1EvaluateOptions, credential: string | null, tracker: SendTracker): Promise<S1Result> {
    const preset = this.presetInfo, started = this.now();
    const answers: Record<string, S1Answer> = {}, vendorConfidence: Record<string, number> = {};
    let attempts = 0, reportedModel: string | null = null, resolvedVersion: string | null = null, requestId: string | null = null, decimals: number | null = null;
    let inputTokens: number | null = 0, outputTokens: number | null = 0, reportedCost: number | null = 0;
    for (const batch of batches) {
      const exchange = await this.post(this.endpoint, batch.body, s1ResponseCaps(batch.sub), opts, credential, tracker);
      attempts += exchange.attempts;
      const decoded: DecodedResponse = decodeResponse(this.dialect, exchange.json, batch.sub, { tournament: batch.tournament, modelRule: this.modelRule });
      if (reportedModel !== null && decoded.reportedModel !== reportedModel) throw new SystemOneError('version-mismatch', 'System One model changed between batches.');
      resolvedVersion = preset.acceptModel(request.model, decoded.reportedModel, { modelHash: this.record.modelHash, fingerprint: this.record.fingerprint || null, routingModel: decoded.routingModel, unstable: this.record.reportsVersion === 'none' });
      reportedModel = decoded.reportedModel;
      Object.assign(answers, decoded.answers); Object.assign(vendorConfidence, decoded.vendorConfidence);
      const header = preset.requestIdHeader ? exchange.headers.get(preset.requestIdHeader) : null;
      requestId ??= (header && /^[A-Za-z0-9_.:-]{1,200}$/u.test(header) ? header : null) ?? decoded.bodyRequestId;
      if (decoded.decimals !== null) decimals = Math.max(decimals ?? 0, decoded.decimals);
      inputTokens = inputTokens === null || decoded.usage.inputTokens === null ? null : inputTokens + decoded.usage.inputTokens;
      outputTokens = outputTokens === null || decoded.usage.outputTokens === null ? null : outputTokens + decoded.usage.outputTokens;
      reportedCost = reportedCost === null || decoded.usage.reportedCostUsd === null ? null : reportedCost + decoded.usage.reportedCostUsd;
    }
    for (const id of rewritten) {
      const answer = answers[id];
      if (answer?.type === 'choice') answers[id] = scoreAnswer(Object.keys(answer.probabilities).map(level => answer.probabilities[level]!));
    }
    const usage: S1Result['usage'] = reportedCost !== null
      ? { inputTokens, outputTokens, costUsd: reportedCost, costSource: 'reported' }
      : preset.priceUsdPerMillionInput === null
        ? { inputTokens, outputTokens, costUsd: 0, costSource: 'none' }
        : inputTokens !== null
          ? { inputTokens, outputTokens, costUsd: inputTokens * preset.priceUsdPerMillionInput / 1e6, costSource: 'price-table' }
          : { inputTokens, outputTokens, costUsd: null, costSource: 'none' };
    return {
      answers, reportedModel: reportedModel!, modelLabel: modelLabel(reportedModel!, this.preset), resolvedVersion, usage, requestId,
      latencyMs: this.now() - started, attempts, decimals, vendorConfidence, skipped
    };
  }

  /**
   * One System One request with an already-compiled question set, returning the raw JSON: the conformance
   * battery reads answer fields a codec would drop (to settle a custom server's dialect).
   */
  async exchange(request: S1Request, opts: ExchangeOptions): Promise<RawExchange> {
    validateS1Request(request);
    return this.postRaw(JSON.stringify(encodeRequest(opts.dialect ?? this.dialect, request, this.presetInfo.extraBody)), s1ResponseCaps(request), opts);
  }

  /** An already-serialized body to this backend's endpoint, with its retries, caps and key binding. */
  async postRaw(body: string, caps: JsonCaps, opts: S1EvaluateOptions): Promise<RawExchange> {
    if (opts.signal.aborted) throw new SystemOneError('aborted', 'System One call cancelled.');
    const credential = this.bindCredential(opts.credential);
    const started = this.now();
    const result = await this.post(this.endpoint, body, caps, opts, credential);
    return { ...result, latencyMs: this.now() - started };
  }

  /** A read-only GET under this backend's base URL: one attempt, no retries, small JSON only. Status 0 = unreachable. */
  async probe(path: string, opts: S1EvaluateOptions): Promise<{ status: number; json: unknown | null }> {
    return this.call('GET', path, undefined, opts);
  }

  /** A sessions-route call (eikos): one attempt, small JSON. */
  async call(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, opts: S1EvaluateOptions): Promise<{ status: number; json: unknown | null }> {
    if (!/^\/[A-Za-z0-9/_.-]{0,200}$/u.test(path)) throw new SystemOneError('invalid-request', 'Invalid System One path.');
    const credential = this.bindCredential(opts.credential);
    const remaining = opts.deadlineAt - this.now();
    if (remaining <= 0) throw new SystemOneError('timeout', 'System One deadline exceeded.');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (credential) headers.Authorization = `Bearer ${credential}`;
    const outcome = await this.attempt(`${this.base}${path}`, method, headers, body === undefined ? undefined : JSON.stringify(body), Math.min(remaining, this.timeout()), opts.signal, PROBE_CAPS, true, { sent: 0 });
    if (outcome.ok) return { status: outcome.status, json: outcome.json };
    if (outcome.error.errorClass === 'aborted') throw outcome.error;
    return { status: outcome.error.status ?? 0, json: null };
  }

  private timeout(): number {
    const timeouts = this.presetInfo.attemptTimeoutMs;
    return this.warm ? timeouts.warm : timeouts.cold;
  }

  private expectedLatency(): number {
    return this.record.testedAt > 0 ? this.record.latencyMs.p50 : this.presetInfo.expectedLatencyMs;
  }

  /**
   * A key goes only to the origin it is bound to; keyless servers get no header at all (§5.9). A bare string
   * carries no origin, so only a cloud route takes one, bound to that route's fixed origin; a person's server
   * (loopback, custom, https) needs the S1BoundCredential its owner was stored with.
   */
  private bindCredential(credential: S1EvaluateOptions['credential']): string | null {
    if (credential === null || credential === undefined) return null;
    let value: unknown, origin: unknown;
    if (typeof credential === 'string') {
      const preset = this.presetInfo;
      origin = preset.fixedUrl && preset.secretOwner && Object.hasOwn(FIXED_SECRET_ORIGINS, preset.secretOwner) ? FIXED_SECRET_ORIGINS[preset.secretOwner] : null;
      if (origin === null) throw new SystemOneError('invalid-request', 'A key for this server must be bound to its address.');
      value = credential;
    } else if (credential && typeof credential === 'object') {
      value = credential.value; origin = credential.origin;
    } else throw new SystemOneError('invalid-request', 'Invalid System One credential.');
    if (origin !== this.origin) throw new SystemOneError('invalid-request', 'This key is bound to another address.');
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || Buffer.byteLength(value) > 16_384) throw new SystemOneError('invalid-request', 'Invalid System One credential.');
    return value;
  }

  private async post(url: string, body: string, caps: JsonCaps, opts: S1EvaluateOptions, credential: string | null, tracker: SendTracker = { sent: 0 }): Promise<{ json: unknown; headers: Headers; attempts: number }> {
    const preset = this.presetInfo;
    for (let attempt = 0; ; attempt++) {
      const remaining = opts.deadlineAt - this.now();
      if (remaining <= 0) throw new SystemOneError('timeout', 'System One deadline exceeded.');
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (credential) headers.Authorization = `Bearer ${credential}`;
      if (attempt > 0 && preset.retryCountHeader) headers[preset.retryCountHeader] = String(attempt);
      const outcome = await this.attempt(url, 'POST', headers, body, Math.min(remaining, this.timeout()), opts.signal, caps, false, tracker);
      if (outcome.ok) { this.warm = true; return { json: outcome.json, headers: outcome.headers, attempts: attempt + 1 }; }
      const error = outcome.error;
      if (attempt < retriesFor(error.errorClass, error.status)) {
        const delay = retryDelayMs(attempt, outcome.headers ?? new Headers(), { now: this.now(), deadlineAt: opts.deadlineAt, expectedLatencyMs: this.expectedLatency(), random: this.random });
        if (delay !== null) {
          try { await sleep(delay, opts.signal); } catch { throw new SystemOneError('aborted', 'System One call cancelled.'); }
          continue;
        }
      }
      throw error;
    }
  }

  private async attempt(url: string, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number, callerSignal: AbortSignal, caps: JsonCaps, lenient: boolean, tracker: SendTracker):
    Promise<{ ok: true; status: number; json: unknown; headers: Headers } | { ok: false; error: SystemOneError; headers: Headers | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SystemOneError('timeout', 'System One deadline exceeded.')), Math.max(0, timeoutMs));
    const abort = (): void => controller.abort(new SystemOneError('aborted', 'System One call cancelled.'));
    if (callerSignal.aborted) abort(); else callerSignal.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    cancelled.catch(() => undefined);
    const work = async (): Promise<{ ok: true; status: number; json: unknown; headers: Headers } | { ok: false; error: SystemOneError; headers: Headers | null }> => {
      let response: Response;
      // Cancelled or out of time before it left: never handed to the transport.
      if (controller.signal.aborted) throw controller.signal.reason;
      tracker.sent++;
      try { response = await this.transport(url, { method, redirect: 'error', headers, ...(body === undefined ? {} : { body }), signal: controller.signal }); }
      catch { throw controller.signal.aborted ? controller.signal.reason : new SystemOneError('transport', 'System One server unreachable.'); }
      if (!response.ok) {
        let text = '';
        try { text = await readBody(response, ERROR_BODY_BYTES, controller.signal, item => { reader = item; }); } catch { if (controller.signal.aborted) throw controller.signal.reason; }
        return { ok: false, error: statusError(response.status, text, this.preset), headers: response.headers };
      }
      const text = await readBody(response, caps.maxBytes, controller.signal, item => { reader = item; });
      if (lenient) {
        try { return { ok: true, status: response.status, json: text.trim() ? parseBoundedJson(text, caps) : null, headers: response.headers }; }
        catch { return { ok: true, status: response.status, json: null, headers: response.headers }; }
      }
      return { ok: true, status: response.status, json: parseBoundedJson(text, caps), headers: response.headers };
    };
    try {
      return await Promise.race([work(), cancelled]);
    } catch (error) {
      if (error instanceof SystemOneError) return { ok: false, error, headers: null };
      return { ok: false, error: new SystemOneError(s1ErrorClass(controller.signal.reason) ?? 'transport', 'System One call failed.'), headers: null };
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', abort);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }
}
