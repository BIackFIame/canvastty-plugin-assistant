import { createHash } from 'node:crypto';
import { SystemOneError, type BackendCaps, type JsonValue, type S1Locality, type S1ReportsVersion } from '../../shared/systemOne.ts';
import { EIKOS_MAX_QUESTIONS, LAYA_MAX_QUESTIONS, type HttpDialect } from './dialects.ts';

/**
 * Route presets (§1.4, §2.1, §2.2). A provider is a preset over one kind (`systemone-http`), not a class per
 * vendor: defaults for URL, dialect, limits, deadline and how the answering model is reported and pinned.
 */
export type S1PresetId = 'typesafe' | 'openrouter' | 'vercel' | 'laya' | 'eikos' | 'custom';

export interface ModelContext {
  /** sha256 of the model id reported at the last conformance run (eikos, custom). */
  modelHash: string | null;
  /** The behavioural fingerprint of the last conformance run. */
  fingerprint: string | null;
  /** Laya's `routing.model`. */
  routingModel: string | null;
  /** The battery found the reported name unstable. */
  unstable: boolean;
}

export interface S1Preset {
  id: S1PresetId;
  /** custom: the battery settles it; this is the starting guess. */
  dialect: HttpDialect;
  /** The fixed endpoint of a cloud route; null for servers the person names. */
  fixedUrl: string | null;
  defaultUrl: string | null;
  /** The secret owner in DecisionSecrets (§5.9) of a cloud route; local and custom servers use `secretOwnerFor`. */
  secretOwner: string | null;
  /** Model ids this route may be sent. */
  requestModel: RegExp;
  defaultModel: string;
  reportsVersion: S1ReportsVersion;
  pinnable: boolean;
  /** Whole request; null = each question is its own prompt (Eikos). */
  contextTokens: number | null;
  maxStateTokensPerQuestion: number;
  maxQuestions: number;
  maxOptions: number;
  /** Per attempt (§5.1): warm and cold (the first call after the process started). */
  attemptTimeoutMs: { warm: number; cold: number };
  /** Used to decide whether a retry still fits the deadline, until the battery has measured p50. */
  expectedLatencyMs: number;
  /** Determinism tolerance for the battery: a few hundredths on cloud routes (TypeSafe says so), 0.01 locally. */
  determinismTolerance: number;
  /** Extra top-level request fields (OpenRouter's ZDR provider block). */
  extraBody?: Readonly<Record<string, JsonValue>>;
  retryCountHeader?: string;
  requestIdHeader?: string;
  /** USD per 1M input tokens when no cost is reported; null = local ($0). */
  priceUsdPerMillionInput: number | null;
  calibrated: BackendCaps['calibrated'];
  /** Checks the reported model and returns the resolved version (null = unpinned). Throws `version-mismatch`. */
  acceptModel(requested: string, reported: string, context: ModelContext): string | null;
}

const mismatch = (): never => { throw new SystemOneError('version-mismatch', 'System One model version mismatch.'); };
export const JEV_VERSION = /^jev-\d+\.\d+(?:\.\d+)?$/u;
const OPENROUTER_REPORTED = /^typesafe\/jev-\d+\.\d+(?:-\d{8})?$/u;
export const LAYA_CHECKPOINTS = ['typed-decisions', 'english', 'multilingual'] as const;
export type LayaCheckpoint = typeof LAYA_CHECKPOINTS[number];
/**
 * What each Laya checkpoint takes before it trims silently (§1.4, §2.3): state tokens (max_len minus the
 * option head, with a margin), the option head every `label: description` shares, and the option count past
 * which it answers 422.
 */
export const LAYA_LIMITS: Readonly<Record<LayaCheckpoint, { stateTokens: number; optionHeadTokens: number; maxOptions: number }>> = Object.freeze({
  english: Object.freeze({ stateTokens: 300, optionHeadTokens: 192, maxOptions: 126 }),
  multilingual: Object.freeze({ stateTokens: 700, optionHeadTokens: 256, maxOptions: 254 }),
  'typed-decisions': Object.freeze({ stateTokens: 700, optionHeadTokens: 256, maxOptions: 254 })
});
export const TYPESAFE_PRICE_USD_PER_MILLION_INPUT = 0.042;

/** The checkpoint a Laya request runs on. A model that names none lets Laya's router pick, so the smallest
 * (`english`) is assumed. */
export function layaCheckpoint(model: string): LayaCheckpoint {
  return (LAYA_CHECKPOINTS as readonly string[]).includes(model) ? model as LayaCheckpoint : 'english';
}

export function sha256Hex(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** A person's server: the reported id must hash to the one the last battery recorded, and the version is the
 * behavioural fingerprint. A server whose id changes between calls is unpinnable, so no id is enforced. */
function fingerprintVersion(prefix: string, label: string, context: ModelContext, reported: string): string | null {
  if (context.unstable) return null;
  if (context.modelHash && sha256Hex(reported) !== context.modelHash) mismatch();
  return context.fingerprint ? `${prefix}${label}@${context.fingerprint.slice(0, 12)}` : null;
}

const TYPESAFE_ORIGIN = 'https://api.typesafe.ai';
const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const VERCEL_ORIGIN = 'https://ai-gateway.vercel.sh';
/** Each cloud route's key is bound to its preset's origin (§5.9); DecisionSecrets enforces the same table. */
export const FIXED_SECRET_ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  'decision-jev': TYPESAFE_ORIGIN,
  'assistant-openrouter': OPENROUTER_ORIGIN,
  'assistant-vercel': VERCEL_ORIGIN
});

export const S1_PRESETS: Readonly<Record<S1PresetId, S1Preset>> = Object.freeze({
  typesafe: {
    id: 'typesafe', dialect: 'typesafe-v1', fixedUrl: `${TYPESAFE_ORIGIN}/v1/systemone`, defaultUrl: null, secretOwner: 'decision-jev',
    requestModel: /^jev-(?:latest|preview|\d+\.\d+(?:\.\d+)?)$/u, defaultModel: 'jev-1.13.0', reportsVersion: 'versioned', pinnable: true,
    contextTokens: 60_000, maxStateTokensPerQuestion: 30_000, maxQuestions: 64, maxOptions: 255,
    attemptTimeoutMs: { warm: 2_500, cold: 2_500 }, expectedLatencyMs: 300, determinismTolerance: 0.03,
    retryCountHeader: 'X-TypeSafe-Retry-Count', requestIdHeader: 'x-typesafe-request-id', priceUsdPerMillionInput: TYPESAFE_PRICE_USD_PER_MILLION_INPUT, calibrated: 'vendor',
    acceptModel(requested, reported) {
      // Only a versioned id: an alias reports the version it resolved to (CONTRACT §6), and one echoed back
      // unchanged would hide the version that stats buckets and drift detection key on (§5.6).
      if (!JEV_VERSION.test(reported)) mismatch();
      // A pin must be answered by itself (jev-1.13 may resolve to its patch, jev-1.13.x).
      if (JEV_VERSION.test(requested) && reported !== requested && !(/^jev-\d+\.\d+$/u.test(requested) && reported.startsWith(`${requested}.`))) mismatch();
      return reported;
    }
  },
  openrouter: {
    id: 'openrouter', dialect: 'typesafe-v1', fixedUrl: `${OPENROUTER_ORIGIN}/api/v1/systemone`, defaultUrl: null, secretOwner: 'assistant-openrouter',
    requestModel: /^(?:typesafe\/jev-\d+\.\d+|~typesafe\/jev-latest)$/u, defaultModel: 'typesafe/jev-1.13', reportsVersion: 'dated', pinnable: true,
    contextTokens: 30_000, maxStateTokensPerQuestion: 30_000, maxQuestions: 64, maxOptions: 255,
    attemptTimeoutMs: { warm: 4_000, cold: 4_000 }, expectedLatencyMs: 600, determinismTolerance: 0.03,
    // ZDR is enforced on every request, and OpenRouter never falls back to another provider.
    extraBody: Object.freeze({ provider: Object.freeze({ zdr: true, data_collection: 'deny', allow_fallbacks: false }) }),
    priceUsdPerMillionInput: TYPESAFE_PRICE_USD_PER_MILLION_INPUT, calibrated: 'vendor',
    acceptModel(requested, reported) {
      if (!OPENROUTER_REPORTED.test(reported)) mismatch();
      if (!requested.startsWith('~') && reported !== requested && !reported.startsWith(`${requested}-`)) mismatch();
      return reported;
    }
  },
  vercel: {
    id: 'vercel', dialect: 'typesafe-v1', fixedUrl: `${VERCEL_ORIGIN}/typesafe/v1/systemone`, defaultUrl: null, secretOwner: 'assistant-vercel',
    requestModel: /^typesafe-ai\/jev$/u, defaultModel: 'typesafe-ai/jev', reportsVersion: 'alias', pinnable: false,
    contextTokens: 30_000, maxStateTokensPerQuestion: 30_000, maxQuestions: 64, maxOptions: 255,
    attemptTimeoutMs: { warm: 4_000, cold: 4_000 }, expectedLatencyMs: 600, determinismTolerance: 0.03,
    priceUsdPerMillionInput: TYPESAFE_PRICE_USD_PER_MILLION_INPUT, calibrated: 'vendor',
    acceptModel(_requested, reported) {
      if (reported !== 'typesafe-ai/jev') mismatch();
      // Vercel drops the resolved version: this route can never be pinned.
      return null;
    }
  },
  laya: {
    id: 'laya', dialect: 'laya', fixedUrl: null, defaultUrl: 'http://127.0.0.1:8000', secretOwner: null,
    requestModel: /^(?:typed-decisions|english|multilingual)$/u, defaultModel: 'typed-decisions', reportsVersion: 'checkpoint', pinnable: true,
    // The largest checkpoint's; presetCaps and every request narrow them to the checkpoint's own (LAYA_LIMITS).
    contextTokens: null, maxStateTokensPerQuestion: 700, maxQuestions: 64, maxOptions: 254,
    attemptTimeoutMs: { warm: 8_000, cold: 30_000 }, expectedLatencyMs: 1_000, determinismTolerance: 0.01,
    priceUsdPerMillionInput: null, calibrated: 'uncalibrated',
    acceptModel(requested, reported, context) {
      if (reported !== 'laya-rl-agent') mismatch();
      if (context.routingModel === null) return null;
      if ((LAYA_CHECKPOINTS as readonly string[]).includes(requested) && context.routingModel !== requested) mismatch();
      return context.routingModel;
    }
  },
  eikos: {
    id: 'eikos', dialect: 'eikos', fixedUrl: null, defaultUrl: 'http://127.0.0.1:8000', secretOwner: null,
    requestModel: /^[^\u0000-\u001f\u007f]{1,200}$/u, defaultModel: 'eikos', reportsVersion: 'fingerprint', pinnable: true,
    // Each question is its own prompt; serve.py --max-tokens 16000 (PyTorch) / max-model-len 16384 (vLLM).
    contextTokens: null, maxStateTokensPerQuestion: 15_000, maxQuestions: 16, maxOptions: 255,
    attemptTimeoutMs: { warm: 8_000, cold: 30_000 }, expectedLatencyMs: 1_000, determinismTolerance: 0.01,
    priceUsdPerMillionInput: null, calibrated: 'uncalibrated',
    acceptModel(_requested, reported, context) {
      // serve.py reports its --model path: hashed, never an identity.
      return fingerprintVersion('eikos:', modelBasename(reported), context, reported);
    }
  },
  custom: {
    id: 'custom', dialect: 'typesafe-v1', fixedUrl: null, defaultUrl: null, secretOwner: null,
    requestModel: /^[^\u0000-\u001f\u007f]{1,200}$/u, defaultModel: 'default', reportsVersion: 'fingerprint', pinnable: true,
    contextTokens: 30_000, maxStateTokensPerQuestion: 30_000, maxQuestions: 64, maxOptions: 255,
    attemptTimeoutMs: { warm: 8_000, cold: 30_000 }, expectedLatencyMs: 1_000, determinismTolerance: 0.01,
    priceUsdPerMillionInput: null, calibrated: 'uncalibrated',
    acceptModel(_requested, reported, context) {
      if (utf8Bytes(reported) > 4096) mismatch();
      return fingerprintVersion('', modelLabel(reported, 'custom'), context, reported);
    }
  }
});

function utf8Bytes(text: string): number { return Buffer.byteLength(text); }

/** The last path segment of a reported model (a filesystem path on Eikos), without control characters. */
export function modelBasename(reported: string): string {
  const parts = reported.split(/[\\/]/u).filter(Boolean);
  return (parts.at(-1) ?? 'model').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 64) || 'model';
}

/**
 * What logs, statistics and the UI show for a reported model (§2.2, §5.7). Versioned cloud ids are shown as
 * they are; anything a person's server reports (Eikos returns its `--model` path, which can hold a user
 * name) becomes basename#<first 8 hex of its sha256>.
 */
export function modelLabel(reported: string, preset: S1PresetId): string {
  if ((preset === 'typesafe' || preset === 'openrouter' || preset === 'vercel' || preset === 'laya') && /^[A-Za-z0-9~][A-Za-z0-9._/~-]{0,99}$/u.test(reported)) return reported;
  return `${modelBasename(reported)}#${sha256Hex(reported).slice(0, 8)}`;
}

/** The model a request names must be one this route offers (Laya honours only its checkpoints, for example). */
export function assertRequestModel(preset: S1Preset, model: string): void {
  if (!preset.requestModel.test(model)) throw new SystemOneError('invalid-request', `The ${preset.id} route does not offer this model.`);
}

/**
 * The DecisionSecrets owner of a backend's key (§5.9): a cloud route's fixed owner, `assistant-local-<id>` for
 * a server on this computer, `assistant-server-<id>` for an https server.
 */
export function secretOwnerFor(preset: S1Preset, backendId: string, locality: S1Locality): string {
  if (preset.secretOwner) return preset.secretOwner;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/u.test(backendId)) throw new SystemOneError('invalid-request', 'Invalid System One backend ID.');
  return `${locality === 'loopback' ? 'assistant-local' : 'assistant-server'}-${backendId}`;
}

/** Endpoint suffixes a custom server may be given directly; anything else is a base URL. */
const ENDPOINT_SUFFIXES = ['/v1/systemone', '/v1/evaluate', '/v1/decisions', '/v1/predict'];
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

export interface ResolvedEndpoint {
  /** The POST URL. */
  endpoint: string;
  /** Scheme, host and port: what a secret is bound to. */
  origin: string;
  /** The URL the read-only probes and the sessions routes hang off. */
  base: string;
  locality: S1Locality;
}

/**
 * The endpoint of a preset. Cloud routes are fixed. A person's server must be literal loopback over http
 * (`localhost` becomes 127.0.0.1) or https anywhere, without credentials, query or fragment. A base URL gets
 * `/v1/systemone` appended; a full endpoint URL is used as given.
 */
export function resolveEndpoint(preset: S1Preset, url?: string): ResolvedEndpoint {
  if (preset.fixedUrl) {
    if (url !== undefined && url !== preset.fixedUrl) throw new SystemOneError('invalid-request', `The ${preset.id} route has a fixed address.`);
    const fixed = new URL(preset.fixedUrl);
    return { endpoint: fixed.toString(), origin: fixed.origin, base: fixed.origin, locality: preset.id === 'typesafe' ? 'vendor-cloud' : 'gateway-cloud' };
  }
  const raw = url ?? preset.defaultUrl;
  const refuse = (): never => { throw new SystemOneError('invalid-request', 'For a server on this computer use 127.0.0.1 or [::1]; a server elsewhere needs https.'); };
  if (typeof raw !== 'string' || raw.length > 500 || /[\u0000- \u007f]/u.test(raw)) refuse();
  let parsed: URL;
  try { parsed = new URL(raw as string); } catch { return refuse(); }
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  const loopback = LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback) || parsed.username || parsed.password || parsed.search || parsed.hash) refuse();
  const path = parsed.pathname.replace(/\/+$/u, '');
  const suffix = ENDPOINT_SUFFIXES.find(item => path.endsWith(item));
  if (suffix && suffix !== '/v1/systemone' && preset.id !== 'custom') refuse();
  const basePath = suffix ? path.slice(0, -suffix.length) : path;
  const base = `${parsed.origin}${basePath}`;
  return { endpoint: suffix ? `${parsed.origin}${path}` : `${base}/v1/systemone`, origin: parsed.origin, base, locality: loopback ? 'loopback' : 'remote-host' };
}

export interface DialectLimits { maxQuestions: number; maxOptions: number; maxStateTokensPerQuestion: number; optionHeadTokens: number | null }

/**
 * What a server of this dialect takes, whichever preset reached it (a custom server the battery finds to be
 * Laya or Eikos, §1.4): Laya per checkpoint, Eikos per question prompt (`serve.py --max-tokens`). On both, each
 * question is its own prompt, so there is no request cap. null for `typesafe-v1`: its preset decides.
 */
export function dialectLimits(dialect: HttpDialect, model: string): DialectLimits | null {
  if (dialect === 'laya') {
    const checkpoint = LAYA_LIMITS[layaCheckpoint(model)];
    return { maxQuestions: LAYA_MAX_QUESTIONS, maxOptions: checkpoint.maxOptions, maxStateTokensPerQuestion: checkpoint.stateTokens, optionHeadTokens: checkpoint.optionHeadTokens };
  }
  if (dialect === 'eikos') return { maxQuestions: EIKOS_MAX_QUESTIONS, maxOptions: S1_PRESETS.eikos.maxOptions, maxStateTokensPerQuestion: S1_PRESETS.eikos.maxStateTokensPerQuestion, optionHeadTokens: null };
  return null;
}

/** Caps within a dialect's limits: they only ever lower a number; the request cap goes (0). */
export function capsWithinDialect(caps: BackendCaps, dialect: HttpDialect, model: string): BackendCaps {
  const limits = dialectLimits(dialect, model);
  if (!limits) return caps;
  const next = structuredClone(caps);
  next.maxQuestions = Math.min(next.maxQuestions, limits.maxQuestions);
  next.maxOptions = Math.min(next.maxOptions, limits.maxOptions);
  next.maxStateTokensPerQuestion = Math.min(next.maxStateTokensPerQuestion, limits.maxStateTokensPerQuestion);
  next.contextTokens = 0;
  if (limits.optionHeadTokens !== null) next.optionHeadTokens = Math.min(next.optionHeadTokens ?? Infinity, limits.optionHeadTokens);
  return next;
}

/** Preset limits before any conformance run. Laya's depend on the checkpoint. */
export function presetCaps(preset: S1Preset, model: string): BackendCaps {
  const caps: BackendCaps = {
    types: { noul: true, choice: true, score: true },
    maxQuestions: preset.maxQuestions, maxOptions: preset.maxOptions,
    // 0: no request cap, each question is its own prompt (Eikos, Laya).
    contextTokens: preset.contextTokens ?? 0,
    maxStateTokensPerQuestion: preset.maxStateTokensPerQuestion,
    limitsSource: 'preset', decimals: null, reportsVersion: preset.reportsVersion,
    sessions: false, sessionSpeedup: null, keyEnforced: null,
    // Unknown until the battery has run: no cache and no AUTO before it.
    deterministic: false, orderSensitivity: 'none', calibrated: preset.calibrated,
    fingerprint: '', fingerprintVector: [], modelHash: null, dialect: preset.dialect,
    testedAt: 0, latencyMs: { p50: preset.expectedLatencyMs, p95: preset.expectedLatencyMs }
  };
  return preset.id === 'laya' ? capsWithinDialect(caps, 'laya', model) : caps;
}
