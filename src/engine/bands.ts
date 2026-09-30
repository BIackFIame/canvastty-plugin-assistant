import {
  CONF_FLOOR, JEV_BAND_DEFAULTS, PERSON_ONLY_CLASSES, REVIEW_RISK_NOULS, REVIEW_RULES, REVIEW_TABLE_B, SCORE_ADJACENT_EXCEPTION,
  type ActionClass, type AssistantMode, type Band, type BackendFamily, type BandThresholdDefault, type QualifiedOutcome, type QuestionSetId
} from '../shared/catalog.ts';
import type { AssistantVariant } from '../shared/settings.ts';
import type { S1Answer } from '../shared/systemOne.ts';

/**
 * Bands and the one-way rules (assistant spec §3.2, §3.3). Every number is CanvasTTY's own (top, margin, conf,
 * p from the normalized vector); a backend's `confidence` never decides.
 *
 * The one-way rules as code:
 * - R2: models only tighten (the triage's tightenIsolation; review adds "needs the person", never clears it);
 * - R3 / R3-V are the only allow paths (reviewOutcome); a property test enumerates them;
 * - R4: a missing answer is the assistant-off behaviour, never an allow;
 * - R9: metadata-only answers only tighten;
 * - R10: Suggest enforces nothing, a block included (enforcement).
 */

// ---------------------------------------------------------------------------
// Bands (§3.2)
// ---------------------------------------------------------------------------

/** Fitted thresholds (thresholdFit.ts) keyed `${setId}/${question}/${family}/${resolvedVersion}`. */
export type FittedThresholds = ReadonlyMap<string, BandThresholdDefault>;

/** The threshold for one question: a fitted one first; else Jev's defaults for the `jev` family; else no AUTO band. */
export function thresholdFor(setId: QuestionSetId, question: string, family: BackendFamily, resolvedVersion: string | null, fitted?: FittedThresholds): { threshold: BandThresholdDefault; source: 'default' | 'fitted' } {
  const key = `${setId}/${question}/${family}/${resolvedVersion ?? ''}`;
  const fit = fitted?.get(key);
  if (fit) return { threshold: fit, source: 'fitted' };
  return { threshold: family === 'jev' ? JEV_BAND_DEFAULTS[setId]?.[question] ?? {} : {}, source: 'default' };
}

/** Below TypeSafe's confidence floor (conf < 0.5); a score split between neighbours is exempt (§3.2). */
export function belowFloor(answer: S1Answer): boolean {
  if (answer.type === 'score' && answer.adjacentMass >= SCORE_ADJACENT_EXCEPTION) return false;
  return answer.conf < CONF_FLOOR;
}

/**
 * The band of one answer. AUTO needs a threshold with an AUTO band, a calibrated backend and a calibrated
 * answer (a tournament or JSON-mode answer is a hint only). Below the floor, the next tier (PERSON).
 */
export function bandOf(answer: S1Answer | undefined, threshold: BandThresholdDefault, calibrated: boolean): Band {
  if (!answer || belowFloor(answer)) return 'person';
  const auto = threshold.auto;
  if (auto && calibrated && !answer.uncalibrated) {
    if (answer.type === 'score' && auto.adjacentMass !== undefined && answer.adjacentMass >= auto.adjacentMass) return 'auto';
    if (auto.minTop > 0 && answer.top >= auto.minTop && answer.margin >= auto.minMargin) return 'auto';
  }
  if (threshold.verifyFloor !== undefined && answer.top >= threshold.verifyFloor) return 'verify';
  return 'person';
}

/** A noul's p, or null when the answer is missing or not a noul. */
export function pOf(answers: Readonly<Record<string, S1Answer>> | null | undefined, id: string): number | null {
  const answer = answers?.[id];
  return answer && answer.type === 'noul' ? answer.p : null;
}

// ---------------------------------------------------------------------------
// Mode application (§2.7 step 11, R10)
// ---------------------------------------------------------------------------

/**
 * What a decided outcome may do. Shadow: nothing is shown and the assistant-off path runs. Suggest: shown,
 * enforced never (a block is only a strong recommendation). Auto: enforced only when that outcome qualified.
 */
export function enforcement(mode: AssistantMode, qualified: boolean): { act: boolean; show: boolean } {
  if (mode === 'auto') return { act: qualified, show: true };
  if (mode === 'suggest') return { act: false, show: true };
  return { act: false, show: false };
}

// ---------------------------------------------------------------------------
// Command review (§3.1b code mapping, Table B)
// ---------------------------------------------------------------------------

export interface ReviewFacts {
  actionClass: ActionClass;
  /** A pipe to a shell, eval of generated text, source of an untracked file, running a downloaded or generated file. */
  unseeableEffect: boolean;
  /** Unresolved variables, subshells, network egress, build_scripts_modified, truncated. */
  riskyFacts: boolean;
  /** `person_request` came from the person's own input. */
  requestTypedByPerson: boolean;
  /** A tier-1 deny or always-ask: final, before any model (R1). */
  tier1: 'deny' | 'ask' | null;
}

export interface ReviewContext {
  mode: AssistantMode;
  qualified: (outcome: QualifiedOutcome) => boolean;
  /** Table B holds for Jev's defaults; other families only with fitted thresholds (`tableB` override). */
  family: BackendFamily;
  tableB?: Partial<Record<ActionClass, { tAllow: number; rMax: number } | null>>;
  calibrated: 'vendor' | 'fitted' | 'uncalibrated' | null;
  pinned: boolean;
  variant: AssistantVariant | null;
  truncated: boolean;
  session: { suspect: boolean; strict: boolean; personOnly: boolean };
}

export type ReviewOutcome = 'person' | 'block' | 'allow' | 'verify';
export interface ReviewResult {
  outcome: ReviewOutcome;
  /** true only for an Auto outcome that qualified. `person` and `verify` enforce nothing of their own. */
  enforce: boolean;
  /** The allow path, when the outcome is `allow`: R3 (light tier alone) or R3-V (after VERIFY). */
  path?: 'R3' | 'R3-V';
  /** addresses_reviewer: no allow of any kind for the rest of the session. */
  markSuspect?: boolean;
  reason: string;
}

const person = (reason: string, extra: Partial<ReviewResult> = {}): ReviewResult => ({ outcome: 'person', enforce: false, reason, ...extra });

function reviewAnswers(answers: Readonly<Record<string, S1Answer>> | null, ids: readonly string[]): Record<string, number> | null {
  if (!answers) return null;
  const out: Record<string, number> = {};
  for (const id of ids) { const p = pOf(answers, id); if (p === null) return null; out[id] = p; }
  return out;
}

/**
 * The §3.1b mapping. The first matching rule wins. Anything missing (no light answers, a skipped question, the
 * metadata-only variant) is the person: that is the assistant-off behaviour, so nothing falls through to allow.
 * `smart` are the smart verifier's own answers to the same nouls (it never saw the light ones).
 */
export function reviewOutcome(facts: ReviewFacts, lightAnswers: Readonly<Record<string, S1Answer>> | null, ctx: ReviewContext, smartAnswers?: Readonly<Record<string, S1Answer>> | null): ReviewResult {
  if (facts.tier1) return person(`tier-1 ${facts.tier1} is final`);
  if (ctx.session.personOnly) return person('the denial circuit made this session person-only');
  // R9: the metadata-only variant can only tighten; nothing it says allows.
  if (ctx.variant !== 'full') return person('metadata-only answers only tighten');
  const light = reviewAnswers(lightAnswers, ['serves_request', 'addresses_reviewer', ...REVIEW_RISK_NOULS]);
  if (!light) return person('no complete light answer');
  const serves = light.serves_request!;
  const risks = REVIEW_RISK_NOULS.map(id => light[id]!);
  const personOnlyClass = PERSON_ONLY_CLASSES.includes(facts.actionClass);

  // 1. Suspect.
  if (light.addresses_reviewer! >= REVIEW_RULES.suspect || ctx.session.suspect) return person('text addressed to a reviewer', { markSuspect: true });
  // 2. Block: only a dangerous action nobody asked for.
  if (serves <= REVIEW_RULES.blockServesAtMost && (light.exfiltration! >= REVIEW_RULES.blockExfiltration || light.security_weakening! >= REVIEW_RULES.blockSecurityWeakening || light.destructive! >= REVIEW_RULES.blockDestructive)) {
    const { act } = enforcement(ctx.mode, ctx.qualified('auto-deny'));
    return { outcome: 'block', enforce: act, reason: 'a dangerous action the request does not ask for' };
  }
  // 3. Person.
  if (personOnlyClass) return person('a person-only action class');
  if (facts.unseeableEffect) return person('its effect cannot be seen');
  if (light.external_effect! >= REVIEW_RULES.personAt || light.obfuscated! >= REVIEW_RULES.personAt) return person('an external effect or an obfuscated command');
  if (serves < REVIEW_RULES.personAt) return person('the request does not ask for it');
  if (risks.some(p => p >= REVIEW_RULES.personAt)) return person('a risk signal');

  // 4. Auto allow (R3): the AUTO band of Table B and every structural condition.
  const row = ctx.tableB ? ctx.tableB[facts.actionClass] ?? null : ctx.family === 'jev' ? REVIEW_TABLE_B[facts.actionClass] : null;
  const thresholdsMet = !!row && serves >= row.tAllow && risks.every(p => p < row.rMax);
  // reviewStrict (§3.1a step 7) leaves only read_only; an agent- or orchestrator-authored request auto-allows only read_only.
  const sessionOk = !ctx.session.suspect && (!ctx.session.strict || facts.actionClass === 'read_only');
  const requestOk = facts.actionClass === 'read_only' || facts.requestTypedByPerson;
  const structural = thresholdsMet && !facts.riskyFacts && sessionOk && requestOk;
  const backendOk = !!ctx.calibrated && ctx.calibrated !== 'uncalibrated' && ctx.pinned && !ctx.truncated;
  if (structural && backendOk) {
    const { act } = enforcement(ctx.mode, ctx.qualified('auto-allow'));
    return { outcome: 'allow', enforce: act, path: 'R3', reason: 'the light tier is in its AUTO band' };
  }

  // 5. VERIFY: the smart verifier answers the same nouls on its own.
  if (!smartAnswers) return { outcome: 'verify', enforce: false, reason: 'a second, independent review is needed' };
  const smart = reviewAnswers(smartAnswers, ['serves_request', ...REVIEW_RISK_NOULS]);
  if (!smart) return person('no complete smart answer');
  const smartRisks = REVIEW_RISK_NOULS.map(id => smart[id]!);
  if (smart.serves_request! <= REVIEW_RULES.smartDenyServesAtMost && (smart.exfiltration! >= REVIEW_RULES.smartDenyRisk || smart.security_weakening! >= REVIEW_RULES.smartDenyRisk || smart.destructive! >= REVIEW_RULES.smartDenyRisk)) {
    const { act } = enforcement(ctx.mode, ctx.qualified('auto-deny'));
    return { outcome: 'block', enforce: act, reason: 'the second review recommends a deny' };
  }
  // R3-V: both reviewers agree, independently.
  if (smart.serves_request! >= REVIEW_RULES.smartAllowServes && smartRisks.every(p => p < REVIEW_RULES.smartAllowRiskBelow)
    && serves >= REVIEW_RULES.personAt && risks.every(p => p < REVIEW_RULES.personAt)
    && !facts.unseeableEffect && !personOnlyClass && !ctx.session.suspect && !ctx.session.strict) {
    const { act } = enforcement(ctx.mode, ctx.qualified('verify-allow'));
    return { outcome: 'allow', enforce: act, path: 'R3-V', reason: 'both reviews agree' };
  }
  return person('the reviews do not agree');
}

/**
 * §3.1b rule 6: after 3 model denials in a row, or 20 in a session, the session goes to person-only. At most
 * `maxSessions` sessions are kept (the least recently reviewed goes first), so a session whose close never
 * arrives cannot grow it.
 */
export class ReviewCircuit {
  private readonly sessions = new Map<string, { consecutive: number; total: number }>();
  private readonly maxSessions: number;
  constructor(maxSessions = 512) { this.maxSessions = maxSessions; }
  record(sessionId: string, outcome: ReviewOutcome, enforced: boolean): void {
    const entry = this.sessions.get(sessionId) ?? { consecutive: 0, total: 0 };
    if (outcome === 'block' && enforced) { entry.consecutive++; entry.total++; } else if (outcome !== 'block') entry.consecutive = 0;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
  }
  get size(): number { return this.sessions.size; }
  personOnly(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    return !!entry && (entry.consecutive >= REVIEW_RULES.circuitConsecutive || entry.total >= REVIEW_RULES.circuitPerSession);
  }
  forget(sessionId: string): void { this.sessions.delete(sessionId); }
}
