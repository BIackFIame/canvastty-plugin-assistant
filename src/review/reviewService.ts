import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { REVIEW_LIMITS, type AcpPermissionDetail, type AcpToolKind, type ReviewReason } from '../shared/commandReview.ts';
import type { AssistantSettings, DataClass } from '../shared/settings.ts';
import { ReviewCircuit } from '../engine/bands.ts';
import type { ShadowLabel } from '../engine/ShadowRecorder.ts';
import { askCommandReview, reviewSummary, type CommandReviewEngine, type CommandReviewVerdict } from './commandReview.ts';
import { computeCommandFacts, defaultGit, factPhrases, pathContext, realish, SessionWriteTracker, commandFromArgv, type CommandFacts, type GitRunner, type ReviewAction } from './commandFacts.ts';
import { tier1, type TIER1_DENY_RULES } from './commandRules.ts';
import { collectReferencedFiles } from './referencedFiles.ts';

/**
 * Command review as a CanvasTTY decision service (EP-5 `canvastty.decide`, event `pre-tool`), ported from the chain's
 * CommandReviewService and HookReview. CanvasTTY's base protection runs first and its deny is final; this service
 * then answers deny, ask, allow or nothing:
 *
 * - Off (the assistant or `command.review`): nothing, no work at all (R8).
 * - A tier-1 hard deny (elevation, pipe-to-shell, writes outside…): deny, in every mode while review is on (R1).
 * - Learning: nothing; the review runs on its own afterwards, for the log.
 * - Suggest: nothing is enforced (R10); the review runs afterwards and its suggestion shows as a card badge.
 * - Auto: the ladder runs inside the hook's budget — tier 1, the light model, and on VERIFY the smart model, which
 *   reads the scripts or diff the command runs. An enforced allow answers `allow` (CanvasTTY applies it only when
 *   the person let this plugin allow, and only for the calls it saw whole); an enforced deny answers `deny`; everything
 *   else, failures included, answers `ask`: the person decides. Nothing ever falls through to allow (R4).
 * - An agent that cannot put an ask in front of the person (`canAsk: false`: every CLI but Claude Code) gets a deny with
 *   the same reason and what to do instead. Only a review that could not finish in a card whose own profile still asks
 *   the person (normal, plan) answers nothing there, so the CLI's own prompt decides instead of blocking all work.
 *
 * A script the agent wrote in this session (or one not committed) is never allowed by the small model alone: only
 * when the larger second reviewer, which reads its text, agrees (R3-V), or by the person.
 */

/** What CanvasTTY sends (`canvastty.decide`). */
export interface DecideRequest {
  event: 'pre-tool';
  sessionId: string;
  provider: string;
  role: 'agent' | 'orchestrator' | 'subagent';
  cwd: string;
  agentCwd: string | null;
  tool: { name: string; kind: 'shell' | 'edit' | 'other'; command: string | null; paths: string[] };
  input: unknown;
  truncated: boolean;
  /** The card's launch profile (auto, normal, acceptEdits, plan, yolo); null or absent from an older CanvasTTY. */
  profile?: string | null;
  /** The agent can put an "ask" in front of the person (only Claude Code); absent from an older CanvasTTY: it can. */
  canAsk?: boolean;
}

/** Profiles whose CLI still asks the person before it runs a command on its own. */
const ASKING_PROFILES: ReadonlySet<string> = new Set(['normal', 'plan']);

export type DecideAnswer = { verdict: 'deny' | 'ask' | 'allow'; reason: string } | null;

/** One line of the settings page's «Последние проверки»: code-authored, no command text, no path. */
export interface RecentReview {
  at: number; session: string; summary: string; mode: string;
  outcome: CommandReviewVerdict['outcome']; act: 'allow' | 'deny' | 'ask' | null; tier: 'rule' | 'light' | 'smart' | null;
  reason: ReviewReason; model: string | null; auditId: string | null; label: 'right' | 'wrong' | null;
}

export interface ReviewServiceOptions {
  engine: CommandReviewEngine & { label?(auditId: string, label: ShadowLabel): boolean };
  settings(): AssistantSettings;
  /** null: no git at all (tests); default: read-only git with hooks and helpers off. */
  git?: GitRunner | null;
  home?: string;
  /** Suggest mode: shows the suggestion on the card (a badge); never enforced. */
  suggest?(sessionId: string, verdict: CommandReviewVerdict, summary: string): void;
  now?: () => number;
}

interface SessionState {
  suspect: boolean;
  /** The person's task for the card, typed in the launcher's Assistant field. */
  personRequest: { text: string; byPerson: boolean } | null;
  dataClass: DataClass | null;
  /** From the launch triage (§3.1a step 7); `pending` while it runs, which counts as strict. */
  strict: boolean | 'pending';
}

const MAX_SESSIONS = 512;
const MAX_RECENT = 40;
/** Room kept for the hook's own round trip: the answer must reach CanvasTTY before its deadline. */
const MARGIN_MS = 1_500;

/** Tier-1 hard denies, told to the model as what to do instead (the reason reaches the model). */
const DENY_MESSAGES: Readonly<Record<typeof TIER1_DENY_RULES[number], string>> = {
  elevation: 'it asks for administrator rights (sudo, doas, runas). Do the work without elevation; if the task truly needs it, stop and ask the person to run that step',
  'pipe-to-shell': 'it pipes downloaded or generated text straight into a shell or interpreter. Download the file first, show what it contains, and ask the person before running it',
  'download-exec': 'it downloads code and runs it in one step. Download the file first, show what it contains, and ask the person before running it',
  'delete-outside': 'it deletes files outside the project folder (or the folder itself). Delete only inside the project; if something elsewhere must go, ask the person',
  'write-outside': 'it writes outside the project folder. Keep changes inside the project; if a file elsewhere must change, ask the person',
  disk: 'it erases, formats or writes a disk directly. Do not do this; ask the person if disk changes are really needed',
  'fork-bomb': 'it would exhaust the computer\'s processes. Do not run it'
};
const TEMP_WRITE_MESSAGE = 'it writes to the temporary folder (/tmp or $TMPDIR), which is outside the project folder. Make a scratch folder inside the project instead (for example ./tmp, added to .gitignore if needed); if a file elsewhere must change, ask the person';
const MODEL_DENY_MESSAGE = 'command review declined it: it looks like a risky action the task did not ask for. If it is needed, stop and ask the person';

/** Why the person is asked, in the words the CLI shows next to its prompt. */
const ASK_MESSAGES: Readonly<Partial<Record<ReviewReason, string>>> = {
  'rule-ask': 'a force push, history rewrite, unresolved recursive delete, power or kill-all command needs the person',
  'person-only': 'this kind of action (publishing, pushing, deleting, system or credential changes) is the person\'s to allow',
  unseeable: 'what it runs cannot be seen in the command itself',
  risk: 'the review found a risk signal',
  'not-requested': 'the task given to this card does not ask for it',
  external: 'it has an effect on another computer or is hard to read',
  suspect: 'the command talks to the reviewer; nothing is allowed without the person for the rest of this card',
  circuit: 'several commands of this card were declined; the person decides from now on',
  disagree: 'the two reviews do not agree',
  'needs-second': 'a second review is needed',
  unavailable: 'the Assistant could not review it in time',
  'no-kind': 'this tool cannot be reviewed',
  'model-deny': 'the review recommends not running it',
  'smart-deny': 'the second review recommends not running it',
  'auto-band': 'the review would allow it, but that outcome has not qualified yet',
  'both-agree': 'both reviews would allow it, but that outcome has not qualified yet',
  'rule-allow': 'a read-only command'
};

/** Tool names of the CLIs' hooks, as the tool kinds the rules know. Anything else goes to the person. */
const HOOK_TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  Bash: 'execute', bash: 'execute', run_shell_command: 'execute', shell: 'execute', local_shell: 'execute', exec_command: 'execute',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', write_file: 'edit', edit: 'edit', write: 'edit', replace: 'edit', apply_patch: 'edit', patch: 'edit',
  Read: 'read', read_file: 'read', read_many_files: 'read', NotebookRead: 'read', LS: 'read', list_directory: 'read', read: 'read', list: 'read',
  Glob: 'search', Grep: 'search', glob: 'search', grep: 'search', search_file_content: 'search',
  WebFetch: 'fetch', web_fetch: 'fetch', webfetch: 'fetch'
};

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
const text = (value: unknown, max = 65_536): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** The files an `apply_patch` envelope touches. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu)) {
    const path = (match[1] ?? match[2] ?? '').trim();
    if (path && path.length <= REVIEW_LIMITS.pathChars) paths.push(path);
    if (paths.length >= REVIEW_LIMITS.locations) break;
  }
  return paths;
}

/**
 * A CLI hook's tool call as the private detail the review reads. The input is normalized per tool so that only a
 * shell tool can ever carry a command: an unknown or MCP tool has no kind and no input, and goes to the person.
 * Cut input keeps no parsed value (never allowed, R3).
 */
export function detailFromHook(toolName: string, toolInput: unknown, truncated: boolean): AcpPermissionDetail {
  const kind = Object.hasOwn(HOOK_TOOL_KINDS, toolName) ? HOOK_TOOL_KINDS[toolName]! : null;
  const raw = record(toolInput);
  let rawInput: unknown = null;
  let locations: string[] = [];
  if (!truncated && raw && kind) {
    const pathOf = (): string | null => text(raw.file_path, REVIEW_LIMITS.pathChars) ?? text(raw.filePath, REVIEW_LIMITS.pathChars) ?? text(raw.path, REVIEW_LIMITS.pathChars) ?? text(raw.notebook_path, REVIEW_LIMITS.pathChars) ?? text(raw.absolute_path, REVIEW_LIMITS.pathChars);
    if (kind === 'execute') {
      rawInput = { command: raw.command, ...(raw.cwd !== undefined ? { cwd: raw.cwd } : raw.workdir !== undefined ? { workdir: raw.workdir } : raw.directory !== undefined ? { cwd: raw.directory } : {}) };
    } else if (toolName === 'apply_patch' || toolName === 'patch') {
      const patch = typeof raw.command === 'string' ? raw.command : typeof raw.patch === 'string' ? raw.patch : typeof raw.patchText === 'string' ? raw.patchText : typeof raw.input === 'string' ? raw.input : '';
      locations = patchPaths(patch);
      rawInput = { patch };
    } else if (kind === 'edit') {
      const pieces: string[] = [];
      for (const key of ['content', 'new_string', 'newString', 'new_source', 'newText']) if (typeof raw[key] === 'string') pieces.push(raw[key] as string);
      if (Array.isArray(raw.edits)) for (const edit of raw.edits.slice(0, 64)) { const value = record(edit)?.new_string; if (typeof value === 'string') pieces.push(value); }
      const path = pathOf();
      rawInput = { ...(path ? { file_path: path } : {}), ...(pieces.length ? { content: pieces.join('\n') } : {}) };
    } else if (kind === 'fetch') {
      rawInput = { url: raw.url };
    } else {
      const path = pathOf();
      rawInput = path ? { path } : {};
    }
  }
  return { toolCallId: null, kind, title: null, rawInput, rawInputText: null, rawInputTruncated: truncated, locations, diffs: [], contentTruncated: false };
}

/** What a tool call asks for, read from the private detail. */
export function actionFromDetail(detail: AcpPermissionDetail): ReviewAction {
  const raw = record(detail.rawInput);
  let command: string | null = null;
  let truncated = detail.rawInputTruncated || detail.contentTruncated;
  const candidate = raw ? raw.command ?? raw.cmd ?? raw.commandLine ?? raw.command_line ?? raw.script : typeof detail.rawInput === 'string' ? detail.rawInput : undefined;
  if (typeof candidate === 'string') command = candidate;
  else if (Array.isArray(candidate) && candidate.length && candidate.every(item => typeof item === 'string')) command = commandFromArgv(candidate as string[]);
  const execute = detail.kind === 'execute' || detail.kind === null && command !== null;
  if (execute && detail.rawInputTruncated) { command = null; truncated = true; }
  const paths = new Set<string>(detail.locations);
  for (const key of ['file_path', 'filePath', 'path', 'abs_path', 'absolute_path', 'target_file', 'notebook_path', 'source', 'destination', 'old_path', 'new_path', 'from', 'to']) {
    const value = text(raw?.[key], REVIEW_LIMITS.pathChars);
    if (value) paths.add(value);
  }
  const contents = detail.diffs.map(diff => diff.newText);
  for (const key of ['content', 'new_string', 'newText', 'new_str', 'contents', 'text', 'patch', 'diff']) {
    const value = raw?.[key];
    if (typeof value === 'string') contents.push(value);
  }
  const content = contents.length ? contents.join('\n').slice(0, REVIEW_LIMITS.contentChars) : null;
  if (contents.join('\n').length > REVIEW_LIMITS.contentChars) truncated = true;
  const cwdValue = text(raw?.cwd, REVIEW_LIMITS.pathChars) ?? text(raw?.workdir, REVIEW_LIMITS.pathChars) ?? text(raw?.working_directory, REVIEW_LIMITS.pathChars);
  return {
    kind: detail.kind, command: execute ? command : null, commandCwd: cwdValue, paths: [...paths].slice(0, REVIEW_LIMITS.locations),
    content: execute ? null : content, inputTruncated: truncated, url: text(raw?.url, 4_096)
  };
}

/** The temporary folders of this computer, resolved (macOS: /tmp is /private/tmp; $TMPDIR is under /var/folders). */
function temporaryRoots(): string[] {
  const roots = new Set<string>();
  for (const path of ['/tmp', '/var/tmp', tmpdir(), process.env.TEMP ?? '', process.env.TMP ?? '']) {
    if (!path) continue;
    roots.add(path);
    try { roots.add(realish(path)); } catch { /* keep the plain path */ }
  }
  return [...roots];
}

const within = (path: string, root: string): boolean => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };

/** Every target the command writes outside the project is inside a temporary folder. */
function writesOnlyToTemp(facts: CommandFacts, cwd: string): boolean {
  if (facts.deletesOutside) return false;
  let rootReal: string;
  try { rootReal = pathContext(cwd).rootReal; } catch { return false; }
  const outside = facts.writeTargets.filter(path => !within(path, rootReal));
  if (!outside.length) return false;
  const roots = temporaryRoots();
  return outside.every(path => roots.some(root => within(path, root)));
}

function tierOf(verdict: CommandReviewVerdict): RecentReview['tier'] {
  if (verdict.by === 'rule' || verdict.path === 'tier1') return 'rule';
  if (verdict.smart.asked) return 'smart';
  return verdict.model ? 'light' : null;
}

export class ReviewService {
  readonly tracker = new SessionWriteTracker();
  private readonly options: ReviewServiceOptions;
  private readonly circuit = new ReviewCircuit();
  private readonly sessions = new Map<string, SessionState>();
  private readonly recentReviews: RecentReview[] = [];
  private readonly now: () => number;

  constructor(options: ReviewServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { suspect: false, personRequest: null, dataClass: null, strict: false };
      this.sessions.set(sessionId, state);
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return state;
  }

  /** What the person set in the launcher for this card: its task (typed by the person) and its data class. */
  noteLaunch(sessionId: string, launch: { task: string | null; dataClass: DataClass | null; triage: boolean }): void {
    const state = this.state(sessionId);
    state.personRequest = launch.task ? { text: launch.task.slice(0, 16_384), byPerson: true } : null;
    state.dataClass = launch.dataClass;
    state.strict = launch.triage ? 'pending' : false;
  }

  /** The launch triage finished: its strictness (a failed triage is not strict; the global setting still applies). */
  noteTriage(sessionId: string, strict: boolean): void { this.state(sessionId).strict = strict; }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.tracker.forget(sessionId);
    this.circuit.forget(sessionId);
  }

  recent(): RecentReview[] { return structuredClone(this.recentReviews); }

  /** «верно / неверно» on the settings page: the person's own label (R11), once per review. */
  feedback(auditId: string, verdict: 'right' | 'wrong'): boolean {
    const entry = this.recentReviews.find(item => item.auditId === auditId);
    if (!entry || entry.label || entry.tier === 'rule' || (verdict !== 'right' && verdict !== 'wrong')) return false;
    const label = verdict === 'right' ? entry.outcome : entry.outcome === 'allow' ? 'deny' : 'allow';
    let stored = false;
    try { stored = this.options.engine.label?.(auditId, { label, source: 'person', agrees: verdict === 'right' }) === true; } catch { stored = false; }
    if (stored) entry.label = verdict;
    return stored;
  }

  private strict(state: SessionState): boolean {
    try { if (this.options.settings().reviewStrictness === 'strict') return true; } catch { return true; }
    return state.strict !== false;
  }

  /** Never rejects. `budgetMs` is what CanvasTTY waits for this answer. */
  async decide(request: DecideRequest, budgetMs: number): Promise<DecideAnswer> {
    let mode: string;
    try {
      if (!this.options.settings().enabled) return null;
      mode = this.options.engine.mode('command.review');
    } catch { return null; }
    if (mode === 'off' || request.event !== 'pre-tool') return null;
    const deadline = this.now() + Math.max(0, budgetMs - MARGIN_MS);
    const signal = AbortSignal.timeout(Math.max(1, deadline - this.now()));
    const ask = (reason: ReviewReason): DecideAnswer => {
      const why = ASK_MESSAGES[reason] ?? ASK_MESSAGES.unavailable!;
      if (request.canAsk !== false) return { verdict: 'ask', reason: `CanvasTTY Assistant: ${why}` };
      // The agent cannot ask the person from here: CanvasTTY would turn an ask into a deny anyway. Say what to do.
      if (reason === 'unavailable' && typeof request.profile === 'string' && ASKING_PROFILES.has(request.profile)) return null;
      return { verdict: 'deny', reason: `CanvasTTY Assistant: ${why}. This agent cannot ask the person from here, so it was not run: tell the person what you want to run and why, and let them decide` };
    };
    const act = (answer: DecideAnswer): RecentReview['act'] => answer?.verdict ?? null;
    try {
      const state = this.state(request.sessionId);
      const action = actionFromDetail(detailFromHook(request.tool.name, request.input, request.truncated));
      if (!action.commandCwd && request.agentCwd) action.commandCwd = request.agentCwd;
      const git = this.options.git === null ? null : this.options.git ?? defaultGit;
      const home = this.options.home ?? homedir();
      const facts = await computeCommandFacts({
        action, root: request.cwd, sessionId: request.sessionId, requestTypedByPerson: state.personRequest?.byPerson === true,
        tracker: this.tracker, git, home, agentRoots: [join(home, '.claude')],
        signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_LIMITS.factsMs)])
      });
      const rules = tier1(facts);
      const summary = facts.kind === null ? `${request.tool.name.replace(/[^\w.:-]/gu, '').slice(0, 40)} (${facts.actionClass})` : reviewSummary(facts);
      // What the call writes counts as written by the session, whatever the answer (the safe side).
      if (facts.writeTargets.length) this.tracker.note(request.sessionId, facts.writeTargets.filter(path => !facts.downloadTargets.includes(path)), 'write');
      if (facts.downloadTargets.length) this.tracker.note(request.sessionId, facts.downloadTargets, 'download');
      if (action.kind === 'edit') this.tracker.note(request.sessionId, action.paths.map(path => isAbsolute(path) ? path : join(action.commandCwd ?? request.cwd, path)), 'edit');

      if (rules.verdict === 'deny') {
        const reason = rules.rule === 'write-outside' && writesOnlyToTemp(facts, request.cwd) ? TEMP_WRITE_MESSAGE
          : DENY_MESSAGES[rules.rule as typeof TIER1_DENY_RULES[number]] ?? DENY_MESSAGES.elevation;
        this.remember(request.sessionId, summary, mode, { outcome: 'deny', act: 'deny', tier: 'rule', reason: 'rule-deny', model: null, auditId: null });
        return { verdict: 'deny', reason };
      }
      const run = (): Promise<CommandReviewVerdict> => this.ladder(request, state, facts, rules, action.content, signal);
      if (mode === 'shadow' || mode === 'suggest') {
        // Nothing is enforced (R10); the agent is not held. The review runs on its own, for the log and the badge.
        void run().then(verdict => {
          this.rememberVerdict(request.sessionId, summary, mode, verdict, null);
          if (mode === 'suggest' && verdict.show) this.options.suggest?.(request.sessionId, verdict, summary);
        }, () => undefined);
        return null;
      }
      const verdict = await run();
      if (signal.aborted && !verdict.act) {
        const answer = ask('unavailable');
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, reason: 'unavailable' }, act(answer));
        return answer;
      }
      if (verdict.act === 'allow') {
        this.rememberVerdict(request.sessionId, summary, mode, verdict, 'allow');
        return { verdict: 'allow', reason: verdict.by === 'rule' ? 'CanvasTTY Assistant: a read-only command' : 'CanvasTTY Assistant: both reviews agree it serves the task' };
      }
      if (verdict.act === 'deny') {
        this.rememberVerdict(request.sessionId, summary, mode, verdict, 'deny');
        return { verdict: 'deny', reason: MODEL_DENY_MESSAGE };
      }
      const answer = ask(verdict.reason);
      this.rememberVerdict(request.sessionId, summary, mode, verdict, act(answer));
      return answer;
    } catch {
      // R4: never an allow. In Auto the person decides (or, for an agent that cannot ask, a deny); Learning and Suggest
      // enforce nothing.
      return mode === 'auto' ? ask('unavailable') : null;
    }
  }

  private async ladder(request: DecideRequest, state: SessionState, facts: CommandFacts, rules: ReturnType<typeof tier1>, content: string | null, signal: AbortSignal): Promise<CommandReviewVerdict> {
    const settings = this.options.settings();
    const git = this.options.git === null ? null : this.options.git ?? defaultGit;
    const cacheScope = createHash('sha256').update(JSON.stringify([request.sessionId, request.cwd, facts.actionClass, factPhrases(facts), facts.shape])).digest('hex');
    const verdict = await askCommandReview(this.options.engine, {
      facts, tier1: rules, personRequest: state.personRequest?.text ?? null, content, dataClass: state.dataClass ?? settings.defaultDataClass,
      session: { suspect: state.suspect, strict: this.strict(state), personOnly: this.circuit.personOnly(request.sessionId) },
      cacheScope,
      referencedFiles: include => collectReferencedFiles({ root: request.cwd, facts, git, signal, include })
    }, {
      signal, sessionId: request.sessionId, requester: request.role === 'agent' ? 'agent' : 'orchestrator',
      assertCurrent: () => { if (signal.aborted) throw new Error('This review is past its deadline.'); }
    });
    if (verdict.markSuspect) state.suspect = true;
    if (verdict.modelOutcome) this.circuit.record(request.sessionId, verdict.modelOutcome, verdict.modelDenied);
    return verdict;
  }

  private rememberVerdict(sessionId: string, summary: string, mode: string, verdict: CommandReviewVerdict, act: RecentReview['act']): void {
    this.remember(sessionId, summary, mode, { outcome: verdict.outcome, act, tier: tierOf(verdict), reason: verdict.reason, model: verdict.model ?? null, auditId: verdict.auditId });
  }

  private remember(sessionId: string, summary: string, mode: string, entry: Pick<RecentReview, 'outcome' | 'act' | 'tier' | 'reason' | 'model' | 'auditId'>): void {
    this.recentReviews.unshift({ at: this.now(), session: sessionId.slice(0, 8), summary, mode, ...entry, label: null });
    this.recentReviews.splice(MAX_RECENT);
  }
}
