import { closeSync, fstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { REVIEW_LIMITS } from '../shared/commandReview.ts';
import type { CommandFacts, GitRunner } from './commandFacts.ts';

/**
 * The project files a command runs, for the smart verifier only (assistant spec §2.6, §3.1b): at most 2, each at
 * most 8 KiB, inside the project, regular files, never a key or token file. When the command runs a script that
 * changed (written in this session or not committed) or build files that changed, the smart verifier must see
 * that text or diff in full; if it cannot (too long, unreadable, too many), the request goes to the person.
 *
 * Nothing here runs anything but `git diff` with external diff helpers and text conversion switched off.
 */

export interface ReferencedFile {
  /** Project-relative, `/`-separated; a package.json script entry is `package.json#scripts.<name>`. */
  path: string;
  kind: 'content' | 'diff' | 'script-entry';
  text: string;
  truncated: boolean;
}

export interface ReferencedFiles {
  files: ReferencedFile[];
  /** Every file the smart verifier must read (changed scripts, changed build files) is here in full. */
  complete: boolean;
}

const PACKAGE_JSON_MAX = 256 * 1024;
const SCRIPT_FILE = /(?:^|[\s"'=])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx|sh|bash|zsh|py|rb|pl|php|ps1|lua))(?=$|[\s"';&|)])/gu;
const CREDENTIAL = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_[a-z0-9_]+|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk)|credentials(?:\.json)?|[^/]*secrets?[^/]*)$|(?:^|\/)\.(?:ssh|gnupg|aws|azure|kube|docker)\//iu;

/** Real path inside the (real) root, or null. */
function insideRoot(rootReal: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || CREDENTIAL.test(rel.replace(/\\/gu, '/'))) return null;
  let real: string;
  try { real = realpathSync.native(resolve(rootReal, rel)); } catch { return null; }
  const back = relative(rootReal, real);
  if (!back || back.startsWith('..') || isAbsolute(back) || CREDENTIAL.test(back.split(sep).join('/'))) return null;
  return real;
}

/** At most `max` bytes of a regular file (no symlink loop, no device), and whether there was more. */
function readBounded(path: string, max: number): { text: string; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(max + 1, Math.max(1, stat.size + 1)));
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    const truncated = read > max;
    const bytes = buffer.subarray(0, Math.min(read, max));
    if (bytes.includes(0)) return null; // binary
    return { text: bytes.toString('utf8'), truncated };
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
}

function packageScripts(rootReal: string): Record<string, string> | null {
  const real = insideRoot(rootReal, 'package.json');
  if (!real) return null;
  const read = readBounded(real, PACKAGE_JSON_MAX);
  if (!read || read.truncated) return null;
  try {
    const parsed = JSON.parse(read.text) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  } catch { return null; }
}

/** The package.json script entries `npm run <name>` runs (with its pre/post hooks). */
export function npmScriptEntries(rootReal: string, names: readonly string[]): Array<{ name: string; text: string }> {
  const scripts = packageScripts(rootReal);
  if (!scripts) return [];
  const out: Array<{ name: string; text: string }> = [];
  for (const name of names.slice(0, 4)) for (const key of [`pre${name}`, name, `post${name}`]) if (Object.hasOwn(scripts, key)) out.push({ name: key, text: scripts[key]! });
  return out;
}

/** Project files named by those script entries (node scripts/build.js → scripts/build.js), that exist inside the project. */
export function npmScriptFiles(rootReal: string, names: readonly string[]): string[] {
  const files = new Set<string>();
  for (const entry of npmScriptEntries(rootReal, names)) {
    for (const match of entry.text.matchAll(SCRIPT_FILE)) {
      const rel = match[1]!.replace(/^\.\//u, '');
      const real = insideRoot(rootReal, rel);
      if (real) files.add(relative(rootReal, real).split(sep).join('/'));
      if (files.size >= 8) return [...files];
    }
  }
  return [...files];
}

const DIFF_READ_MAX = 64 * 1024;
const DIFF_LINES_MAX = 2_000;

/**
 * A unified diff (3 lines of context) of the committed text against the file on disk. The committed text comes
 * from `git cat-file blob HEAD:./path`, which applies no filter and no text conversion; the diff is computed here,
 * so no repository-configured program ever runs.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length > DIFF_LINES_MAX || b.length > DIFF_LINES_MAX) return `--- a/${path}\n+++ b/${path}\n${b.map(line => `+${line}`).join('\n')}`;
  // Longest common subsequence table, bounded by DIFF_LINES_MAX².
  const n = a.length, m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ kind: ' ', line: a[i]! }); i++; j++; }
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) { ops.push({ kind: '+', line: b[j]! }); j++; }
    else { ops.push({ kind: '-', line: a[i]! }); i++; }
  }
  const keep = ops.map((op, index) => op.kind !== ' ' || ops.slice(Math.max(0, index - context), index + context + 1).some(near => near.kind !== ' '));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) { if (!skipped) out.push('@@'); skipped = true; return; }
    skipped = false;
    out.push(`${op.kind}${op.line}`);
  });
  return out.join('\n');
}

async function diffOf(rootReal: string, rel: string, git: GitRunner, signal: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
  const real = insideRoot(rootReal, rel);
  const current = real ? readBounded(real, DIFF_READ_MAX) : null;
  if (!current || current.truncated) return null;
  let before: string;
  try { before = await git(rootReal, ['cat-file', 'blob', `HEAD:./${rel}`], signal); } catch { return null; }
  if (before.length > DIFF_READ_MAX || before.includes('\0')) return null;
  const diff = unifiedDiff(rel, before, current.text);
  return { text: diff.slice(0, REVIEW_LIMITS.referencedFileBytes), truncated: Buffer.byteLength(diff) > REVIEW_LIMITS.referencedFileBytes };
}

export interface ReferencedFilesInput {
  root: string;
  facts: Pick<CommandFacts, 'scripts' | 'changedScripts' | 'changedBuildFiles' | 'buildFiles' | 'npmScripts'>;
  git: GitRunner | null;
  signal: AbortSignal;
  /** `required`: only what the smart verifier must see; `all`: also the scripts and entries of an unchanged command (effect_hidden). */
  include: 'required' | 'all';
}

export async function collectReferencedFiles(input: ReferencedFilesInput): Promise<ReferencedFiles> {
  let rootReal: string;
  try { rootReal = realpathSync.native(resolve(input.root)); } catch { return { files: [], complete: false }; }
  const max = REVIEW_LIMITS.referencedFiles;
  const files: ReferencedFile[] = [];
  let complete = true;
  const content = (rel: string): ReferencedFile | null => {
    const real = insideRoot(rootReal, rel);
    const read = real ? readBounded(real, REVIEW_LIMITS.referencedFileBytes) : null;
    return read ? { path: rel, kind: 'content', text: read.text, truncated: read.truncated } : null;
  };
  const required: Array<() => Promise<ReferencedFile | null>> = [];
  // 1. A changed script the command runs: its whole text.
  for (const rel of input.facts.changedScripts) required.push(async () => content(rel));
  // 2. Changed build files: the diff (or the whole file when it is new).
  for (const rel of input.facts.changedBuildFiles) {
    if (input.facts.changedScripts.includes(rel)) continue;
    required.push(async () => {
      if (!insideRoot(rootReal, rel)) return null;
      const diff = input.git ? await diffOf(rootReal, rel, input.git, input.signal) : null;
      if (diff) return { path: rel, kind: 'diff', text: diff.text, truncated: diff.truncated };
      return content(rel);
    });
  }
  for (const next of required) {
    if (files.length >= max) { complete = false; break; }
    const file = await next();
    if (!file || file.truncated) complete = false;
    if (file) files.push(file);
  }
  // What runs but could not be shown whole (unreadable, cut, or past the file limit) leaves the set incomplete.
  if (input.include === 'all') {
    for (const entry of npmScriptEntries(rootReal, input.facts.npmScripts)) {
      if (files.length >= max) { complete = false; break; }
      const text = entry.text.slice(0, REVIEW_LIMITS.referencedFileBytes);
      const truncated = text.length < entry.text.length;
      if (truncated) complete = false;
      files.push({ path: `package.json#scripts.${entry.name}`, kind: 'script-entry', text, truncated });
    }
    for (const rel of [...input.facts.scripts, ...input.facts.buildFiles.filter(file => /^(?:Makefile|makefile|GNUmakefile|justfile|Justfile)$/u.test(file))]) {
      if (files.some(file => file.path === rel)) continue;
      if (files.length >= max) { complete = false; break; }
      const file = content(rel);
      if (!file || file.truncated) complete = false;
      if (file) files.push(file);
    }
  }
  return { files, complete };
}
