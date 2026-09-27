import { FIELD_BOUNDS, PERSON_ONLY_CLASSES, REVIEW_TABLE_B, type ActionClass, type AssistantMode, type AssistantUseCase, type QualifiedOutcome } from '../shared/catalog.ts';
import type { AssistantBackendRef, AssistantDecision } from '../shared/settings.ts';
import type { ReviewReason } from '../shared/commandReview.ts';
import type { DataClass } from '../shared/settings.ts';
import type { S1Answer } from '../shared/systemOne.ts';
import type { AskContext, AssistantRequest } from '../engine/AssistantEngine.ts';
import type { AssistantField } from '../engine/privacyGate.ts';
import { pOf, reviewOutcome, type ReviewContext, type ReviewFacts, type ReviewResult } from '../engine/bands.ts';
import { factPhrases, riskyFacts, unseeableEffect, type CommandFacts } from './commandFacts.ts';
import type { Tier1Result } from './commandRules.ts';
import type { ReferencedFiles } from './referencedFiles.ts';

/**
 * `command.review` (assistant spec §3.1b) on the L13 engine: tier 1 first (final, no model), then the light tier's
 * nine nouls, then — only when the §3.1b mapping says VERIFY — the smart verifier, which answers the same nouls on
 * its own and, for a command that runs changed scripts or build files, reads them.
 *
 * The one-way rules as this file applies them:
 * - R1: a tier-1 deny or always-ask is final; the model is never asked about it;
 * - R3 / R3-V are the only allow paths (`reviewOutcome`), and a single model never allows alone;
 * - R4: every failure is the assistant-off behaviour — the person answers; nothing falls through to allow;
 * - R7: an allow is always once (the caller answers `allow_once`, never `allow_always`);
 * - R10: Suggest and Learning enforce nothing a model decided.
 */

/** What the use case needs from the engine (AssistantEngine implements it; tests use a fake). */
export interface CommandReviewEngine {
  mode(useCase: AssistantUseCase): AssistantMode;
  ask(request: AssistantRequest, ctx: AskContext): Promise<AssistantDecision>;
  verify(request: AssistantRequest, decision: AssistantDecision, ctx: AskContext, extra?: Array<AssistantField & { bound?: number }>): Promise<Record<string, S1Answer> | null>;
  qualifiedFor(useCase: AssistantUseCase, outcome: QualifiedOutcome, backend: AssistantBackendRef | null): Promise<boolean>;
  recordRule(request: AssistantRequest, outcome: string): Promise<string | null>;
}

export interface CommandReviewInput {
  facts: CommandFacts;
  tier1: Tier1Result;
  /** The person's task for the session, as delivered (redacted and bounded by the engine). */
  personRequest: string | null;
  /** For edit tools: the bounded new content. */
  content: string | null;
  /** The session's disclosure class: every content field carries it (§3.1b State). */
  dataClass: DataClass;
  session: { suspect: boolean; strict: boolean; personOnly: boolean };
  /** Session + working folder: part of the cache key. */
  cacheScope: string;
  /** Reads the files the smart verifier needs (called only on VERIFY). */
  referencedFiles(include: 'required' | 'all'): Promise<ReferencedFiles>;
}

export interface CommandReviewVerdict {
  /** What CanvasTTY answers on its own: `allow` (once), `deny` (once) or nothing (the person). */
  act: 'allow' | 'deny' | null;
  /** The badge shows (Suggest, Auto); Learning shows nothing. */
  show: boolean;
  /** What the review concluded, enforced or not. */
  outcome: 'allow' | 'deny' | 'person';
  by: 'rule' | 'assistant' | null;
  path: 'tier1' | 'R3' | 'R3-V' | null;
  reason: ReviewReason;
  actionClass: ActionClass;
  auditId: string | null;
  /** The §3.1b rule-1 mark: no allow of any kind for the rest of the session. */
  markSuspect: boolean;
  /** An enforced model deny (for the 3 / 20 circuit). */
  modelDenied: boolean;
  /** The light and smart outcome, for the circuit and labels. */
  modelOutcome: ReviewResult['outcome'] | null;
  /** The smart verifier was asked, and whether it received referenced files. */
  smart: { asked: boolean; files: number };
  /** The tier-1 rule that decided, if one did (the hook's deny text names what to do instead). */
  rule?: string | null;
  /** The light tier's model and its `serves_request` probability, for the card strip; null when no model answered. */
  model?: string | null;
  probability?: number | null;
}

const RELAXING_OUTCOMES: readonly QualifiedOutcome[] = ['auto-allow', 'verify-allow', 'auto-deny'];

function reviewFactsOf(facts: CommandFacts, tier1: Tier1Result): ReviewFacts {
  return {
    actionClass: facts.actionClass,
    unseeableEffect: unseeableEffect(facts),
    riskyFacts: riskyFacts(facts),
    requestTypedByPerson: facts.requestTypedByPerson,
    tier1: tier1.verdict === 'deny' || tier1.verdict === 'ask' ? tier1.verdict : null
  };
}

/** The summary the log keeps (§5.7): program, subcommand and class; never arguments. */
export function reviewSummary(facts: CommandFacts): string {
  const shape = facts.shape;
  return `${facts.tool} · ${shape.program}${shape.subcommand ? ` ${shape.subcommand}` : ''} (${facts.actionClass})`.slice(0, 80);
}

/** The engine request: content fields carry the session's class; `action.shape` and `facts` are metadata. */
export function reviewRequest(input: CommandReviewInput, map?: AssistantRequest['map']): AssistantRequest {
  const { facts } = input;
  const fields: AssistantRequest['fields'] = [
    { name: 'person_request', value: input.personRequest ?? '', dataClass: input.dataClass, disclosure: 'content', bound: FIELD_BOUNDS.personRequest },
    // The tool name travels with the full state only: the metadata-only variant is `action.shape` and `facts` (§3.1b).
    { name: 'action.tool', value: facts.tool, dataClass: 'D0', disclosure: 'content' }
  ];
  if (facts.command !== null) fields.push({ name: 'action.command', value: facts.command, dataClass: input.dataClass, disclosure: 'content', bound: FIELD_BOUNDS.command });
  else {
    if (facts.path !== null) fields.push({ name: 'action.path', value: facts.path, dataClass: input.dataClass, disclosure: 'content', bound: 500 });
    if (input.content !== null) fields.push({ name: 'action.content', value: input.content, dataClass: input.dataClass, disclosure: 'content', bound: FIELD_BOUNDS.command });
  }
  fields.push({ name: 'action.shape', value: facts.shape, dataClass: 'D0', disclosure: 'metadata' });
  fields.push({ name: 'facts', value: factPhrases(facts), dataClass: 'D0', disclosure: 'metadata' });
  return {
    useCase: 'command.review', set: 'command.review', fields, actionClass: facts.actionClass, summary: reviewSummary(facts), cacheScope: input.cacheScope,
    ...(map ? { map } : {})
  };
}

const reasonOf = (result: ReviewResult, facts: ReviewFacts): ReviewReason => {
  if (result.outcome === 'allow') return result.path === 'R3-V' ? 'both-agree' : 'auto-band';
  if (result.outcome === 'block') return result.reason.includes('second') ? 'smart-deny' : 'model-deny';
  if (result.outcome === 'verify') return 'needs-second';
  if (result.markSuspect) return 'suspect';
  if (/circuit/u.test(result.reason)) return 'circuit';
  if (PERSON_ONLY_CLASSES.includes(facts.actionClass)) return 'person-only';
  if (facts.unseeableEffect) return 'unseeable';
  if (/external|obfuscated/u.test(result.reason)) return 'external';
  if (/does not ask/u.test(result.reason)) return 'not-requested';
  if (/agree/u.test(result.reason)) return 'disagree';
  if (/no complete|metadata/u.test(result.reason)) return 'unavailable';
  return 'risk';
};

/**
 * One review. Never throws: any failure is the person (R4).
 */
export async function askCommandReview(engine: CommandReviewEngine, input: CommandReviewInput, ctx: AskContext): Promise<CommandReviewVerdict> {
  const facts = reviewFactsOf(input.facts, input.tier1);
  const base: CommandReviewVerdict = {
    act: null, show: false, outcome: 'person', by: null, path: null, reason: 'unavailable', actionClass: input.facts.actionClass,
    auditId: null, markSuspect: false, modelDenied: false, modelOutcome: null, smart: { asked: false, files: 0 },
    rule: null, model: null, probability: null
  };
  try {
    const mode = engine.mode('command.review');
    if (mode === 'off') return base;
    const show = mode !== 'shadow';
    base.show = show;

    // Tier 1 (R1): final, before any model.
    if (input.tier1.verdict) {
      const verdict = input.tier1.verdict;
      base.rule = input.tier1.rule;
      const auditId = await engine.recordRule(reviewRequest(input), `tier1-${verdict}`).catch(() => null);
      if (verdict === 'deny') {
        // A deterministic hard deny is not a model outcome: it acts in every mode while review is on, Learning included.
        return { ...base, show: true, auditId, outcome: 'deny', by: 'rule', path: 'tier1', reason: 'rule-deny', act: 'deny' };
      }
      if (verdict === 'ask') return { ...base, auditId, outcome: 'person', by: 'rule', path: 'tier1', reason: 'rule-ask' };
      // A tier-1 allow acts only in Auto, never for a suspect or person-only session.
      const allowed = mode === 'auto' && !input.session.suspect && !input.session.personOnly;
      return { ...base, auditId, outcome: 'allow', by: 'rule', path: 'tier1', reason: 'rule-allow', act: allowed ? 'allow' : null };
    }

    // After the denial circuit or a text addressed to a reviewer, nothing is allowed for the session: no model is asked.
    if (input.session.personOnly) return { ...base, reason: 'circuit' };
    if (input.session.suspect) return { ...base, reason: 'suspect' };

    // The light tier. The mapping gives the outcome that would act once qualified (for the log and promotion).
    const map: AssistantRequest['map'] = (answers, _bands, meta) => {
      const probe = reviewOutcome(facts, answers, {
        mode: 'auto', qualified: () => true, family: meta.family, calibrated: meta.autoCapable ? 'vendor' : 'uncalibrated', pinned: meta.autoCapable,
        variant: meta.variant, truncated: meta.truncated, session: input.session
      });
      const qualifiedOutcome: QualifiedOutcome | null = probe.outcome === 'allow' ? 'auto-allow' : probe.outcome === 'verify' ? 'verify-allow' : probe.outcome === 'block' ? 'auto-deny' : null;
      return { outcome: probe.outcome, qualifiedOutcome };
    };
    const request = reviewRequest(input, map);
    const decision = await engine.ask(request, ctx);
    base.auditId = decision.auditId;
    base.model = decision.backend?.modelLabel ?? null;
    base.probability = decision.answers ? pOf(decision.answers, 'serves_request') ?? null : null;
    if (decision.branch === 'shadow-recorded') return { ...base, show: false, reason: 'learning' };
    if (decision.branch !== 'suggest' && decision.branch !== 'auto' || !decision.answers || !decision.backend) return base;

    const qualified = new Map<QualifiedOutcome, boolean>();
    for (const outcome of RELAXING_OUTCOMES) qualified.set(outcome, mode === 'auto' ? await engine.qualifiedFor('command.review', outcome, decision.backend).catch(() => false) : false);
    const rctx: ReviewContext = {
      mode, qualified: outcome => qualified.get(outcome) === true, family: decision.backend.family,
      calibrated: decision.backend.calibrated, pinned: decision.backend.pinned, variant: decision.variant, truncated: decision.truncated || input.facts.truncated,
      session: input.session
    };
    let result = reviewOutcome(facts, decision.answers, rctx);
    const smart = { asked: false, files: 0 };
    const finish = (outcome: ReviewResult, used: ReviewFacts): CommandReviewVerdict => {
      const act = outcome.enforce && outcome.outcome === 'allow' ? 'allow' : outcome.enforce && outcome.outcome === 'block' ? 'deny' : null;
      return {
        ...base, act, smart,
        outcome: outcome.outcome === 'allow' ? 'allow' : outcome.outcome === 'block' ? 'deny' : 'person',
        by: act ? 'assistant' : null, path: outcome.outcome === 'allow' ? outcome.path ?? null : null, reason: reasonOf(outcome, used),
        markSuspect: outcome.markSuspect === true, modelDenied: act === 'deny', modelOutcome: outcome.outcome
      };
    };
    if (result.outcome === 'verify') {
      // The smart verifier reads what the light tier could not see: the files a changed script or build step runs
      // always, and the scripts of an unchanged command when the light tier says the effect is hidden.
      const row = REVIEW_TABLE_B[input.facts.actionClass];
      const hidden = (pOf(decision.answers, 'effect_hidden') ?? 1) >= (row?.rMax ?? 0.2);
      const mustRead = input.facts.runsChangedScript || input.facts.buildScriptsModified === true;
      let extra: Array<AssistantField & { bound?: number }> = [];
      if (mustRead || hidden) {
        const files = await input.referencedFiles(mustRead && !hidden ? 'required' : 'all');
        // What it must read but cannot (too long, unreadable, too many): nobody can see what runs.
        if (mustRead && (!files.complete || !files.files.length)) return finish({ outcome: 'person', enforce: false, reason: 'its effect cannot be seen' }, { ...facts, unseeableEffect: true });
        if (files.files.length) extra = [{ name: 'referenced_files', value: files.files, dataClass: input.dataClass, disclosure: 'content' }];
        smart.files = files.files.length;
      }
      smart.asked = true;
      const smartAnswers = await engine.verify(request, decision, ctx, extra).catch(() => null);
      result = smartAnswers ? reviewOutcome(facts, decision.answers, rctx, smartAnswers) : { outcome: 'person', enforce: false, reason: 'no complete smart answer' };
    }
    return finish(result, facts);
  } catch {
    return base;
  }
}
