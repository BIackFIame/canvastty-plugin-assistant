/**
 * The assistant's («Помощник») settings and decision shapes, ported from the CanvasTTY chain (shared/assistant.ts,
 * shared/dataClassMode.ts). In CanvasTTY they lived in the app settings; here they live in the plugin's own storage
 * (key `settings`, non-secret) and every backend key lives in the plugin's `secrets`, which only the service reads.
 *
 * The assistant is off by default; while off nothing runs (R8). Shared by the service and the settings page: no
 * Node APIs.
 */
import type { S1Answer, S1Locality } from './systemOne.ts';
import {
  ASSISTANT_USE_CASES, DEFAULT_ASSISTANT_BUDGETS, DEFAULT_USE_CASE_MODES, LOG_POLICY,
  type AssistantMode, type AssistantUseCase, type Band, type BackendFamily, type QualifiedOutcome
} from './catalog.ts';

export type { AssistantMode, AssistantUseCase, Band, BackendFamily, QualifiedOutcome } from './catalog.ts';

/** D0 public … D3 secret: what a text may carry, as the person classes it. */
export type DataClass = 'D0' | 'D1' | 'D2' | 'D3';
export const DATA_CLASSES: readonly DataClass[] = ['D0', 'D1', 'D2', 'D3'];
const RANK: Readonly<Record<DataClass, number>> = Object.freeze({ D0: 0, D1: 1, D2: 2, D3: 3 });

/**
 * How data classes act (L9b «Проверка данных»):
 *  - strict: nothing above the receiver's level leaves;
 *  - warn:   a level the person set still holds; a review or estimate below the grant only yields a notice;
 *  - off:    any class, whenever the grant allows text at all.
 * Credential redaction is not a data-class check and runs in every mode.
 */
export type DataClassMode = 'strict' | 'warn' | 'off';
export const DATA_CLASS_MODES: readonly DataClassMode[] = ['strict', 'warn', 'off'];
/** Where a level comes from: the person's own trust wins over a review; CanvasTTY's estimate counts only without either. */
export type TrustSource = 'trust' | 'review' | 'estimate';

/** «только служебные признаки» (`off`: metadata only), «тексты до D1», «тексты до D2» (§1.5, §6.2). */
export type AssistantGrant = 'off' | 'D1' | 'D2';
/** «Где работает» (§6.1): Jev first for whatever the gate allows, then this computer; Jev only; this computer only. */
export type AssistantEngineChoice = 'auto' | 'jev' | 'local';

export const ASSISTANT_JEV_PRESETS = ['typesafe', 'openrouter', 'vercel'] as const;
export const ASSISTANT_SERVER_PRESETS = ['laya', 'eikos', 'custom'] as const;
export type AssistantBackendPreset = typeof ASSISTANT_JEV_PRESETS[number] | typeof ASSISTANT_SERVER_PRESETS[number] | 'emulated';
/** A remote backend's trust stops at D2: nothing above the grant (at most D2) leaves in Strict and Warn (§1.5). */
export type AssistantBackendTrust = 'D0' | 'D1' | 'D2';

/** One decision model the person connected (§1.4). Non-secret: keys live in the plugin's secrets. */
export interface AssistantBackendSettings {
  id: string;
  preset: AssistantBackendPreset;
  enabled: boolean;
  /** A person's server (laya, eikos, custom, emulated); cloud routes are fixed. */
  url?: string;
  model?: string;
  /** Emulated backends only: an ordinary model on Ollama, read by option-letter logprobs. */
  runtime?: 'ollama';
  profile?: 'semif-v1' | 'eikos-v1';
  /** «Доверяю {backend}: до Dx» — the person's own level; wins over any review (§1.5). */
  trust?: AssistantBackendTrust;
  /** The one-time «Сервер работает на этом компьютере и никуда не отправляет данные» for this port. */
  localConfirmed?: { port: number; at: number };
}

export type AssistantSmartSettings = { kind: 'none' } | { kind: 'ollama-chat'; url: string; model: string };

/** Review strictness: `triage` makes a session strict when its launch task looks risky (§3.1a step 7); `strict` always. */
export type ReviewStrictness = 'triage' | 'strict';

export interface AssistantSettings {
  /** Off by default. While off: no call, no model load, every hook answers "no opinion" (R8). */
  enabled: boolean;
  engine: AssistantEngineChoice;
  grant: AssistantGrant;
  dataClassMode: DataClassMode;
  /** The class of a card's text (its task, its commands) unless its launch option says otherwise. */
  defaultDataClass: DataClass;
  /** Per use case (§4.1): Off, Learning (`shadow`), Suggest, Auto. */
  modes: Record<AssistantUseCase, AssistantMode>;
  /** In chain order within each step (§1.3). */
  backends: AssistantBackendSettings[];
  /** The second model for disputed cases (§2.6): a larger local Ollama model. */
  smart: AssistantSmartSettings;
  /** «Пока учится, также спрашивать умную модель» (§4.1): off by default. */
  shadowAsksSmart: boolean;
  reviewStrictness: ReviewStrictness;
  budgets: { perMinute: number; perDay: number; cloudUsdPerDay: number };
  logRetentionDays: number;
}

export const MAX_ASSISTANT_BACKENDS = 16;

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  enabled: false,
  engine: 'auto',
  grant: 'off',
  dataClassMode: 'warn',
  defaultDataClass: 'D2',
  modes: { ...DEFAULT_USE_CASE_MODES },
  backends: [],
  smart: { kind: 'none' },
  shadowAsksSmart: false,
  reviewStrictness: 'triage',
  budgets: { ...DEFAULT_ASSISTANT_BUDGETS },
  logRetentionDays: LOG_POLICY.retentionDays
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/u;
const MODEL = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const MODES: readonly AssistantMode[] = ['off', 'shadow', 'suggest', 'auto'];

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(message = 'Invalid assistant settings.'): never { throw new Error(message); }
function exact(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
}

/** http(s) with no credentials, query or fragment; plain http only on literal loopback (§1.4). */
export function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500 || /[\u0000- \u007f]/u.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  return (url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password && !url.search && !url.hash;
}

export function isJevPreset(preset: AssistantBackendPreset): boolean { return (ASSISTANT_JEV_PRESETS as readonly string[]).includes(preset); }

export function validateAssistantBackend(value: unknown): AssistantBackendSettings {
  exact(value, ['id', 'preset', 'enabled', 'url', 'model', 'runtime', 'profile', 'trust', 'localConfirmed'], ['id', 'preset', 'enabled']);
  if (typeof value.id !== 'string' || !ID.test(value.id) || typeof value.enabled !== 'boolean') fail('Invalid assistant backend.');
  const preset = value.preset;
  const jev = (ASSISTANT_JEV_PRESETS as readonly unknown[]).includes(preset);
  if (!jev && !(ASSISTANT_SERVER_PRESETS as readonly unknown[]).includes(preset) && preset !== 'emulated') fail('Invalid assistant backend.');
  if (jev && value.url !== undefined) fail('A Jev route has a fixed address.');
  if (!jev && !validUrl(value.url) && !(preset === 'emulated' && value.url === undefined)) fail('Invalid assistant backend address.');
  if (value.url !== undefined && !validUrl(value.url)) fail('Invalid assistant backend address.');
  if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL.test(value.model))) fail('Invalid assistant backend model.');
  if (preset === 'emulated') {
    if (value.runtime !== 'ollama' || typeof value.model !== 'string') fail('An emulated backend needs the Ollama runtime and a model.');
    if (value.profile !== undefined && value.profile !== 'semif-v1' && value.profile !== 'eikos-v1') fail('Invalid prompt profile.');
  } else if (value.runtime !== undefined || value.profile !== undefined) fail('Invalid assistant backend.');
  if (value.trust !== undefined && !['D0', 'D1', 'D2'].includes(value.trust as string)) fail('Invalid assistant backend trust.');
  if (value.localConfirmed !== undefined) {
    exact(value.localConfirmed, ['port', 'at'], ['port', 'at']);
    const { port, at } = value.localConfirmed;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535 || !Number.isSafeInteger(at) || (at as number) < 0) fail('Invalid local confirmation.');
    if (jev) fail('A Jev route is never on this computer.');
  }
  return structuredClone(value) as unknown as AssistantBackendSettings;
}

export function validateAssistantSettings(value: unknown): AssistantSettings {
  const keys = Object.keys(DEFAULT_ASSISTANT_SETTINGS);
  exact(value, keys, keys);
  if (typeof value.enabled !== 'boolean' || !['auto', 'jev', 'local'].includes(value.engine as string) || !['off', 'D1', 'D2'].includes(value.grant as string)
    || typeof value.shadowAsksSmart !== 'boolean'
    || !DATA_CLASS_MODES.includes(value.dataClassMode as DataClassMode) || !DATA_CLASSES.includes(value.defaultDataClass as DataClass)
    || !['triage', 'strict'].includes(value.reviewStrictness as string)) fail();
  exact(value.modes, ASSISTANT_USE_CASES, ASSISTANT_USE_CASES);
  for (const useCase of ASSISTANT_USE_CASES) if (!MODES.includes(value.modes[useCase] as AssistantMode)) fail('Invalid assistant mode.');
  if (!Array.isArray(value.backends) || value.backends.length > MAX_ASSISTANT_BACKENDS) fail('Too many assistant backends.');
  const ids = new Set<string>();
  for (const backend of value.backends) {
    const checked = validateAssistantBackend(backend);
    if (ids.has(checked.id)) fail('Duplicate assistant backend.');
    ids.add(checked.id);
  }
  const smart = value.smart;
  if (!isRecord(smart) || smart.kind === 'none' && Object.keys(smart).length !== 1) fail('Invalid smart verifier.');
  if (smart.kind === 'ollama-chat') {
    exact(smart, ['kind', 'url', 'model'], ['kind', 'url', 'model']);
    if (!validUrl(smart.url) || typeof smart.model !== 'string' || !MODEL.test(smart.model)) fail('Invalid smart verifier.');
  } else if (smart.kind !== 'none') fail('Invalid smart verifier.');
  exact(value.budgets, ['perMinute', 'perDay', 'cloudUsdPerDay'], ['perMinute', 'perDay', 'cloudUsdPerDay']);
  const { perMinute, perDay, cloudUsdPerDay } = value.budgets;
  if (!Number.isInteger(perMinute) || (perMinute as number) < 1 || (perMinute as number) > 1200 || !Number.isInteger(perDay) || (perDay as number) < 1 || (perDay as number) > 1_000_000
    || typeof cloudUsdPerDay !== 'number' || !Number.isFinite(cloudUsdPerDay) || cloudUsdPerDay < 0 || cloudUsdPerDay > 100) fail('Invalid assistant budget.');
  if (!Number.isInteger(value.logRetentionDays) || (value.logRetentionDays as number) < 1 || (value.logRetentionDays as number) > 365) fail('Invalid log retention.');
  return structuredClone(value) as unknown as AssistantSettings;
}

/**
 * Settings as saved, made valid: missing fields take their defaults, an unknown mode falls back alone, and a bad
 * backend entry disables only itself (it is dropped). The assistant never turns itself on here.
 */
export function normalizeAssistantSettings(value: unknown): AssistantSettings {
  const source = isRecord(value) ? value : {};
  const modesSource = isRecord(source.modes) ? source.modes : {};
  const modes = Object.fromEntries(ASSISTANT_USE_CASES.map(useCase => {
    const mode = modesSource[useCase];
    return [useCase, MODES.includes(mode as AssistantMode) ? mode : DEFAULT_ASSISTANT_SETTINGS.modes[useCase]];
  })) as Record<AssistantUseCase, AssistantMode>;
  const backends: AssistantBackendSettings[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(source.backends) ? source.backends.slice(0, MAX_ASSISTANT_BACKENDS) : []) {
    try {
      const checked = validateAssistantBackend(entry);
      if (!ids.has(checked.id)) { ids.add(checked.id); backends.push(checked); }
    } catch { /* this entry alone is disabled */ }
  }
  const candidate: Record<string, unknown> = { ...structuredClone(DEFAULT_ASSISTANT_SETTINGS), modes, backends, enabled: source.enabled === true };
  for (const key of Object.keys(DEFAULT_ASSISTANT_SETTINGS) as Array<keyof AssistantSettings>) {
    if (key === 'enabled' || key === 'modes' || key === 'backends' || !Object.hasOwn(source, key)) continue;
    try { validateAssistantSettings({ ...candidate, [key]: source[key] }); candidate[key] = structuredClone(source[key]); } catch { /* keeps the default */ }
  }
  return validateAssistantSettings(candidate);
}

// ---------------------------------------------------------------------------
// Data classes (L9b): the grant rule for text leaving this computer
// ---------------------------------------------------------------------------

export const classAtMost = (value: DataClass, cap: DataClass | null): boolean => cap !== null && RANK[value] <= RANK[cap];
export const maxClass = (a: DataClass, b: DataClass): DataClass => RANK[a] >= RANK[b] ? a : b;
export const classRank = (value: DataClass): number => RANK[value];

/**
 * The Strict grant rule for an optional egress of text. `grant` is the person's own choice of what may leave
 * ("off" means metadata only); `level` is the receiving route's level.
 * - Strict: min(grant, level); a review or estimate below the grant holds text back.
 * - Warn: the grant, further limited by the level only when the person set it; otherwise only a notice.
 * - Off: any class, D3 included, whenever the grant allows text at all.
 * In Strict and Warn nothing above D2 leaves. Grant "off" sends no text in any mode.
 */
export function textEgressCap(mode: DataClassMode, grant: AssistantGrant, level?: { cap: DataClass; source: TrustSource }): { cap: DataClass | null; notice?: { cap: DataClass; source: TrustSource } } {
  if (grant === 'off') return { cap: null };
  if (mode === 'off') return { cap: 'D3' };
  const limited: DataClass = RANK[grant] > RANK.D2 ? 'D2' : grant;
  if (!level || RANK[level.cap] >= RANK[limited]) return { cap: limited };
  if (mode === 'strict' || level.source === 'trust') return { cap: level.cap };
  return { cap: limited, notice: { cap: level.cap, source: level.source } };
}

// ---------------------------------------------------------------------------
// Decisions (§2.7)
// ---------------------------------------------------------------------------

/** Where a state went, after the gate (§1.3). */
export type AssistantTarget = 'local' | 'remote';
export type AssistantVariant = 'full' | 'metadata';

/** Why a decision fell back to the assistant-off behaviour (R4). */
export type AssistantFallbackReason =
  | 'data-class' | 'metadata-grant-required' | 'no-backend' | 'credential-required' | 'credential-unavailable'
  | 'breaker-open' | 'budget' | 'timeout' | 'rate-limited' | 'auth' | 'quota' | 'version-mismatch' | 'evaluation-unavailable'
  | 'incompatible' | 'stale' | 'settings-changed' | 'aborted' | 'error';

export type AssistantBranch = 'off' | 'rule' | 'fallback' | 'shadow-recorded' | 'suggest' | 'auto';

export interface AssistantBackendRef {
  id: string; preset: AssistantBackendPreset; family: BackendFamily; locality: S1Locality; target: AssistantTarget;
  modelLabel: string | null; resolvedVersion: string | null; pinned: boolean; calibrated: 'vendor' | 'fitted' | 'uncalibrated';
}

export interface AssistantDecision {
  branch: AssistantBranch;
  useCase: AssistantUseCase;
  /** Joins labels to this decision (§4.2); null when nothing was decided (off). */
  auditId: string | null;
  mode: AssistantMode;
  /** The answers, in memory only. Shadow keeps them for the recorder and returns the assistant-off behaviour. */
  answers: Record<string, S1Answer> | null;
  bands: Record<string, Band> | null;
  outcome: string | null;
  qualifiedOutcome: QualifiedOutcome | null;
  /** Act on `outcome`: only in Auto, only for a qualified outcome (R3, R9, R10). */
  enforce: boolean;
  variant: AssistantVariant | null;
  backend: AssistantBackendRef | null;
  /** A field was cut by its length bound: no AUTO (R3). */
  truncated: boolean;
  cached: boolean;
  fallbackReason: AssistantFallbackReason | null;
  /** A Warn-only send above a review or estimate level (§1.5). */
  notice: { backendId: string; cap: DataClass; source: TrustSource } | null;
}

/** The settings page's view of one backend: never a key, never a URL secret. */
export interface AssistantBackendStatus {
  id: string; preset: AssistantBackendPreset; enabled: boolean;
  target: AssistantTarget;
  level: { cap: DataClass; source: TrustSource | 'local' };
  breaker: { state: 'closed' | 'open' | 'half-open'; reason: string | null; retryAt: number | null };
  tested: boolean; calibrated: 'vendor' | 'fitted' | 'uncalibrated'; deterministic: boolean;
  /** null: this backend takes no key. */
  keyConfigured: boolean | null;
  latencyMs: number | null;
}

export interface AssistantCheckResult {
  backendId: string; added: boolean; checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail' | 'skip'; detail: string }>; requests: number; failure: string | null;
  latencyMs: number | null; modelLabel: string | null;
}

// ---------------------------------------------------------------------------
// Labels and statistics (§4.2, §4.5): no content, ever
// ---------------------------------------------------------------------------

/** Where a label came from: the person's own answer (the only one that qualifies command review, R11) or a later signal. */
export type AssistantLabelSource = 'person' | 'smart' | 'orchestrator' | 'signal' | 'proxy';

export interface AssistantUseCaseStats {
  calls: number; labelled: number; agreement: number | null;
  bands: Partial<Record<Band, number>>; fallbacks: Record<string, number>;
  latencyMs: { p50: number | null; p95: number | null }; costUsd: number;
}

/** Statistics without any content (§4.5). */
export interface AssistantStatsExport {
  catalogVersion: number; from: number; to: number;
  useCases: Partial<Record<AssistantUseCase, AssistantUseCaseStats>>;
  qualification: Array<{ key: string; useCase: AssistantUseCase; outcome: QualifiedOutcome; family: BackendFamily; resolvedVersion: string | null; n: number; nMin: number; errorUpperBound: number | null; eMax: number; qualified: boolean; reason: string | null }>;
}
