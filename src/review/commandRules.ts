import { REVIEWABLE_ACP_KINDS } from '../shared/commandReview.ts';
import type { CommandFacts } from './commandFacts.ts';
import { programName } from './commandFacts.ts';
import { lexShell, normalizeCommand, SHELL_METACHARACTER } from './shellParse.ts';

/**
 * Tier 1 of command review (assistant spec §3.1b, R1): deterministic and final, evaluated before any model.
 *
 * - **deny** (never relaxed by any model, whatever it answers): elevation (`sudo`, `doas`, `runas`, …), a pipe
 *   into a shell or interpreter (`curl … | sh`, `iwr … | iex`), download-and-run, deleting or writing outside the
 *   working folder (`rm -rf ~`, `> /etc/hosts`, `rd /s /q C:\`), disk and format commands (`diskutil erase…`,
 *   `mkfs`, `dd of=/dev/…`, `format C:`, `Format-Volume`, `diskpart`), a fork bomb;
 * - **ask** (the person answers; no model is asked): force push and history rewrites, a recursive delete of a
 *   target nobody can resolve, power and kill-everything commands, encoded PowerShell, input that cannot be read
 *   with certainty, and tool kinds a reviewer may not answer;
 * - **allow**: only a whole normalized command with no shell metacharacters from a small read-only list, whose
 *   paths all stay inside the project and are not key files, that runs no project script.
 */

export type Tier1Verdict = 'deny' | 'ask' | 'allow';
export interface Tier1Result { verdict: Tier1Verdict | null; rule: string | null }

export const TIER1_DENY_RULES = ['elevation', 'pipe-to-shell', 'download-exec', 'delete-outside', 'write-outside', 'disk', 'fork-bomb'] as const;
export const TIER1_ASK_RULES = ['force-push', 'history-rewrite', 'recursive-delete-unresolved', 'power', 'kill-all', 'encoded', 'unreadable', 'not-reviewable'] as const;

/** The read-only allow list: program → the subcommands allowed (null = any argument words). */
const ALLOW: Readonly<Record<string, readonly string[] | null>> = {
  pwd: null, ls: null, cat: null, head: null, tail: null, wc: null, file: null, stat: null, tree: null, echo: null,
  whoami: null, date: null, uname: null, which: null, rg: null, grep: null, du: null,
  git: ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame']
};
/** Flags that make an allow-listed program write, run a helper or read compressed files through external programs. */
const REFUSED_FLAGS = /^(?:--pre|--pre-glob|-z|--search-zip|--output|--ext-diff|--textconv|-o|--open-files-in-pager|-O)(?:=|$)/u;
const VERSION_ONLY = /^(?:node|npm|pnpm|yarn|bun|deno|python3?|pip3?|git|go|cargo|rustc|java|ruby|tsc|make|cmake|docker|gh|uv) (?:--version|version)$/u;

export function tier1(facts: CommandFacts): Tier1Result {
  const deny = (rule: typeof TIER1_DENY_RULES[number]): Tier1Result => ({ verdict: 'deny', rule });
  const ask = (rule: typeof TIER1_ASK_RULES[number]): Tier1Result => ({ verdict: 'ask', rule });
  if (facts.elevation) return deny('elevation');
  if (facts.pipeToShell) return deny('pipe-to-shell');
  if (facts.downloadExec) return deny('download-exec');
  if (facts.disk) return deny('disk');
  if (facts.forkBomb) return deny('fork-bomb');
  if (facts.deletesOutside) return deny('delete-outside');
  if (facts.writesOutside) return deny('write-outside');

  if (facts.kind !== null && !REVIEWABLE_ACP_KINDS.includes(facts.kind)) return ask('not-reviewable');
  if (facts.kind === null && facts.command === null) return ask('not-reviewable');
  if (facts.forcePush) return ask('force-push');
  if (facts.historyRewrite) return ask('history-rewrite');
  if (facts.rmUnresolved) return ask('recursive-delete-unresolved');
  if (facts.power) return ask('power');
  if (facts.killAll) return ask('kill-all');
  if (facts.encoded) return ask('encoded');
  if (facts.unterminated) return ask('unreadable');

  if (exactAllow(facts)) return { verdict: 'allow', rule: 'read-only' };
  return { verdict: null, rule: null };
}

/** A whole normalized command, no metacharacters, one program from the list, every path inside and not a key file. */
function exactAllow(facts: CommandFacts): boolean {
  if (facts.kind !== 'execute' && facts.kind !== null || !facts.command || facts.truncated) return false;
  const command = normalizeCommand(facts.command);
  if (!command || command.length > 400 || SHELL_METACHARACTER.test(command)) return false;
  if (VERSION_ONLY.test(command)) return true;
  if (facts.actionClass !== 'read_only' || facts.stays !== 'yes' || facts.network !== 'none' || facts.credentialAccess || facts.scripts.length || facts.unresolvedVariables || facts.subshell) return false;
  const lexed = lexShell(command);
  if (lexed.segments.length !== 1 || lexed.segments[0]!.redirects.length) return false;
  const argv = lexed.segments[0]!.words.map(word => word.text);
  const program = argv[0]!;
  // A bare name only: a path could be a project script with the same name.
  if (program !== programName(program)) return false;
  if (!Object.hasOwn(ALLOW, program)) return false;
  const subs = ALLOW[program];
  if (subs) {
    if (!subs.includes(argv[1] ?? '')) return false;
    // `git branch` only lists: no names, no flags that change anything.
    if (program === 'git' && argv[1] === 'branch' && argv.slice(2).some(arg => !/^(?:-a|-r|-v|-vv|--list|--all|--show-current)$/u.test(arg))) return false;
  }
  return !argv.slice(1).some(arg => REFUSED_FLAGS.test(arg));
}
