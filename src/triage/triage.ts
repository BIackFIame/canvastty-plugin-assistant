import { ROUTE_TAUS, type Band } from '../shared/catalog.ts';
import type { S1Answer } from '../shared/systemOne.ts';

/**
 * The deterministic policy of `task.route` (assistant spec §3.1a), ported from the chain's routingPolicy. The
 * assistant only answers questions about the task text; this code turns the answers into a category, a
 * difficulty, an isolation advice and a review strictness. Explicit values from the person always win, and every
 * model-derived step only tightens (R2): stronger isolation, strict review, "needs a person".
 *
 * Not ported: ranking among accounts and routes (rules, economics, headroom). That belongs to an accounts plugin;
 * here the advice names the kind of model only ("strong" for design-level work).
 */

export type DecisionCategory = 'code' | 'review' | 'research' | 'writing' | 'general';
export type DecisionDifficulty = 'simple' | 'normal' | 'hard';
export type Isolation = 'direct' | 'worktree' | 'container';

/** The answers as the policy reads them. A missing noul reads as 0: nothing tightens on an answer that is absent. */
export interface Triage {
  kind: string | null;
  kindBand: Band | null;
  /** In the auto band only; `general` below it, so rules keyed on a category never fire on an uncertain triage. */
  category: DecisionCategory;
  /** In the auto band only; `normal` below it. */
  difficulty: DecisionDifficulty;
  difficultyBand: Band | null;
  /** Probability of the top difficulty level (design decisions). */
  p3: number;
  /** In the auto band only. */
  scope: string | null;
  destructive: number; outsideProject: number; networkPublish: number; secrets: number;
  untrusted: number; parallel: number; underspecified: number;
}

const CATEGORY: Readonly<Record<string, DecisionCategory>> = {
  code_change: 'code', debug: 'code', review: 'review', research: 'research', writing: 'writing', operations: 'general', other: 'general', unclear: 'general'
};

function p(answers: Readonly<Record<string, S1Answer>>, id: string): number {
  const answer = answers[id];
  return answer?.type === 'noul' && Number.isFinite(answer.p) ? answer.p : 0;
}

/** Steps 1 and 2: category and difficulty, each only in its auto band. */
export function readTriage(answers: Readonly<Record<string, S1Answer>>, bands: Readonly<Record<string, Band>>): Triage {
  const kind = answers.kind?.type === 'choice' ? answers.kind.choice : null;
  const kindBand = bands.kind ?? null;
  const category = kind !== null && kindBand === 'auto' ? CATEGORY[kind] ?? 'general' : 'general';
  const score = answers.difficulty?.type === 'score' ? answers.difficulty : null;
  const difficultyBand = bands.difficulty ?? null;
  const p3 = score && score.probabilities.length === 4 ? score.probabilities[3] ?? 0 : 0;
  let difficulty: DecisionDifficulty = 'normal';
  if (score && difficultyBand === 'auto') {
    if (score.expectation <= ROUTE_TAUS.simpleExpectation) difficulty = 'simple';
    else if (score.expectation >= ROUTE_TAUS.hardExpectation || p3 >= ROUTE_TAUS.strong) difficulty = 'hard';
  }
  const scope = answers.scope?.type === 'choice' && bands.scope === 'auto' ? answers.scope.choice : null;
  return {
    kind, kindBand, category, difficulty, difficultyBand, p3, scope,
    destructive: p(answers, 'destructive'), outsideProject: p(answers, 'outside_project'), networkPublish: p(answers, 'network_publish'), secrets: p(answers, 'secrets'),
    untrusted: p(answers, 'untrusted_input'), parallel: p(answers, 'parallelizable'), underspecified: p(answers, 'underspecified')
  };
}

export type AdviceReason = 'untrusted' | 'destructive' | 'multi-file' | 'parallel' | 'paths' | 'risk' | 'hard' | 'simple' | 'strong';

export interface Advice {
  category: DecisionCategory;
  difficulty: DecisionDifficulty;
  /** Only tightens the explicit isolation; `container` when the task runs outside code, else `worktree` on a git repo. */
  isolation: Isolation;
  /** Any risk noul at τ_risk: only read-only commands may be allowed without the person (§3.1a step 7). */
  reviewStrict: boolean;
  /** Design-level work: prefer the strongest model the person has. */
  strongModel: boolean;
  suggestOrchestrator: boolean;
  underspecified: boolean;
  /** In the order they were triggered. */
  reasons: AdviceReason[];
}

export interface AdviceInput {
  /** Values the person set; they always win. */
  explicit: { difficulty?: DecisionDifficulty; isolation?: Isolation };
  isGitRepo: boolean;
  /** Paths named in the task that exist under cwd (a count only). */
  mentionedExistingPaths: number;
}

const ISOLATION_ORDER: readonly Isolation[] = ['direct', 'worktree', 'container'];
/** The stronger of the two; an explicit choice is never weakened (R2). */
export function tightenIsolation(base: Isolation, suggested: Isolation | null | undefined): Isolation {
  if (!suggested || !ISOLATION_ORDER.includes(suggested)) return base;
  return ISOLATION_ORDER.indexOf(suggested) > ISOLATION_ORDER.indexOf(base) ? suggested : base;
}

/** Steps 5–9 without route ranking. */
export function advise(triage: Triage, input: AdviceInput): Advice {
  const reasons: AdviceReason[] = [];
  const difficulty = input.explicit.difficulty ?? triage.difficulty;
  let isolation: Isolation = input.explicit.isolation ?? 'direct';
  // 6. Isolation, only tightening.
  if (triage.untrusted >= ROUTE_TAUS.untrusted) { isolation = tightenIsolation(isolation, 'container'); reasons.push('untrusted'); }
  if (input.isGitRepo) {
    const worktree: AdviceReason[] = [];
    if (triage.destructive >= ROUTE_TAUS.risk) worktree.push('destructive');
    if ((triage.scope === 'one_area' || triage.scope === 'cross_cutting') && difficulty !== 'simple') worktree.push('multi-file');
    if (triage.parallel >= ROUTE_TAUS.parallel && difficulty !== 'simple') worktree.push('parallel');
    if (input.mentionedExistingPaths >= 3) worktree.push('paths');
    if (worktree.length) { isolation = tightenIsolation(isolation, 'worktree'); reasons.push(...worktree); }
  }
  // 7. Review strictness: any risk noul at τ_risk. The launch profile is never changed.
  const reviewStrict = [triage.destructive, triage.networkPublish, triage.secrets, triage.outsideProject].some(value => value >= ROUTE_TAUS.risk);
  if (reviewStrict && !reasons.includes('destructive')) reasons.push('risk');
  const strongModel = input.explicit.difficulty === undefined && triage.p3 >= ROUTE_TAUS.strong;
  if (strongModel) reasons.push('strong');
  if (input.explicit.difficulty === undefined && difficulty === 'hard') reasons.push('hard');
  if (input.explicit.difficulty === undefined && difficulty === 'simple') reasons.push('simple');
  return {
    category: triage.category, difficulty, isolation, reviewStrict, strongModel,
    // 8 and 9: hints only.
    suggestOrchestrator: triage.parallel >= ROUTE_TAUS.orchestrator && difficulty !== 'simple',
    underspecified: triage.underspecified >= ROUTE_TAUS.underspecified,
    reasons
  };
}
