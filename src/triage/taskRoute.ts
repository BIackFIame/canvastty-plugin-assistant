import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FIELD_BOUNDS, ROUTE_TAUS, type QualifiedOutcome } from '../shared/catalog.ts';
import type { AssistantDecision, DataClass } from '../shared/settings.ts';
import type { AskContext, AssistantRequest } from '../engine/AssistantEngine.ts';
import { readTriage, type Triage } from './triage.ts';

/**
 * `task.route` (assistant spec §3.1a): one request of ten questions about the task text. The state is the task text only (trimmed, redacted, at most 2,000 characters): never the candidates,
 * paths, accounts or any other code fact. There is no metadata-only variant: with no text there is nothing to
 * classify, and the fallback is the rules path.
 */

export interface TaskRouteAssistant { ask(request: AssistantRequest, ctx: AskContext): Promise<AssistantDecision> }

export interface TaskRouteResult {
  decision: AssistantDecision;
  /** The answers as the policy reads them; kept for Learning too (never shown or acted on there). */
  triage: Triage | null;
}

/** Whether the answers give the policy anything to act on in Auto: a category or difficulty in its band, or a tightening. */
function actionable(triage: Triage): boolean {
  return triage.kindBand === 'auto' || triage.difficultyBand === 'auto'
    || [triage.destructive, triage.networkPublish, triage.secrets, triage.outsideProject].some(p => p >= ROUTE_TAUS.risk)
    || triage.untrusted >= ROUTE_TAUS.untrusted || triage.parallel >= ROUTE_TAUS.parallel;
}

export async function askTaskRoute(engine: TaskRouteAssistant, input: { task: string; dataClass: DataClass }, ctx: AskContext): Promise<TaskRouteResult> {
  const captured: { triage: Triage | null } = { triage: null };
  const request: AssistantRequest = {
    useCase: 'task.route', set: 'task.route',
    fields: [{ name: 'task', value: input.task.trim(), dataClass: input.dataClass, disclosure: 'content', bound: FIELD_BOUNDS.task }],
    summary: 'task triage',
    map: (answers, bands) => {
      const triage = captured.triage = readTriage(answers, bands);
      const qualifiedOutcome: QualifiedOutcome | null = actionable(triage) ? 'default' : null;
      return { outcome: `${triage.category}:${triage.difficulty}`, qualifiedOutcome };
    }
  };
  const decision = await engine.ask(request, ctx);
  return { decision, triage: decision.fallbackReason ? null : captured.triage };
}

// ---------------------------------------------------------------------------
// Code facts (never sent)
// ---------------------------------------------------------------------------

/** The nearest `.git` (a directory or a worktree's file) at or above `cwd`, bounded. */
export function isGitRepository(cwd: string): boolean {
  let current = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    try { if (existsSync(join(current, '.git'))) return true; } catch { return false; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

const PATH_TOKEN = /(?:^|[\s"'`(\[<])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8}|(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?)(?=$|[\s"'`)\]>,.:;!?])/gu;

/** How many distinct paths named in the task exist under `cwd` (a count only; nothing outside cwd is looked at). */
export function mentionedExistingPaths(task: string, cwd: string): number {
  const root = resolve(cwd);
  const seen = new Set<string>();
  let found = 0, checked = 0;
  for (const match of task.slice(0, FIELD_BOUNDS.task * 4).matchAll(PATH_TOKEN)) {
    const token = match[1]!.replace(/\/$/u, '');
    if (!token || isAbsolute(token) || seen.has(token)) continue;
    seen.add(token);
    if (++checked > 64) break;
    const target = resolve(root, token), rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    try { statSync(target); found++; } catch { /* not there */ }
  }
  return found;
}
