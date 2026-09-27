import {
  SystemOneError, choiceAnswer, classifyStatus, estimateTokens, flattenEntry, noulAnswer, parseBoundedJson, scoreAnswer, validateS1Request,
  type BackendCaps, type JsonCaps, type S1Answer, type S1EvaluateOptions, type S1Locality, type S1Question, type S1Readout, type S1Request, type S1Result, type S1State, type SystemOneBackend
} from '../../shared/systemOne.ts';
import type { CircuitBreaker } from './CircuitBreaker.ts';
import { answersSchema, jsonCallRequest, jsonCallResponse, jsonModeMaxTokens, jsonModeMessages, readJsonAnswers, type JsonRoute } from './jsonSchemaReadout.ts';
import { applyTemperature, letterPassRequest, letterPassResponse, readLetters, type LetterRoute } from './letterReadout.ts';
import { canonicalOllamaName, parseOllamaModelRef, probeOllama, readOllamaListing, sameOllamaListing, type OllamaListing, type OllamaProbeResult, type ProbeHttp } from './ollamaProbe.ts';
import {
  LETTERS, PROMPT_PROFILES, SEMIF_SYSTEM, calibTemperature, carriesTemplateControl, pyJsonDumps, questionCarriesTemplateControl, semifOptions, semifPrompt,
  type PromptProfile, type PromptProfileId, type SemifOption
} from './semifPrompt.ts';
import { modelLabel, sha256Hex } from './systemOneRoutes.ts';

/**
 * The `emulated` kind (§1.4, §2.5), Ollama only in this plugin: an ordinary local model made to answer System One
 * questions. It ports
 * the shape of the MIT System One adapter (typesafe-ai/system-one-adapter-python) and SemIf's letter readout
 * (TheoLeeCJ/SemIf-OpenJev, MIT): one completion per question, the answer read from the option letters'
 * logprobs; the JSON-schema mode (verbalized, uncalibrated) when logprobs are missing or a readout fails.
 *
 * Nothing runs until a caller asks: no probe, load or poll in the background. Before its first call the
 * backend checks where the model runs (§1.4), and before every later Ollama call it re-reads the model's
 * /api/tags entry (the digest pin, §2.2); a local Ollama model is always sent as `name:local`, so the server
 * itself refuses a cloud stub. It never pulls, creates or downloads a model. Evidence or a question carrying a
 * chat-template control string never reaches a letter prompt: the JSON mode, which makes them inert, answers.
 */

export type EmulatedRuntime = 'ollama';
export const EMULATED_DEFAULT_URLS: Readonly<Record<EmulatedRuntime, string>> = Object.freeze({ ollama: 'http://127.0.0.1:11434' });
/** Ollama's context is fixed per model at the smallest of these that fits the largest request (changing it reloads the model). */
const LOADED_CONTEXT_TTL_MS = 10_000;
export const OLLAMA_NUM_CTX = Object.freeze([4096, 8192, 16384] as const);
export type OllamaNumCtx = typeof OLLAMA_NUM_CTX[number];
/** §5.1: 8 s warm, 30 s cold (the first call, or the first after keep_alive expired). */
export const EMULATED_ATTEMPT_TIMEOUT_MS = Object.freeze({ warm: 8_000, cold: 30_000 });
export const OLLAMA_KEEP_ALIVE = '10m';
const KEEP_ALIVE_MS = 10 * 60_000;
/** Letters one pass can read: Ollama caps top_logprobs at 20 (above is a 400). */
const OLLAMA_LETTER_CAP = 20;
/** Room kept in the model's context beyond the prompt (§2.1: model context − 1k). */
const CONTEXT_RESERVE = 1024;

const LETTER_CAPS: JsonCaps = { maxBytes: 256 * 1024, maxNodes: 20_000, maxDepth: 16 };
const JSON_CALL_CAPS: JsonCaps = { maxBytes: 1024 * 1024, maxNodes: 20_000, maxDepth: 16 };
const PROBE_CAPS: JsonCaps = { maxBytes: 4 * 1024 * 1024, maxNodes: 200_000, maxDepth: 32 };
const ERROR_BODY_BYTES = 16 * 1024;

export interface EmulatedBackendOptions {
  id: string;
  runtime: EmulatedRuntime;
  /** Loopback http (localhost becomes 127.0.0.1) or https; the runtime's default port otherwise. */
  url?: string;
  /** The Ollama name (without `:local`; CanvasTTY adds the pin) or the server's model id. */
  model: string;
  /** `semif-v1` for ordinary instruct models (default), `eikos-v1` for models trained on the format. */
  profile?: PromptProfileId;
  /** Ollama's fixed context (default 8192). */
  numCtx?: OllamaNumCtx;
  /** The model's calib.json (eikos-v1): its temperature is applied exactly once, here. */
  calib?: unknown;
  /** CanvasTTY's fitted temperature (§4.4), applied on top to letter answers (never to tournaments or JSON). */
  fittedTemperature?: number;
  caps?: BackendCaps | null;
  transport?: typeof fetch;
  breaker?: CircuitBreaker;
  /** Changes whenever this backend's key changes; an `auth` breaker hold waits for it (§5.3). */
  credentialGeneration?: () => number;
  now?: () => number;
}

/** What the last probe found (the §1.4 locality check and what the readout needs). */
export interface EmulatedProbe {
  runtime: EmulatedRuntime;
  at: number;
  ollama: OllamaProbeResult | null;
  /** The name inference calls send (`name:local`). */
  requestName: string;
  /** The letter readout is possible (logprobs present); otherwise the JSON mode only. */
  logprobs: boolean;
  /** A cloud model: JSON mode with client-side validation, uncalibrated, never AUTO. */
  cloud: boolean;
  contextLength: number | null;
  /** The Ollama digest (first 12 hex) + the prompt profile; null without a digest (§2.2). */
  resolvedVersion: string | null;
}

export type EmulatedReadoutMode = 'auto' | 'letter' | 'json';

interface CallContext {
  signal: AbortSignal;
  deadlineAt: number;
  credential: string | null;
  sent: { count: number };
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedModel: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

/** Loopback http or https, no credentials, query or fragment; a trailing `/v1` (OpenAI base URLs) is dropped. */
function resolveBase(runtime: EmulatedRuntime, url: string | undefined): { base: string; origin: string; loopback: boolean } {
  const raw = url ?? EMULATED_DEFAULT_URLS[runtime];
  const refuse = (): never => { throw new SystemOneError('invalid-request', 'For a server on this computer use 127.0.0.1 or [::1]; a server elsewhere needs https.'); };
  if (typeof raw !== 'string' || raw.length > 500 || /[\u0000- \u007f]/u.test(raw)) return refuse();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return refuse(); }
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  const loopback = LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback) || parsed.username || parsed.password || parsed.search || parsed.hash) refuse();
  const path = parsed.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '');
  return { base: `${parsed.origin}${path}`, origin: parsed.origin, loopback };
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) throw new SystemOneError('invalid-response', 'Response exceeds its byte limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new SystemOneError('invalid-response', 'Response exceeds its byte limit.');
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new SystemOneError('invalid-response', 'Response is not UTF-8.'); }
}

/** The class of a failed inference call, from the status and (never logged) error text. */
function failure(runtime: EmulatedRuntime, status: number, json: unknown): { error: SystemOneError; thinkingUnsupported: boolean } {
  const message = isRecord(json) ? (typeof json.error === 'string' ? json.error : isRecord(json.error) && typeof json.error.message === 'string' ? json.error.message : '') : '';
  const thinkingUnsupported = status === 400 && /does not support thinking/iu.test(message);
  let errorClass = classifyStatus(status);
  if ((status === 400 || status === 413) && /context|input length|too long|exceeds/iu.test(message)) errorClass = 'context';
  else if (runtime === 'ollama' && status === 404) errorClass = 'unknown-model';           // model not found, or `:local` refused
  else if (runtime === 'ollama' && status === 403 && /cloud/iu.test(message)) errorClass = 'unknown-model'; // cloud disabled
  return { error: new SystemOneError(errorClass, `Emulated System One ${errorClass} (${status}).`, { status }), thinkingUnsupported };
}

/** The first argmax label (ties keep option order). */
function argmaxLabel(labels: readonly string[], vector: readonly number[]): string {
  let best = 0;
  vector.forEach((value, i) => { if (value > vector[best]!) best = i; });
  return labels[best]!;
}

function buildAnswer(question: S1Question, labels: readonly string[], vector: readonly number[]): S1Answer {
  if (question.type === 'noul') return noulAnswer(vector[0]!);
  if (question.type === 'score') return scoreAnswer(vector);
  return choiceAnswer(labels, vector, argmaxLabel(labels, vector));
}

export class EmulatedSystemOneBackend implements SystemOneBackend {
  readonly id: string;
  readonly kind = 'emulated' as const;
  readonly dialect = 'semif-letter' as const;
  readonly preset = 'ollama' as const;
  readonly runtime: EmulatedRuntime;
  readonly base: string;
  /** What a key would be bound to (§5.9). */
  readonly origin: string;
  readonly model: string;
  readonly profile: PromptProfile;
  readonly numCtx: OllamaNumCtx;
  /** Where a key for this server lives in DecisionSecrets; Ollama takes none. */
  readonly secretOwner: string | null;
  private readonly loopback: boolean;
  private readonly calibT: number;
  private fittedT: number;
  private record: BackendCaps;
  private probed: EmulatedProbe | null = null;
  /** The /api/tags entry the battery's findings and the fit belong to (undefined before the first probe). */
  private pinnedListing: OllamaListing | null | undefined = undefined;
  private omitThink = false;
  private lastCallAt = 0;
  private readonly transport: typeof fetch;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly credentialGeneration: () => number;
  private readonly now: () => number;

  constructor(options: EmulatedBackendOptions) {
    if (!Object.hasOwn(EMULATED_DEFAULT_URLS, options.runtime)) throw new SystemOneError('invalid-request', 'Unknown emulated runtime.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/u.test(options.id)) throw new SystemOneError('invalid-request', 'Invalid System One backend ID.');
    if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 200 || /[\u0000-\u001f\u007f]/u.test(options.model)) throw new SystemOneError('invalid-request', 'Invalid model name.');
    const profile = PROMPT_PROFILES[options.profile ?? 'semif-v1'];
    if (!profile) throw new SystemOneError('invalid-request', 'Unknown prompt profile.');
    const numCtx = options.numCtx ?? 8192;
    if (!(OLLAMA_NUM_CTX as readonly number[]).includes(numCtx)) throw new SystemOneError('invalid-request', 'num_ctx must be 4096, 8192 or 16384.');
    this.id = options.id;
    this.runtime = options.runtime;
    const resolved = resolveBase(options.runtime, options.url);
    this.base = resolved.base; this.origin = resolved.origin; this.loopback = resolved.loopback;
    this.model = options.model;
    this.profile = profile;
    this.numCtx = numCtx;
    // Ollama takes no key.
    this.secretOwner = null;
    // calib.json belongs to models trained on the format; an ordinary model starts at T = 1.
    this.calibT = profile.id === 'eikos-v1' ? calibTemperature(options.calib) : 1;
    this.fittedT = this.validTemperature(options.fittedTemperature ?? 1);
    this.record = structuredClone(options.caps ?? this.defaultCaps());
    this.transport = options.transport ?? fetch;
    this.breaker = options.breaker;
    this.credentialGeneration = options.credentialGeneration ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  /** Where the model runs. An Ollama model is treated as remote (Ollama Cloud) until the §1.4 check has proven it local. */
  get locality(): S1Locality {
    const host: S1Locality = this.loopback ? 'loopback' : 'remote-host';
    return this.probed?.ollama?.locality === 'local' ? host : 'ollama-cloud';
  }

  get lastProbe(): EmulatedProbe | null { return this.probed ? structuredClone(this.probed) : null; }
  caps(): BackendCaps { return structuredClone(this.record); }
  setCaps(caps: BackendCaps): void { this.record = structuredClone(caps); }
  /** CanvasTTY's fitted temperature (§4.4); 1 resets it. */
  setFittedTemperature(temperature: number): void { this.fittedT = this.validTemperature(temperature); }
  get temperatures(): { calib: number; fitted: number } { return { calib: this.calibT, fitted: this.fittedT }; }

  /** Letters one pass reads: the profile's cap (16 or 26), lowered by Ollama's top-logprob cap (20). */
  get maxLetters(): number { return Math.min(this.profile.letters, OLLAMA_LETTER_CAP); }

  private validTemperature(value: number): number {
    if (!Number.isFinite(value) || value < 0.05 || value > 20) throw new SystemOneError('invalid-request', 'Invalid temperature.');
    return value;
  }

  private defaultCaps(): BackendCaps {
    return {
      types: { noul: true, choice: true, score: true },
      // Each question is its own prompt: no request cap; a tournament reads choices past one pass.
      maxQuestions: 64, maxOptions: 255, contextTokens: 0,
      maxStateTokensPerQuestion: this.promptLimit(null),
      limitsSource: 'preset', decimals: null, reportsVersion: 'digest',
      sessions: false, sessionSpeedup: null, keyEnforced: null,
      logprobs: 'native',
      promptProfile: this.profile.id,
      // Unknown until the battery has run: no cache and no AUTO before it.
      deterministic: false, orderSensitivity: 'none', calibrated: 'uncalibrated',
      fingerprint: '', fingerprintVector: [], modelHash: null, dialect: 'semif-letter',
      testedAt: 0, latencyMs: { p50: 500, p95: 1_000 }
    };
  }

  /** Tokens one prompt may take: the model's context − 1k, never above Ollama's fixed num_ctx. */
  private promptLimit(contextLength: number | null): number {
    return contextLength ? Math.max(256, Math.min(contextLength - CONTEXT_RESERVE, this.numCtx)) : this.numCtx;
  }

  private letterRoute(): LetterRoute { return this.profile.id === 'eikos-v1' ? 'ollama-generate' : 'ollama-chat'; }

  private jsonRoute(): JsonRoute { return 'ollama-chat'; }

  /** Ollama takes no key (the cloud signs requests itself), so keys never cross between backends (§5.9). */
  private bindCredential(credential: S1EvaluateOptions['credential']): string | null {
    if (credential === null || credential === undefined) return null;
    throw new SystemOneError('invalid-request', 'An Ollama server takes no key.');
  }

  private attemptTimeout(): number {
    return this.lastCallAt > 0 && this.now() - this.lastCallAt < KEEP_ALIVE_MS ? EMULATED_ATTEMPT_TIMEOUT_MS.warm : EMULATED_ATTEMPT_TIMEOUT_MS.cold;
  }

  /** One HTTP exchange; any status is returned with its parsed body. Throws only transport, timeout, aborted or an unreadable body. */
  private async exchange(method: 'GET' | 'POST', path: string, body: unknown, ctx: CallContext, caps: JsonCaps): Promise<{ status: number; json: unknown }> {
    const remaining = ctx.deadlineAt - this.now();
    if (remaining <= 0) throw new SystemOneError('timeout', 'Emulated System One deadline exceeded.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SystemOneError('timeout', 'Emulated System One deadline exceeded.')), Math.min(remaining, this.attemptTimeout()));
    const abort = (): void => controller.abort(new SystemOneError('aborted', 'Emulated System One call cancelled.'));
    if (ctx.signal.aborted) abort(); else ctx.signal.addEventListener('abort', abort, { once: true });
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      ctx.sent.count++;
      let response: Response;
      try { response = await this.transport(`${this.base}${path}`, { method, redirect: 'error', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal }); }
      catch { throw controller.signal.aborted ? controller.signal.reason : new SystemOneError('transport', 'Emulated System One server unreachable.'); }
      const ok = response.status >= 200 && response.status < 300;
      let text: string;
      try { text = await readBounded(response, ok ? caps.maxBytes : ERROR_BODY_BYTES, controller.signal); }
      catch (error) { if (controller.signal.aborted) throw controller.signal.reason; if (!ok) text = ''; else throw error; }
      let json: unknown = null;
      if (text.trim()) {
        try { json = parseBoundedJson(text, ok ? caps : { maxBytes: ERROR_BODY_BYTES, maxNodes: 2048, maxDepth: 12 }); }
        catch (error) { if (ok) throw error; json = null; }
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof SystemOneError) throw error;
      throw new SystemOneError('transport', 'Emulated System One call failed.');
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', abort);
    }
  }

  /** An inference call: one retry on a transport error while the deadline allows (§5.2), none otherwise. */
  private async infer(path: string, body: Record<string, unknown>, ctx: CallContext, caps: JsonCaps): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt++) {
      try {
        ctx.attempts++;
        const reply = await this.exchange('POST', path, body, ctx, caps);
        if (reply.status >= 200 && reply.status < 300) this.lastCallAt = this.now();
        return reply;
      } catch (error) {
        if (attempt === 0 && error instanceof SystemOneError && error.errorClass === 'transport' && ctx.deadlineAt > this.now()) continue;
        throw error;
      }
    }
  }

  private loadedContext: { at: number; model: string; value: number | null } | null = null;

  /**
   * L29: the num_ctx for a local Ollama call. When the same model is already loaded with a larger context (an agent
   * running on it asked for more), that context is sent: a different num_ctx makes Ollama reload the model, which on a
   * Mac took ~3 s and ran every review past its deadline. Read from /api/ps, cached briefly; any failure keeps ours.
   */
  private async ollamaNumCtx(ctx: CallContext, probe: EmulatedProbe): Promise<number> {
    const now = this.now();
    if (!this.loadedContext || this.loadedContext.model !== probe.requestName || now - this.loadedContext.at > LOADED_CONTEXT_TTL_MS) {
      let value: number | null = null;
      try {
        const reply = await this.probeHttp(ctx)('GET', '/api/ps');
        const models = reply.status === 200 && reply.json && typeof reply.json === 'object' ? (reply.json as { models?: unknown }).models : null;
        // /api/ps names the model without CanvasTTY's :local pin.
        const base = (name: unknown): string | null => { const ref = typeof name === 'string' ? parseOllamaModelRef(name) : null; return ref ? canonicalOllamaName(ref.base) : null; };
        const wanted = base(probe.requestName);
        const entry = Array.isArray(models) && wanted ? models.find(item => item && typeof item === 'object' && (base((item as { name?: unknown }).name) === wanted || base((item as { model?: unknown }).model) === wanted)) as { context_length?: unknown } | undefined : undefined;
        if (entry && typeof entry.context_length === 'number' && Number.isInteger(entry.context_length) && entry.context_length > 0) value = entry.context_length;
      } catch { value = null; }
      this.loadedContext = { at: now, model: probe.requestName, value };
    }
    const loaded = this.loadedContext.value;
    return loaded !== null && loaded > this.numCtx ? loaded : this.numCtx;
  }

  private probeHttp(ctx: CallContext): ProbeHttp {
    return (method, path, body) => this.exchange(method, path, body, ctx, PROBE_CAPS);
  }

  private context(opts: Pick<S1EvaluateOptions, 'signal' | 'deadlineAt'>, credential: string | null): CallContext {
    return { signal: opts.signal, deadlineAt: opts.deadlineAt, credential, sent: { count: 0 }, attempts: 0, inputTokens: 0, outputTokens: 0, reportedModel: null };
  }

  /**
   * Checks where the model runs and what the server offers (an explicit action: adding the backend,
   * «Проверить», or the first call). Read-only: nothing is pulled or loaded.
   */
  async probe(opts: Pick<S1EvaluateOptions, 'signal' | 'deadlineAt'> & { credential?: S1EvaluateOptions['credential'] }): Promise<EmulatedProbe> {
    const ctx = this.context(opts, this.bindCredential(opts.credential ?? null));
    return this.runProbe(ctx);
  }

  private async runProbe(ctx: CallContext): Promise<EmulatedProbe> {
    // A new check replaces the old verdict; until it passes, the model counts as remote again.
    this.probed = null;
    const http = this.probeHttp(ctx);
    const ollama = await probeOllama(http, this.model);
    const cloud = ollama.locality !== 'local';
    if (!ollama.installed && !ollama.cloudReasons.includes('name')) throw new SystemOneError('unknown-model', `The model is not installed (ollama pull ${this.model}).`);
    if (ollama.capabilities && !ollama.capabilities.includes('completion')) throw new SystemOneError('unknown-model', 'This model does not generate text.');
    // Other weights under this name than the ones the battery ran on: none of that holds.
    if (this.pinnedListing !== undefined && !sameOllamaListing(this.pinnedListing, ollama.listing)) this.forgetModel();
    this.pinnedListing = ollama.listing;
    const probe: EmulatedProbe = {
      runtime: this.runtime, at: this.now(), ollama, requestName: ollama.requestName,
      // Every Ollama call needs ≥ 0.12.11 for logprobs; cloud logprobs are unverified, so a cloud model runs in JSON mode only.
      logprobs: ollama.logprobs && !cloud, cloud, contextLength: ollama.contextLength,
      resolvedVersion: ollama.digest ? `${ollama.digest.slice(0, 12)}+${this.profile.id}` : null
    };
    this.probed = probe;
    this.record.maxStateTokensPerQuestion = this.promptLimit(probe.contextLength);
    if (!probe.logprobs) this.record.logprobs = 'none';
    return probe;
  }

  /**
   * The probe a call runs on. An Ollama name can point at other weights at any time (`ollama pull`, or a cloud
   * stub pulled under the same name) and only the digest pins the version (§2.2), so the model's /api/tags
   * entry is read again before every call (read-only, about a millisecond on this computer). A changed entry
   * is another model: the full probe runs again, so the result carries the new resolvedVersion (R6) with the
   * battery's findings dropped; and a model that is no longer local gets nothing from this call, since the
   * caller cleared it as a local one.
   */
  private async currentProbe(ctx: CallContext): Promise<EmulatedProbe> {
    const cached = this.probed;
    if (!cached) return this.runProbe(ctx);
    if (!cached.ollama) return cached;
    const { listing } = await readOllamaListing(this.probeHttp(ctx), this.model);
    if (sameOllamaListing(listing, cached.ollama.listing)) return cached;
    const probe = await this.runProbe(ctx);
    if (cached.ollama.locality === 'local' && probe.cloud) throw new SystemOneError('version-mismatch', 'The model under this name is no longer local.');
    return probe;
  }

  /** Another model under the same name (§2.4, §4.4): untested, unfitted and cold again. The order sensitivity
   * is kept, so symmetric passes stay on until the battery says otherwise. */
  private forgetModel(): void {
    const fresh = this.defaultCaps();
    this.record = { ...this.record, testedAt: 0, fingerprint: '', fingerprintVector: [], modelHash: null, deterministic: false, calibrated: 'uncalibrated', logprobs: fresh.logprobs };
    delete this.record.letterMass; delete this.record.letterCoverage;
    this.fittedT = 1; this.omitThink = false; this.lastCallAt = 0;
  }

  async evaluate(request: S1Request, opts: S1EvaluateOptions): Promise<S1Result> {
    return this.evaluateWith(request, opts, 'auto');
  }

  /**
   * `auto`: the letter readout, and the JSON mode once for questions whose readout failed (or for every
   * question when logprobs are missing or the model is in the cloud). `letter`: no fallback (the battery
   * measures the readout itself). `json`: the JSON mode only.
   */
  async evaluateWith(request: S1Request, opts: S1EvaluateOptions, mode: EmulatedReadoutMode): Promise<S1Result> {
    if (opts.signal.aborted) throw new SystemOneError('aborted', 'Emulated System One call cancelled.');
    validateS1Request(request);
    if (request.model !== this.model) throw new SystemOneError('invalid-request', 'This backend runs one model; the request names another.');
    const credential = this.bindCredential(opts.credential);
    if (opts.deadlineAt <= this.now()) throw new SystemOneError('timeout', 'Emulated System One deadline exceeded.');
    // The key generation this call runs under: an `auth` hold lets the first call of a new key through (§5.3).
    const generation = this.credentialGeneration();
    const admission = this.breaker?.acquire(generation);
    const ctx = this.context(opts, credential);
    try {
      const result = await this.run(request, opts, mode, ctx);
      this.breaker?.success();
      return result;
    } catch (error) {
      const failed = error instanceof SystemOneError ? error : new SystemOneError('transport', 'Emulated System One call failed.');
      if (ctx.sent.count === 0) this.breaker?.release(admission);
      else this.breaker?.failure(failed.errorClass, generation, admission);
      throw failed;
    }
  }

  private async run(request: S1Request, opts: S1EvaluateOptions, mode: EmulatedReadoutMode, ctx: CallContext): Promise<S1Result> {
    const started = this.now();
    // §1.4: where the model runs is checked before the first call; §2.2: the Ollama pin before every call.
    const probe = await this.currentProbe(ctx);
    const symmetric = opts.symmetric === true || this.record.orderSensitivity !== 'none';
    const limit = this.promptLimit(probe.contextLength);
    const answers: Record<string, S1Answer> = {};
    const readout: Record<string, S1Readout> = {};
    const letterMass: Record<string, number> = {};
    const skipped: S1Result['skipped'] = {};
    const fellBack: string[] = [];
    const pending: string[] = [];
    const jsonOnly = mode === 'json' || !probe.logprobs;
    if (mode === 'letter' && !probe.logprobs) throw new SystemOneError('invalid-output', 'This server returns no logprobs: the letter readout is not possible.');
    // §2.5: a chat-template control string in the evidence or the question would become a real control token
    // in a letter prompt (a forged turn). Such a question gets no letter pass: the JSON mode, which makes them
    // inert, answers it uncalibrated (never AUTO); the letter-only mode skips it.
    const stateTainted = !jsonOnly && carriesTemplateControl(pyJsonDumps(request.state));
    for (const [id, question] of Object.entries(request.questions)) {
      if (jsonOnly) { pending.push(id); continue; }
      if (stateTainted || questionCarriesTemplateControl(question)) { if (mode === 'auto') pending.push(id); else skipped[id] = 'unsupported'; continue; }
      if (letterPromptTokens(request.state, question, this.maxLetters) > limit) { skipped[id] = 'context'; continue; }
      try {
        const read = await this.letterAnswer(ctx, probe, request.state, question, symmetric);
        answers[id] = read.answer; readout[id] = read.readout; letterMass[id] = read.letterMass;
      } catch (error) {
        const errorClass = error instanceof SystemOneError ? error.errorClass : null;
        if (errorClass === 'context') { skipped[id] = 'context'; continue; }
        // A failed readout goes to the JSON mode once (never a retry of the letter pass).
        if (errorClass === 'invalid-output' && mode === 'auto') { fellBack.push(id); pending.push(id); continue; }
        throw error;
      }
    }
    if (pending.length) await this.jsonAnswers(ctx, probe, request.state, Object.fromEntries(pending.map(id => [id, request.questions[id]!])), limit, answers, readout, skipped);
    if (!Object.keys(answers).length) {
      if (Object.values(skipped).includes('context')) throw new SystemOneError('context', 'No question fits this model\'s context.');
      throw new SystemOneError('invalid-request', 'No question can be asked by letter readout: each carries a chat-template control string.');
    }
    return {
      answers,
      reportedModel: ctx.reportedModel ?? probe.requestName,
      // An Ollama name is shown as it is; anything odder is hashed (§2.2).
      modelLabel: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(this.model) ? this.model : modelLabel(this.model, 'custom'),
      resolvedVersion: probe.resolvedVersion,
      // Only a server on this computer is free (§2.3); a remote one's cost is unknown, never $0 (§5.5).
      usage: { inputTokens: ctx.inputTokens, outputTokens: ctx.outputTokens, costUsd: this.loopback && !probe.cloud ? 0 : null, costSource: 'none' },
      requestId: null,
      latencyMs: this.now() - started,
      attempts: ctx.attempts,
      decimals: null,
      vendorConfidence: {},
      skipped,
      emulated: { promptProfile: this.profile.id, readout, letterMass, symmetric, fellBack }
    };
  }

  /** One question by letter readout: both orders when symmetric, the fitted T on top. More options than one pass
   * reads are a context limit here (the chain's tournament is not ported: no catalog question needs it). */
  private async letterAnswer(ctx: CallContext, probe: EmulatedProbe, state: S1State, question: S1Question, symmetric: boolean): Promise<{ answer: S1Answer; readout: S1Readout; letterMass: number }> {
    const options = semifOptions(question);
    const byLabel = new Map(options.map(option => [option.label, option]));
    let minMass = 1;
    const pass = async (labels: string[]): Promise<Record<string, number>> => {
      const subset = labels.map(label => byLabel.get(label)!);
      const first = await this.letterPass(ctx, probe, state, question, subset);
      minMass = Math.min(minMass, first.letterMass);
      if (!symmetric) return first.probs;
      // The reverse order removes letter-position bias (Eikos --sym does the same).
      const second = await this.letterPass(ctx, probe, state, question, [...subset].reverse());
      minMass = Math.min(minMass, second.letterMass);
      return Object.fromEntries(labels.map(label => [label, 0.5 * (first.probs[label]! + second.probs[label]!)]));
    };
    const labels = options.map(option => option.label);
    if (labels.length > this.maxLetters) throw new SystemOneError('context', 'More options than one letter pass reads.');
    const probabilities = await pass(labels);
    let vector = labels.map(label => probabilities[label]!);
    // CanvasTTY's fitted T sits on top of the model's own.
    if (this.fittedT !== 1) vector = applyTemperature(vector, this.fittedT);
    return { answer: buildAnswer(question, labels, vector), readout: 'letter', letterMass: minMass };
  }

  /** One pass over `options` in the order given: letters A.., the model's calib.json T applied once. */
  private async letterPass(ctx: CallContext, probe: EmulatedProbe, state: S1State, question: S1Question, options: readonly SemifOption[]): Promise<{ probs: Record<string, number>; letterMass: number }> {
    const prompt = semifPrompt(state, question, options);
    // run() routes such a question away; this is the last check before any byte is sent.
    if (carriesTemplateControl(prompt.messages[1]!.content)) throw new SystemOneError('invalid-request', 'A letter prompt may not carry a chat-template control string.');
    const route = this.letterRoute();
    const numCtx = probe.cloud ? this.numCtx : await this.ollamaNumCtx(ctx, probe);
    const request = (think: boolean) => letterPassRequest({
      route, model: probe.requestName, messages: prompt.messages, text: prompt.text, topK: OLLAMA_LETTER_CAP,
      numCtx, keepAlive: OLLAMA_KEEP_ALIVE,
      think: think ? false : undefined
    });
    const think = route === 'ollama-chat' && !this.omitThink && probe.ollama?.sendThinkFalse !== false;
    let built = request(think);
    let reply = await this.infer(built.path, built.body, ctx, LETTER_CAPS);
    if (reply.status < 200 || reply.status >= 300) {
      const failed = failure(this.runtime, reply.status, reply.json);
      if (!(failed.thinkingUnsupported && think)) throw failed.error;
      // A server that refuses the field: once without it, and never again for this backend.
      this.omitThink = true;
      built = request(false);
      reply = await this.infer(built.path, built.body, ctx, LETTER_CAPS);
      if (reply.status < 200 || reply.status >= 300) throw failure(this.runtime, reply.status, reply.json).error;
    }
    const parsed = letterPassResponse(route, reply.json);
    this.acceptReply(ctx, probe, parsed.reportedModel, parsed.remote, parsed.promptTokens, parsed.outputTokens);
    // §2.5: after a thought the first token is not a letter, whatever the logprobs look like; the JSON mode answers once.
    if (parsed.thought) throw new SystemOneError('invalid-output', 'The model thought before answering.');
    const { probs, letterMass } = readLetters(parsed.top, options.length);
    const tempered = applyTemperature(probs, this.calibT);
    return { probs: Object.fromEntries(options.map((option, i) => [option.label, tempered[i]!])), letterMass };
  }

  /** A local model answered through ollama.com, or under another name: never accepted. Usage is summed. */
  private acceptReply(ctx: CallContext, probe: EmulatedProbe, reported: string | null, remote: boolean, promptTokens: number | null, outputTokens: number | null): void {
    if (remote && !probe.cloud) throw new SystemOneError('version-mismatch', 'A local model answered through Ollama Cloud.');
    if (reported !== null) {
      const accepted = new Set([probe.requestName, this.model, canonicalOllamaName(this.model), `${canonicalOllamaName(this.model)}:local`, `${this.model}:local`]);
      if (!accepted.has(reported)) throw new SystemOneError('version-mismatch', 'Another model answered.');
    }
    if (reported !== null) ctx.reportedModel ??= reported;
    ctx.inputTokens = ctx.inputTokens === null || promptTokens === null ? null : ctx.inputTokens + promptTokens;
    ctx.outputTokens = ctx.outputTokens === null || outputTokens === null ? null : ctx.outputTokens + outputTokens;
  }

  /**
   * The JSON mode: one call for `questions` when it fits, otherwise one per question; a question that does
   * not fit alone is skipped (`context`), never truncated. Every answer is uncalibrated.
   */
  private async jsonAnswers(ctx: CallContext, probe: EmulatedProbe, state: S1State, questions: Record<string, S1Question>, limit: number, answers: Record<string, S1Answer>, readout: Record<string, S1Readout>, skipped: S1Result['skipped']): Promise<void> {
    // The prompt and the longest answer must both fit (Ollama's num_ctx holds the output too).
    const fits = (set: Record<string, S1Question>): boolean => jsonPromptTokens(state, set) + jsonModeMaxTokens(set) <= limit;
    const groups = fits(questions) ? [questions] : Object.entries(questions).map(([id, question]) => ({ [id]: question }));
    for (const group of groups) {
      if (!fits(group)) { for (const id of Object.keys(group)) skipped[id] = 'context'; continue; }
      const read = await this.jsonCall(ctx, probe, state, group);
      for (const [id, answer] of Object.entries(read)) { answers[id] = answer; readout[id] = 'json'; }
    }
  }

  private async jsonCall(ctx: CallContext, probe: EmulatedProbe, state: S1State, questions: Record<string, S1Question>): Promise<Record<string, S1Answer>> {
    const route = this.jsonRoute();
    const numCtx = !probe.cloud ? await this.ollamaNumCtx(ctx, probe) : undefined;
    const request = (think: boolean) => jsonCallRequest({
      route, model: probe.requestName, messages: jsonModeMessages(state, questions), schema: answersSchema(questions), maxTokens: jsonModeMaxTokens(questions),
      // Ollama documents no structured outputs on its cloud: the schema stays in the prompt only.
      enforceSchema: !probe.cloud,
      numCtx, keepAlive: OLLAMA_KEEP_ALIVE,
      think: think ? false : undefined
    });
    const think = route === 'ollama-chat' && !this.omitThink && probe.ollama?.sendThinkFalse !== false;
    let built = request(think);
    // jsonModeMessages makes every caller text inert; this is the last check before any byte is sent.
    if ((built.body.messages as { content: string }[]).some(message => carriesTemplateControl(message.content))) throw new SystemOneError('invalid-request', 'A JSON-mode prompt may not carry a chat-template control string.');
    let reply = await this.infer(built.path, built.body, ctx, JSON_CALL_CAPS);
    if (reply.status < 200 || reply.status >= 300) {
      const failed = failure(this.runtime, reply.status, reply.json);
      if (!(failed.thinkingUnsupported && think)) throw failed.error;
      this.omitThink = true;
      built = request(false);
      reply = await this.infer(built.path, built.body, ctx, JSON_CALL_CAPS);
      if (reply.status < 200 || reply.status >= 300) throw failure(this.runtime, reply.status, reply.json).error;
    }
    const parsed = jsonCallResponse(route, reply.json);
    this.acceptReply(ctx, probe, parsed.reportedModel, parsed.remote, parsed.promptTokens, parsed.outputTokens);
    return readJsonAnswers(parsed.text, questions);
  }

  /**
   * Ollama only, on an explicit action (after a live check or a battery run): unloads the model now
   * (`keep_alive: 0`). Other servers manage their own memory.
   */
  async unload(opts: Pick<S1EvaluateOptions, 'signal' | 'deadlineAt'>): Promise<void> {
    const ctx = this.context(opts, null);
    const probe = this.probed ?? await this.runProbe(ctx);
    if (probe.cloud) return;
    await this.exchange('POST', '/api/generate', { model: probe.requestName, keep_alive: 0 }, ctx, LETTER_CAPS);
  }
}

/** Estimated tokens of the largest pass a question needs (the whole prompt, template included). */
export function letterPromptTokens(state: S1State, question: S1Question, maxLetters: number): number {
  const options = semifOptions(question);
  // A tournament's passes hold at most maxLetters options; the longest descriptions bound them.
  const widest = options.length <= maxLetters ? options : [...options].sort((a, b) => b.description.length - a.description.length).slice(0, maxLetters);
  const user = pyJsonDumps({ evidence: state, criterion: flattenEntry(question.instructions), options: widest.map(option => ({ letter: 'A', description: option.description })) });
  return estimateTokens(SEMIF_SYSTEM) + estimateTokens(user) + 16;
}

function jsonPromptTokens(state: S1State, questions: Record<string, S1Question>): number {
  return jsonModeMessages(state, questions).reduce((sum, message) => sum + estimateTokens(message.content), 16);
}
