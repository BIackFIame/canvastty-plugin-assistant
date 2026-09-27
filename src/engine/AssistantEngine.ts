import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_CATALOG_VERSION, CACHE_TTL_MS, METADATA_VARIANTS, QUESTION_SETS, SMART_DEADLINE_MS, USE_CASE_DEADLINES_MS, USE_CASE_SETS,
  type ActionClass, type AssistantUseCase, type Band, type BackendFamily, type QualifiedOutcome, type QuestionSetId
} from '../shared/catalog.ts';
import {
  isJevPreset,
  type AssistantBackendRef, type AssistantBackendSettings, type AssistantBackendStatus, type AssistantCheckResult, type AssistantDecision,
  type AssistantFallbackReason, type AssistantSettings, type AssistantStatsExport, type AssistantTarget, type AssistantVariant, type DataClass, type TrustSource
} from '../shared/settings.ts';
import { s1ErrorClass, type BackendCaps, type S1Answer, type S1ErrorClass, type S1Question, type S1Result } from '../shared/systemOne.ts';
import { CircuitBreaker } from './backends/CircuitBreaker.ts';
import { SystemOneHttpBackend } from './backends/SystemOneHttpBackend.ts';
import { EmulatedSystemOneBackend } from './backends/EmulatedSystemOneBackend.ts';
import { AssistantBudget } from './AssistantBudget.ts';
import { AssistantCache, canonicalJson, questionSetHash } from './AssistantCache.ts';
import { AssistantLog, decisionRecord, type DecisionRecordInput, type LabelRecord } from './AssistantLog.ts';
import { AssistantSecrets, type DecisionSecretsLike } from './AssistantSecrets.ts';
import { AssistantStats } from './AssistantStats.ts';
import { bandOf, thresholdFor } from './bands.ts';
import { CapsStore, engineUse, IncompatibilityTracker, runBattery, supportsSet } from './conformance.ts';
import { backendLevel, gateFields, gateTarget, type AssistantField, type GateTarget } from './privacyGate.ts';
import { redactAndBound, redactValue } from './redact.ts';
import { ShadowRecorder } from './ShadowRecorder.ts';
import { SmartVerifier } from './SmartVerifier.ts';

/**
 * The one engine every decision of the plugin goes through (assistant spec §2.7), ported from the CanvasTTY chain.
 * Nothing else talks to a decision model. Constructing it does nothing: no file is read, no backend is built, nothing is called
 * until the person turns the assistant on and a use case asks (R8).
 *
 * `ask()`:
 *  1. off (assistant or use case) → `{branch:'off'}` with no work at all;
 *  2. a deterministic rule the caller already applied → `{branch:'rule'}`;
 *  3. the state: every field redacted (both passes, every mode) before its length bound;
 *  4. per chain step, the privacy gate — before any credential read, cache lookup or egress;
 *  5. the cache (answers only); 6. a budget slot, reserved synchronously; 7. the breaker (inside the backend);
 *  8. the call, then `assertCurrent()`; 9. validation and the pin (inside the backend);
 * 10. bands; 11. the mode (shadow: the assistant-off behaviour; suggest: advisory; auto: acts only when the
 *     outcome qualified); 12. one log record, registered with the shadow recorder.
 * Any exception anywhere is the assistant-off behaviour for that use case (R4), logged with its reason.
 */

export interface AssistantRequest {
  useCase: AssistantUseCase;
  set: QuestionSetId;
  /** Content fields carry text; metadata fields carry only code facts and shapes. */
  fields: Array<AssistantField & { bound?: number }>;
  /** A deterministic rule already decided (§2.7 step 2). */
  rule?: string | null;
  actionClass?: ActionClass;
  /** Code-authored, ≤ 80 characters (§5.7). */
  summary?: string;
  /** Extra cache scope (command review: session + cwd + facts hash). */
  cacheScope?: string;
  /**
   * The use case's pure code mapping (§3.1): answers and bands → the outcome, and the outcome that would act in
   * Auto once qualified (null outside its AUTO band). Without one nothing is ever enforced.
   */
  map?: (answers: Record<string, S1Answer>, bands: Record<string, Band>, meta: { variant: AssistantVariant; truncated: boolean; family: BackendFamily; autoCapable: boolean }) => { outcome: string; qualifiedOutcome: QualifiedOutcome | null };
}

export interface AskContext {
  signal: AbortSignal;
  /** The caller's pending-key recheck (R5): throws when the decision is no longer wanted. */
  assertCurrent(): void;
  sessionId?: string;
  requester: 'person' | 'orchestrator' | 'agent' | 'system';
}

export interface AssistantEngineOptions {
  settings: () => AssistantSettings;
  /** `<plugin data>/assistant`. */
  directory: string;
  secrets: DecisionSecretsLike;
  transport?: typeof fetch;
  now?: () => number;
}

type AnyBackend = SystemOneHttpBackend | EmulatedSystemOneBackend;
interface Built { config: string; backend: AnyBackend; breaker: CircuitBreaker }

const RELAXING: ReadonlySet<QualifiedOutcome> = new Set(['default', 'auto-allow', 'verify-allow']);

function familyOf(entry: AssistantBackendSettings): BackendFamily {
  if (isJevPreset(entry.preset)) return 'jev';
  if (entry.preset === 'laya' || entry.preset === 'eikos') return entry.preset;
  return entry.preset === 'emulated' ? 'emulated' : 'systemone-generic';
}

const REASONS: Partial<Record<S1ErrorClass, AssistantFallbackReason>> = {
  'breaker-open': 'breaker-open', timeout: 'timeout', rate: 'rate-limited', auth: 'auth', quota: 'quota', 'version-mismatch': 'version-mismatch', aborted: 'aborted'
};

class StaleDecision extends Error {}

export class AssistantEngine {
  private readonly options: AssistantEngineOptions;
  private readonly now: () => number;
  readonly secrets: AssistantSecrets;
  private readonly cache: AssistantCache;
  private readonly budget: AssistantBudget;
  private readonly log: AssistantLog;
  private readonly stats = new AssistantStats();
  private readonly shadow: ShadowRecorder;
  private readonly capsStore: CapsStore;
  private readonly incompatibility = new IncompatibilityTracker();
  private readonly smart: SmartVerifier;
  private readonly built = new Map<string, Built>();
  private readonly versions = new Map<string, string | null>();
  private statsLoaded: Promise<void> | null = null;
  private epoch = 0;
  private revision = '';
  private controller = new AbortController();

  constructor(options: AssistantEngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.secrets = new AssistantSecrets(options.secrets);
    this.cache = new AssistantCache({ now: this.now });
    this.budget = new AssistantBudget({ limits: () => this.assistant().budgets, now: this.now });
    this.log = new AssistantLog({ directory: options.directory, now: this.now, retentionDays: () => this.assistant().logRetentionDays });
    this.shadow = new ShadowRecorder({ now: this.now, sink: record => this.appendLabel(record) });
    this.capsStore = new CapsStore(options.directory);
    this.smart = new SmartVerifier({ settings: () => this.assistant().smart, ...(options.transport ? { transport: options.transport } : {}) });
    this.revision = this.privacySnapshot();
  }

  private assistant(): AssistantSettings { return this.options.settings(); }

  /** What the cache key and pending decisions depend on (§5.4): the settings, the data-check mode included. */
  private privacySnapshot(): string { return canonicalJson(this.options.settings()); }

  /**
   * Any change to the assistant settings, the data-check mode, trust levels or a key: clears the cache and voids
   * pending decisions. Turning the assistant off also cancels everything in flight; after that nothing runs.
   */
  settingsChanged(): void {
    const next = this.privacySnapshot();
    const enabled = this.assistant().enabled;
    if (next === this.revision && enabled) return;
    this.revision = next;
    this.invalidate();
    if (!enabled) { this.shadow.clear(); this.built.clear(); }
  }

  /** Credentials, pins or policy changed: forget cached answers and void pending decisions. */
  invalidate(): void {
    this.epoch++;
    this.cache.clear();
    this.controller.abort(new Error('settings changed'));
    this.controller = new AbortController();
  }

  dispose(): void { this.invalidate(); this.built.clear(); }

  // -------------------------------------------------------------------------
  // Backends
  // -------------------------------------------------------------------------

  private backendFor(entry: AssistantBackendSettings): Built {
    const config = canonicalJson(entry);
    const existing = this.built.get(entry.id);
    if (existing && existing.config === config) return existing;
    const breaker = existing?.breaker ?? new CircuitBreaker({ now: this.now });
    const caps = this.capsStore.get(entry);
    const common = { id: entry.id, ...(caps ? { caps } : {}), ...(this.options.transport ? { transport: this.options.transport } : {}), breaker, now: this.now };
    let backend: AnyBackend;
    if (entry.preset === 'emulated') {
      backend = new EmulatedSystemOneBackend({ ...common, runtime: entry.runtime!, model: entry.model!, ...(entry.url ? { url: entry.url } : {}), ...(entry.profile ? { profile: entry.profile } : {}),
        credentialGeneration: () => this.secrets.generation(backend.secretOwner) });
    } else {
      backend = new SystemOneHttpBackend({ ...common, preset: entry.preset, ...(entry.url ? { url: entry.url } : {}), ...(entry.model ? { model: entry.model } : {}),
        credentialGeneration: () => this.secrets.generation(backend.secretOwner) });
    }
    const built = { config, backend, breaker };
    this.built.set(entry.id, built);
    return built;
  }

  private static port(backend: AnyBackend): number | null {
    try {
      const url = new URL(backend instanceof SystemOneHttpBackend ? backend.origin : backend.base);
      return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    } catch { return null; }
  }

  private targetFor(entry: AssistantBackendSettings, backend: AnyBackend): { kind: AssistantTarget; target: GateTarget } {
    return gateTarget(entry, backend.locality, AssistantEngine.port(backend));
  }

  /** The chain for this call (§1.3): Jev routes first under `auto`, only them under `jev`; `local` keeps what runs here. */
  private chain(settings: AssistantSettings): AssistantBackendSettings[] {
    const enabled = settings.backends.filter(entry => entry.enabled);
    const jev = enabled.filter(entry => isJevPreset(entry.preset)), other = enabled.filter(entry => !isJevPreset(entry.preset));
    if (settings.engine === 'jev') return jev;
    if (settings.engine === 'local') return other;
    return [...jev, ...other];
  }

  // -------------------------------------------------------------------------
  // ask()
  // -------------------------------------------------------------------------

  private blank(request: AssistantRequest, mode: AssistantDecision['mode'], branch: AssistantDecision['branch'], fallbackReason: AssistantFallbackReason | null = null): AssistantDecision {
    return { branch, useCase: request.useCase, auditId: null, mode, answers: null, bands: null, outcome: null, qualifiedOutcome: null, enforce: false, variant: null, backend: null, truncated: false, cached: false, fallbackReason, notice: null };
  }

  async ask(request: AssistantRequest, ctx: AskContext): Promise<AssistantDecision> {
    const assistant = this.options.settings();
    const mode = assistant?.enabled ? assistant.modes[request.useCase] : 'off';
    // 1. Off: nothing at all (R8).
    if (!assistant?.enabled || mode === 'off' || !mode) return this.blank(request, 'off', 'off');
    // 2. A deterministic rule decided already.
    if (request.rule) return this.blank(request, mode, 'rule');
    // Settings can change on any path (the privacy line, an agent, a migration): a new snapshot voids the cache.
    if (this.privacySnapshot() !== this.revision) this.settingsChanged();
    const epoch = this.epoch;
    const started = this.now();
    const auditId = randomUUID();
    const current = (): void => { try { ctx.assertCurrent(); } catch { throw new StaleDecision('stale'); } };
    const record: Partial<DecisionRecordInput> = {};
    try {
      if (!USE_CASE_SETS[request.useCase].includes(request.set)) throw new Error('This question set does not belong to the use case.');
      // 3. State: redaction (both passes) runs before every bound, in every mode, for local backends too.
      let redactions = 0, truncated = false;
      const fields: AssistantField[] = request.fields.map(field => {
        if (typeof field.value === 'string' && field.bound !== undefined) {
          const result = redactAndBound(field.value, field.bound);
          redactions += result.count; truncated ||= result.truncated;
          return { name: field.name, value: result.text, dataClass: field.dataClass, disclosure: field.disclosure };
        }
        const result = redactValue(field.value);
        redactions += result.count;
        return { name: field.name, value: result.value, dataClass: field.dataClass, disclosure: field.disclosure };
      });
      record.redactions = redactions; record.truncated = truncated;
      const dataMode = assistant.dataClassMode;
      const deadlineAt = started + USE_CASE_DEADLINES_MS[request.useCase];
      await this.capsStore.load();
      let lastReason: AssistantFallbackReason = 'no-backend';
      let lastGate: DecisionRecordInput['fields'] = { sent: [], withheld: [] };
      // §1.3: every backend that may take the full state first (Jev, then this computer); the metadata-only
      // variant (step 3) only after all of them.
      const chain = this.chain(assistant);
      const attempts = [...chain.map(entry => ({ entry, pass: 'full' as const })), ...chain.map(entry => ({ entry, pass: 'metadata' as const }))];
      for (const { entry, pass } of attempts) {
        if (this.epoch !== epoch) throw new StaleDecision('settings-changed');
        const { backend } = this.backendFor(entry);
        const family = familyOf(entry);
        // An Ollama model counts as local only after the read-only §1.4 probe (no user data).
        if (backend instanceof EmulatedSystemOneBackend && backend.runtime === 'ollama' && !backend.lastProbe && entry.localConfirmed) {
          try { await backend.probe({ signal: this.linked(ctx.signal), deadlineAt }); } catch { lastReason = 'evaluation-unavailable'; continue; }
        }
        const target = this.targetFor(entry, backend);
        if (assistant.engine === 'local' && target.kind !== 'local') continue;
        // 4. The privacy gate, before any credential read, cache lookup or egress.
        const metaSet = METADATA_VARIANTS[request.set];
        const gated = gateFields(fields, dataMode, assistant.grant, target.target, !!metaSet);
        lastGate = { sent: gated.sent, withheld: gated.withheld };
        if (!gated.variant) { if (pass === 'full') lastReason = assistant.grant === 'off' && target.kind === 'remote' ? 'metadata-grant-required' : 'data-class'; continue; }
        if (gated.variant !== pass) { if (pass === 'full') lastReason = assistant.grant === 'off' && target.kind === 'remote' ? 'metadata-grant-required' : 'data-class'; continue; }
        const setId = gated.variant === 'metadata' ? metaSet! : request.set;
        const questions: Record<string, S1Question> = structuredClone(QUESTION_SETS[setId]) as Record<string, S1Question>;
        const caps = backend.caps();
        const use = engineUse(caps, request.useCase);
        if (this.incompatibility.isIncompatible(entry.id, setId)) { lastReason = 'incompatible'; continue; }
        if (!supportsSet(caps, questions) || !use.fitsDeadline) { lastReason = 'evaluation-unavailable'; continue; }
        const level = target.kind === 'remote' ? backendLevel(entry) : null;
        record.dataCheck = { mode: dataMode, grant: assistant.grant, level, aboveLevel: !!gated.notice };
        record.fields = lastGate;
        const privacyRevision = canonicalJson([dataMode, assistant.grant, target.kind, level, target.target]);
        const setHash = questionSetHash(QUESTION_SETS[setId]);
        // 5. The cache: answers only; bands and mode rerun below.
        const cacheKey = this.cache.key({ backendId: entry.id, version: this.versions.get(entry.id) ?? backend.model, temperature: 1, catalogVersion: ASSISTANT_CATALOG_VERSION, questionSetHash: setHash, state: gated.state, privacyRevision, ...(request.cacheScope ? { scope: request.cacheScope } : {}) });
        let result: Pick<S1Result, 'answers' | 'resolvedVersion' | 'modelLabel'> & Partial<S1Result> | null = use.cacheable ? this.cache.get(cacheKey) : null;
        const cached = !!result;
        if (!result) {
          // 6. A budget slot, reserved synchronously before any await.
          const reservation = this.budget.reserve({ useCase: request.useCase, cloud: target.kind !== 'local', ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) });
          if (!reservation) { lastReason = 'budget'; continue; }
          const local = target.kind === 'local' ? this.budget.local(ctx.signal) : null;
          if (target.kind === 'local' && !local) { reservation.release(); lastReason = 'budget'; continue; }
          let sent = false;
          try {
            await local?.ready;
            // The key is read only now, after the gate, for this backend's own origin.
            const owner = backend.secretOwner;
            const { credential, unavailable } = await this.secrets.credential(owner, backend.origin);
            if (unavailable) { lastReason = 'credential-unavailable'; continue; }
            if (!credential && isJevPreset(entry.preset)) { lastReason = 'credential-required'; continue; }
            if (this.epoch !== epoch) throw new StaleDecision('settings-changed');
            sent = true;
            // 7–9. Breaker, call with bounded retries, validation and the pin: inside the backend.
            result = await backend.evaluate({ model: backend.model, state: gated.state, questions }, { signal: this.linked(ctx.signal), deadlineAt, credential });
            reservation.commit(result.usage?.costUsd ?? null);
          } catch (error) {
            if (error instanceof StaleDecision) throw error;
            const errorClass = s1ErrorClass(error);
            if (!sent || errorClass === 'breaker-open' || errorClass === 'invalid-request' || errorClass === 'context') reservation.release(); else reservation.commit(null);
            if (this.epoch !== epoch) throw new StaleDecision('settings-changed');
            if (ctx.signal.aborted) throw new StaleDecision('aborted');
            if (errorClass === 'bad-request') this.confirmIncompatible(entry, backend, setId, deadlineAt);
            lastReason = (errorClass && REASONS[errorClass]) ?? 'evaluation-unavailable';
            continue;
          } finally {
            // A step that sent nothing (no key, a key for another address) gives its slot back.
            if (!sent) reservation.release();
            local?.release();
          }
          current();
          if (this.epoch !== epoch) throw new StaleDecision('settings-changed');
        } else current();
        // R6: a new resolvedVersion is a new statistics bucket; AUTO for it must qualify again, and no answer of the
        // previous version is served from the cache.
        if (this.versions.has(entry.id) && this.versions.get(entry.id) !== result.resolvedVersion) this.cache.clear();
        this.versions.set(entry.id, result.resolvedVersion);
        if (!cached && use.cacheable && CACHE_TTL_MS[request.useCase] > 0) this.cache.set(cacheKey, { answers: result.answers, resolvedVersion: result.resolvedVersion, modelLabel: result.modelLabel }, CACHE_TTL_MS[request.useCase]);
        return await this.decide(request, ctx, { mode, auditId, started, entry, backend, family, target: target.kind, caps, autoCapable: use.autoCapable, variant: gated.variant, setId, setHash, truncated, notice: gated.notice ?? null, result, cached, state: gated.state, record });
      }
      if (this.epoch !== epoch) throw new StaleDecision('settings-changed');
      record.fields = lastGate;
      return await this.fallback(request, mode, auditId, started, lastReason, record);
    } catch (error) {
      // A decision the caller no longer wants (assertCurrent threw), voided by a settings change, or any other
      // failure: the assistant-off behaviour (R4), and late answers are suppressed.
      const reason: AssistantFallbackReason = error instanceof StaleDecision ? error.message as AssistantFallbackReason : ctx.signal.aborted ? 'aborted' : 'error';
      return await this.fallback(request, mode, auditId, started, reason, record);
    }
  }

  private linked(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.controller.signal]); }

  /** The mode a use case runs in now: `off` while the assistant is off (R8). */
  mode(useCase: AssistantUseCase): AssistantDecision['mode'] {
    const assistant = this.assistant();
    return assistant?.enabled ? assistant.modes[useCase] ?? 'off' : 'off';
  }

  /**
   * Whether `outcome` has qualified for this backend's family and resolved version (§4.3). Used by command review
   * for the VERIFY and deny outcomes, which it composes after the light decision; always false outside Auto.
   */
  async qualifiedFor(useCase: AssistantUseCase, outcome: QualifiedOutcome, backend: AssistantBackendRef | null): Promise<boolean> {
    if (!backend || this.mode(useCase) !== 'auto') return false;
    await this.loadStats();
    return this.stats.qualified({ useCase, outcome, family: backend.family, resolvedVersion: backend.resolvedVersion });
  }

  /**
   * One log record for a decision a deterministic rule made (tier 1 of command review): no model was asked, so it
   * carries no answers, and it is never registered for labels (a rule decision is not a model outcome, R11).
   */
  async recordRule(request: AssistantRequest, outcome: string): Promise<string | null> {
    const mode = this.mode(request.useCase);
    if (mode === 'off') return null;
    const auditId = randomUUID();
    await this.write({ ...this.baseRecord(request, mode, auditId, this.now(), {}), latencyMs: 0, branch: 'rule', outcome }).catch(() => undefined);
    return auditId;
  }

  private confirmIncompatible(entry: AssistantBackendSettings, backend: AnyBackend, setId: QuestionSetId, deadlineAt: number): void {
    void this.incompatibility.confirm(entry.id, setId, async state => {
      const { credential } = await this.secrets.credential(backend.secretOwner, backend.origin);
      return backend.evaluate({ model: backend.model, state, questions: structuredClone(QUESTION_SETS[setId]) as Record<string, S1Question> }, { signal: this.linked(new AbortController().signal), deadlineAt: Math.max(deadlineAt, this.now() + 5_000), credential });
    }).catch(() => false);
  }

  private async decide(request: AssistantRequest, ctx: AskContext, input: {
    mode: AssistantDecision['mode']; auditId: string; started: number; entry: AssistantBackendSettings; backend: AnyBackend; family: BackendFamily; target: AssistantTarget;
    caps: BackendCaps; autoCapable: boolean; variant: AssistantVariant; setId: QuestionSetId; setHash: string; truncated: boolean;
    notice: { cap: DataClass; source: TrustSource } | null;
    result: Pick<S1Result, 'answers' | 'resolvedVersion' | 'modelLabel'> & Partial<S1Result>; cached: boolean; state: Record<string, unknown>; record: Partial<DecisionRecordInput>;
  }): Promise<AssistantDecision> {
    const { entry, backend, family, result } = input;
    // 10. Bands, from CanvasTTY's own numbers.
    const bands: Record<string, Band> = {};
    for (const [id, answer] of Object.entries(result.answers)) bands[id] = bandOf(answer, thresholdFor(input.setId, id, family, result.resolvedVersion).threshold, input.autoCapable);
    const mapped = request.map ? request.map(result.answers, bands, { variant: input.variant, truncated: input.truncated, family, autoCapable: input.autoCapable }) : { outcome: null, qualifiedOutcome: null };
    let qualifiedOutcome = mapped.qualifiedOutcome;
    // R9: the metadata-only variant never relaxes; R3: a relaxing outcome needs a calibrated pinned backend and the full, uncut state.
    if (qualifiedOutcome && RELAXING.has(qualifiedOutcome) && (input.variant !== 'full' || input.truncated || !input.autoCapable)) qualifiedOutcome = null;
    // 11. The mode.
    let enforce = false;
    if (input.mode === 'auto' && qualifiedOutcome) {
      await this.loadStats();
      enforce = this.stats.qualified({ useCase: request.useCase, outcome: qualifiedOutcome, family, resolvedVersion: result.resolvedVersion });
    }
    const ref: AssistantBackendRef = {
      id: entry.id, preset: entry.preset, family, locality: backend.locality, target: input.target, modelLabel: result.modelLabel ?? null, resolvedVersion: result.resolvedVersion,
      pinned: engineUse(input.caps, request.useCase).pinnable && result.resolvedVersion !== null, calibrated: input.caps.calibrated
    };
    const branch = input.mode === 'shadow' ? 'shadow-recorded' : input.mode === 'suggest' ? 'suggest' : 'auto';
    const decision: AssistantDecision = {
      branch, useCase: request.useCase, auditId: input.auditId, mode: input.mode,
      // Shadow returns the assistant-off behaviour: the caller gets nothing to act on or show.
      answers: branch === 'shadow-recorded' ? null : result.answers, bands: branch === 'shadow-recorded' ? null : bands,
      outcome: branch === 'shadow-recorded' ? null : mapped.outcome, qualifiedOutcome: branch === 'shadow-recorded' ? null : qualifiedOutcome, enforce,
      variant: input.variant, backend: ref, truncated: input.truncated, cached: input.cached, fallbackReason: null,
      notice: input.notice ? { backendId: entry.id, ...input.notice } : null
    };
    // 12. One record, registered for the ground-truth join.
    await this.write({
      ...this.baseRecord(request, input.mode, input.auditId, input.started, input.record),
      questionSetHash: input.setHash, stateHash: await this.log.hmac(input.state), stateBytes: Buffer.byteLength(JSON.stringify(input.state)),
      backend: { id: entry.id, preset: entry.preset, family, dialect: backend.dialect, modelLabel: result.modelLabel ?? null, resolvedVersion: result.resolvedVersion, pinned: ref.pinned, calibrated: input.caps.calibrated, T: 1 },
      requestId: result.requestId ?? null, latencyMs: input.cached ? 0 : result.latencyMs ?? this.now() - input.started, attempts: result.attempts ?? 0, cached: input.cached,
      usage: result.usage ?? null, answers: result.answers, vendorConfidence: result.vendorConfidence ?? null, bands, variant: input.variant,
      branch, outcome: mapped.outcome, qualifiedOutcome, fallbackReason: null
    });
    this.shadow.register(input.auditId, { useCase: request.useCase, outcome: mapped.outcome });
    return decision;
  }

  private baseRecord(request: AssistantRequest, mode: AssistantDecision['mode'], auditId: string, started: number, partial: Partial<DecisionRecordInput>): DecisionRecordInput {
    return {
      id: auditId, at: started, useCase: request.useCase, mode, catalogVersion: ASSISTANT_CATALOG_VERSION, questionSetHash: null, stateHash: null, stateBytes: 0,
      fields: partial.fields ?? { sent: [], withheld: [] }, dataCheck: partial.dataCheck ?? null, redactions: partial.redactions ?? 0, backend: null,
      requestId: null, latencyMs: this.now() - started, attempts: 0, cached: false, usage: null, answers: null, vendorConfidence: null, bands: null, variant: null,
      branch: 'fallback', outcome: null, qualifiedOutcome: null, actionClass: request.actionClass ?? null, fallbackReason: null, truncated: partial.truncated ?? false,
      sessionRef: null, summary: request.summary ?? null
    };
  }

  /** R4: the assistant-off behaviour, logged with its reason. */
  private async fallback(request: AssistantRequest, mode: AssistantDecision['mode'], auditId: string, started: number, reason: AssistantFallbackReason, partial: Partial<DecisionRecordInput>): Promise<AssistantDecision> {
    // Nothing is written once the assistant is off again.
    if (this.assistant()?.enabled) await this.write({ ...this.baseRecord(request, mode, auditId, started, partial), fallbackReason: reason }).catch(() => undefined);
    return { ...this.blank(request, mode, 'fallback', reason), truncated: partial.truncated ?? false };
  }

  private async write(input: DecisionRecordInput): Promise<void> {
    const record = decisionRecord(input);
    this.stats.ingest(record);
    try { await this.log.append(record); } catch { /* a log that cannot be written never changes a decision */ }
  }

  private appendLabel(record: LabelRecord): void {
    this.stats.ingest(record);
    void this.log.append(record).catch(() => undefined);
  }

  private loadStats(): Promise<void> {
    // Records already ingested in this run are kept; the log fills in what came before (duplicates are ignored).
    this.statsLoaded ??= this.log.read(this.now() - 400 * 86_400_000).then(records => this.stats.ingestAll(records), () => undefined);
    return this.statsLoaded;
  }

  // -------------------------------------------------------------------------
  // VERIFY: the smart verifier (§2.6)
  // -------------------------------------------------------------------------

  /**
   * The VERIFY band's second reviewer: the same set's questions over the same (gated) state plus any extra fields
   * code adds (referenced files, a bounded diff), never the light tier's answers. In Learning it runs only when the
   * person enabled «Пока учится, также спрашивать умную модель». L13 serves a local Ollama model only, so the
   * state never leaves this computer; anything else returns null (the person decides).
   */
  async verify(request: AssistantRequest, decision: AssistantDecision, ctx: AskContext, extra: Array<AssistantField & { bound?: number }> = []): Promise<Record<string, S1Answer> | null> {
    const assistant = this.assistant();
    if (!assistant?.enabled || decision.mode === 'off' || decision.variant !== 'full' || !this.smart.configured) return null;
    if (decision.mode === 'shadow' && !assistant.shadowAsksSmart) return null;
    const reservation = this.budget.reserve({ useCase: request.useCase, cloud: false, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) });
    if (!reservation) return null;
    try {
      const fields = [...request.fields, ...extra].map(field => {
        if (typeof field.value === 'string' && field.bound !== undefined) return { ...field, value: redactAndBound(field.value, field.bound).text };
        return { ...field, value: redactValue(field.value).value };
      });
      // Local model: D3 in every mode (the §1.4 local rule is proven by the verifier's own probe).
      const gated = gateFields(fields, assistant.dataClassMode, assistant.grant, { kind: 'local' }, false);
      if (gated.variant !== 'full') { reservation.release(); return null; }
      const answer = await this.smart.ask(structuredClone(QUESTION_SETS[request.set]) as Record<string, S1Question>, gated.state, { signal: this.linked(ctx.signal), deadlineAt: this.now() + SMART_DEADLINE_MS });
      reservation.commit(0);
      ctx.assertCurrent();
      return answer.answers;
    } catch {
      reservation.commit(0);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // IPC surface (AssistantApi)
  // -------------------------------------------------------------------------

  private entry(backendId: string): AssistantBackendSettings {
    const entry = this.assistant().backends.find(item => item.id === backendId);
    if (!entry) throw new Error('Unknown assistant backend.');
    return entry;
  }

  async status(): Promise<{ enabled: boolean; backends: AssistantBackendStatus[] }> {
    const assistant = this.assistant();
    await this.capsStore.load();
    const backends: AssistantBackendStatus[] = [];
    for (const entry of assistant.backends) {
      let built: Built;
      try { built = this.backendFor(entry); } catch { continue; }
      const target = this.targetFor(entry, built.backend);
      const level = target.target.kind === 'remote' ? target.target.level : { cap: 'D3' as const, source: 'local' as const };
      const caps = built.backend.caps();
      const breaker = built.breaker.snapshot();
      const owner = built.backend.secretOwner;
      backends.push({
        id: entry.id, preset: entry.preset, enabled: entry.enabled, target: target.kind, level,
        breaker: { state: breaker.state, reason: breaker.reason, retryAt: breaker.retryAt },
        tested: caps.testedAt > 0, calibrated: caps.calibrated, deterministic: caps.deterministic,
        keyConfigured: owner ? (await this.secrets.status(owner).catch(() => ({ configured: false }))).configured : null,
        latencyMs: caps.testedAt > 0 ? caps.latencyMs.p50 : null
      });
    }
    return { enabled: assistant.enabled, backends };
  }

  /** «Проверить»: the synthetic battery on the person's click; the only thing a backend gets before a grant. */
  async check(backendId: string): Promise<AssistantCheckResult> {
    const entry = this.entry(backendId);
    await this.capsStore.load();
    const { backend } = this.backendFor(entry);
    const { credential } = await this.secrets.credential(backend.secretOwner, backend.origin);
    const report = await runBattery(backend, { signal: this.controller.signal, credential, previous: this.capsStore.get(entry) });
    if (report.added) {
      backend.setCaps(report.caps);
      await this.capsStore.set(entry, report.caps);
      this.incompatibility.forget(entry.id);
      if (report.drift === 'changed') this.versions.delete(entry.id);
    }
    this.cache.clear();
    return { backendId, added: report.added, checks: report.checks.map(item => ({ ...item })), requests: report.requests, failure: report.failure,
      latencyMs: report.added ? report.caps.latencyMs.p50 : null, modelLabel: report.modelLabel };
  }

  recheck(backendId: string): void { this.built.get(this.entry(backendId).id)?.breaker.recheck(); }

  /** «верно / неверно» on a visible suggestion: the person's own label. */
  feedback(auditId: string, verdict: 'right' | 'wrong'): boolean {
    if (typeof auditId !== 'string' || (verdict !== 'right' && verdict !== 'wrong')) return false;
    return this.shadow.label(auditId, { label: verdict, source: 'person', agrees: verdict === 'right' });
  }

  /** Labels from use-case ground truth (§4.2): a later signal, the orchestrator's next step, the person's edit. */
  label(auditId: string, label: Parameters<ShadowRecorder['label']>[1]): boolean { return this.shadow.label(auditId, label); }

  async statistics(range: '7d' | '30d'): Promise<AssistantStatsExport> {
    await this.loadStats();
    const to = this.now();
    return this.stats.summary(to - (range === '7d' ? 7 : 30) * 86_400_000, to);
  }

  async clearLog(): Promise<void> {
    await this.log.clear();
    this.stats.clear();
    this.statsLoaded = Promise.resolve();
  }

  async secretStatus(backendId: string): Promise<{ configured: boolean }> {
    const { backend } = this.backendFor(this.entry(backendId));
    return this.secrets.status(backend.secretOwner);
  }

  /**
   * Where the settings page writes this backend's key (write-only, through the plugin's `secrets`): the secret name
   * and the origin the key is bound to. The service reads it only at call time, after the privacy gate. Null for a
   * backend that takes no key (Ollama).
   */
  keySlot(backendId: string): { secret: string; origin: string } | null {
    const { backend } = this.backendFor(this.entry(backendId));
    return backend.secretOwner ? { secret: backend.secretOwner, origin: backend.origin } : null;
  }

  /** A key was written or removed on the settings page: forget cached answers and void pending decisions. */
  keyChanged(): void { this.invalidate(); }
}
