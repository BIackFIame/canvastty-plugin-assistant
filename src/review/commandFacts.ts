import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FIELD_BOUNDS, type ActionClass } from '../shared/catalog.ts';
import type { AcpToolKind } from '../shared/commandReview.ts';
import { lexShell, shellQuote, type Segment, type Word } from './shellParse.ts';
import { npmScriptFiles } from './referencedFiles.ts';

/**
 * Code facts for command review (assistant spec §3.1b). Everything here is computed by code from the request and
 * the project folder; nothing is executed except read-only `git status` / `git ls-files` with repository hooks,
 * fsmonitor and external diff helpers switched off. A fact that cannot be established counts against the
 * command, never for it.
 */

// ---------------------------------------------------------------------------
// What is reviewed
// ---------------------------------------------------------------------------

/** One request, source-neutral. ACP permissions are turned into this by the service. */
export interface ReviewAction {
  kind: AcpToolKind | null;
  /** A shell command for `execute`; null when none could be read. */
  command: string | null;
  /** The command's own working directory, if the agent said one. */
  commandCwd: string | null;
  /** Paths the tool names (ACP locations, rawInput paths). */
  paths: string[];
  /** New content of an edit. */
  content: string | null;
  /** The captured input was cut (rawInput or content over its bound). */
  inputTruncated: boolean;
  url: string | null;
}

export type Where = 'inside' | 'outside' | 'unresolved';
export interface Target {
  raw: string;
  abs: string | null;
  where: Where;
  /** Project-relative, `/`-separated; null outside or unresolved. */
  rel: string | null;
  protected: boolean;
  credential: boolean;
  /** A block device (/dev/disk2, /dev/sda, \\.\PhysicalDrive0). */
  device: boolean;
  /** Names the working folder itself (not through a glob): deleting it is deleting the project. */
  root: boolean;
}

export interface CommandFacts {
  tool: string;
  kind: AcpToolKind | null;
  command: string | null;
  actionClass: ActionClass;
  shape: { program: string; subcommand?: string; flags: string[] };
  stays: 'yes' | 'no' | 'unknown';
  network: 'none' | 'downloads' | 'sends data to a remote';
  deletes: 'no' | 'inside the project' | 'outside the project';

  // Hard facts (tier 1).
  elevation: boolean; pipeToShell: boolean; downloadExec: boolean; disk: boolean; forkBomb: boolean;
  writesOutside: boolean; deletesOutside: boolean;
  // Always-ask facts.
  forcePush: boolean; historyRewrite: boolean; rmUnresolved: boolean; power: boolean; killAll: boolean; encoded: boolean; unterminated: boolean;
  // Unseeable effect.
  evalGenerated: boolean; sourceUntracked: boolean; runsDownloaded: boolean; runsOutsideScript: boolean;
  // Other risky facts.
  unresolvedVariables: boolean; subshell: boolean; inlineCode: boolean; background: boolean; gitConfigOverride: boolean;
  gitPush: boolean; protectedWrite: boolean; credentialAccess: boolean;
  /** A project script this command runs was written in this session, or has uncommitted changes. */
  runsChangedScript: boolean;
  /** Build files this command executes have uncommitted changes (or it cannot be told); null when no build file is involved. */
  buildScriptsModified: boolean | null;
  gitTree: 'clean' | 'dirty' | 'none' | 'unknown';
  truncated: boolean;
  requestTypedByPerson: boolean;

  /** Project-relative scripts the command runs or sources. */
  scripts: string[];
  /** Of those, the ones written in the session or with uncommitted changes. */
  changedScripts: string[];
  /** Project-relative build files the command's tool executes. */
  buildFiles: string[];
  changedBuildFiles: string[];
  /** `npm run X` style script names. */
  npmScripts: string[];
  /** Absolute targets this command writes (for the session tracker), and those it downloads to. */
  writeTargets: string[];
  downloadTargets: string[];
  /** For edit tools: the project-relative path (first one). */
  path: string | null;
}

/** A pipe to a shell, eval of generated text, source of an untracked file, running a downloaded or unreadable file (§3.1b). */
export function unseeableEffect(f: CommandFacts): boolean {
  return f.pipeToShell || f.downloadExec || f.evalGenerated || f.sourceUntracked || f.runsDownloaded || f.runsOutsideScript || f.encoded || f.unterminated;
}

/** The other risky facts: they rule out AUTO (R3); only the VERIFY agreement can allow them. */
export function riskyFacts(f: CommandFacts): boolean {
  return f.unresolvedVariables || f.subshell || f.network !== 'none' || f.buildScriptsModified !== null && f.buildScriptsModified !== false
    || f.truncated || f.runsChangedScript || f.inlineCode || f.background || f.gitConfigOverride;
}

/** The short phrases sent as `facts` (metadata: code constants only, no path, no value). */
export function factPhrases(f: CommandFacts): Record<string, string> {
  return {
    stays_inside_project: f.stays,
    network_access: f.network,
    deletes_files: f.deletes,
    runs_project_script: f.scripts.length === 0 ? 'no' : f.runsChangedScript ? 'yes, a script changed and not committed or written in this session' : 'yes',
    build_files_changed: f.buildScriptsModified === null ? 'not involved' : f.buildScriptsModified ? 'yes' : 'no'
  };
}

// ---------------------------------------------------------------------------
// Files written in a session (hook points: ACP edit tool calls, reviewed command write targets)
// ---------------------------------------------------------------------------

export type WriteOrigin = 'edit' | 'write' | 'download';
const TRACK_MAX = 2_000;

/**
 * What each session wrote, as far as CanvasTTY saw it: ACP edit/delete/move tool calls and the write targets of
 * every command it reviewed (whatever the answer; a superset is the safe side). Memory only, bounded.
 */
export class SessionWriteTracker {
  private readonly sessions = new Map<string, Map<string, WriteOrigin>>();

  note(sessionId: string, paths: readonly string[], origin: WriteOrigin): void {
    let entries = this.sessions.get(sessionId);
    if (!entries) { entries = new Map(); this.sessions.set(sessionId, entries); }
    for (const path of paths) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_096) continue;
      const key = realish(path);
      // A download stays a download even if the file is edited later.
      if (entries.get(key) === 'download') continue;
      entries.delete(key);
      entries.set(key, origin);
      while (entries.size > TRACK_MAX) entries.delete(entries.keys().next().value!);
    }
  }

  /** How the session produced `path` (or a folder above it); null if it did not. */
  origin(sessionId: string, path: string): WriteOrigin | null {
    const entries = this.sessions.get(sessionId);
    if (!entries) return null;
    const key = realish(path);
    const exact = entries.get(key);
    if (exact) return exact;
    for (const [written, origin] of entries) if (origin === 'download' && key.startsWith(written + sep)) return origin;
    return null;
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId); }
}

// ---------------------------------------------------------------------------
// Git (read-only, hooks and helpers off)
// ---------------------------------------------------------------------------

export type GitRunner = (cwd: string, args: readonly string[], signal: AbortSignal) => Promise<string>;

/** Options that stop git from running repository-configured programs while it reads (fsmonitor, hooks, pagers). */
export const SAFE_GIT_PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'status.submoduleSummary=false', '-c', 'protocol.allow=never'] as const;
/** The only git subcommands the review runs. None of them reads a worktree file through a filter or runs a helper. */
export const REVIEW_GIT_SUBCOMMANDS = ['rev-parse', 'ls-files', 'hash-object', 'diff-index', 'cat-file'] as const;

export const defaultGit: GitRunner = (cwd, args, signal) => new Promise((resolvePromise, reject) => {
  if (!(REVIEW_GIT_SUBCOMMANDS as readonly string[]).includes(args[0] ?? '') || args[0] === 'cat-file' && args[1] !== 'blob' || args[0] === 'hash-object' && (args[1] !== '--no-filters' || args.includes('-w'))) {
    reject(new Error('This git command is not used by review.')); return;
  }
  execFile('git', [...SAFE_GIT_PREFIX, ...args], {
    cwd, signal, timeout: 2_500, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' }
  }, (error, stdout) => error ? reject(error) : resolvePromise(String(stdout)));
});

interface GitState { repo: boolean; changed: Set<string>; tracked: Set<string> }

/**
 * Which of `candidates` (absolute files inside the project) differ from the last commit, through plumbing that never
 * reads a worktree file through a repository-configured program: `git status`, `git diff` and even `diff-files`
 * run clean filters (`filter.<x>.clean` with `.gitattributes`) on changed files, which would let a repository
 * execute code during a review. Instead: the index blob ids (`ls-files -s`), the raw content's ids
 * (`hash-object --no-filters`) and staged changes (`diff-index --cached`). A file under a filter reads as changed:
 * the safe side. An untracked file is changed.
 */
async function gitState(root: string, candidates: readonly string[], git: GitRunner, signal: AbortSignal): Promise<GitState | null> {
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).trim();
    if (!top) return { repo: false, changed: new Set(), tracked: new Set() };
    const topReal = realish(top);
    const files = [...new Set(candidates.map(realish))].filter(abs => { const rel = relative(topReal, abs); return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && isFileQuiet(abs); }).slice(0, 32);
    const rels = files.map(abs => relative(topReal, abs).split(sep).join('/'));
    const changed = new Set<string>(), tracked = new Set<string>();
    if (!rels.length) return { repo: true, changed, tracked };
    const index = new Map<string, string>();
    for (const entry of (await git(topReal, ['ls-files', '-s', '-z', '--', ...rels], signal)).split('\0')) {
      const m = /^\d+ ([0-9a-f]{40,64}) 0\t(.+)$/u.exec(entry);
      if (m) index.set(realish(resolve(topReal, m[2]!)), m[1]!);
    }
    const hashes = (await git(topReal, ['hash-object', '--no-filters', '--', ...rels], signal)).trim().split('\n');
    let staged: Set<string>;
    try { staged = new Set((await git(topReal, ['diff-index', '--cached', '--name-only', '-z', 'HEAD', '--', ...rels], signal)).split('\0').filter(Boolean).map(file => realish(resolve(topReal, file)))); }
    catch { staged = new Set(files); } // no commit yet: everything is new
    files.forEach((abs, i) => {
      const indexed = index.get(abs);
      if (indexed) tracked.add(abs);
      if (!indexed || indexed !== hashes[i]?.trim() || staged.has(abs)) changed.add(abs);
    });
    return { repo: true, changed, tracked };
  } catch (error) {
    if (signal.aborted) return null;
    const message = String((error as { stderr?: unknown })?.stderr ?? (error as Error)?.message ?? '');
    return /not a git repository/iu.test(message) ? { repo: false, changed: new Set(), tracked: new Set() } : null;
  }
}

function isFileQuiet(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** realpath of the longest existing ancestor plus the rest (a symlink out of the project resolves outside). */
export function realish(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch { /* go up */ }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
  return path;
}

const PROTECTED_DIRS = new Set(['.git', '.claude', '.codex', '.qwen', '.opencode', '.vscode', '.idea', '.cursor', '.gemini', '.kimi', '.grok', '.hermes', '.github', '.husky', '.circleci', '.buildkite', '.gitlab', '.devcontainer']);
const PROTECTED_FILES = new Set(['.gitattributes', '.envrc', '.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'jenkinsfile', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', '.mcp.json', '.gitmodules', 'opencode.json', '.opencode.json']);
const CREDENTIAL_NAMES = new Set(['.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd', 'credentials', 'credentials.json', '.credentials.json', 'auth.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', '.env']);
const CREDENTIAL_DIRS = ['/.ssh/', '/.gnupg/', '/.aws/', '/.azure/', '/.kube/', '/.docker/', '/library/keychains/', '/.config/gcloud/', '/.config/gh/', '/.password-store/', '/.local/share/keyrings/'];

/** Key, token and password files (never read for review; access is class `credentials`). */
export function isCredentialPath(path: string): boolean {
  const lower = path.replace(/\\/gu, '/').toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (CREDENTIAL_NAMES.has(name)) return true;
  if (/^\.env\./u.test(name) && !/\.(example|sample|template|dist|defaults?)$/u.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/u.test(name)) return true;
  if (/^id_[a-z0-9_]+$/u.test(name)) return true;
  if (/(^|[._-])secrets?(\.|$)/u.test(name)) return true;
  return CREDENTIAL_DIRS.some(dir => `/${lower}`.includes(dir));
}

/** Inside the project, a place whose files run code or change permissions later (§3.1b): writes are class `system`. */
export function isProtectedRel(rel: string): boolean {
  const parts = rel.split('/');
  const first = parts[0]!.toLowerCase();
  if (PROTECTED_DIRS.has(first)) return true;
  const name = parts[parts.length - 1]!.toLowerCase();
  return PROTECTED_FILES.has(name) || /^\.env($|\.)/u.test(name);
}

const DEVICE = /^(?:\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|xvd[a-z]|vd[a-z]|md\d|dm-\d|loop\d|mapper\/)|\\\\\.\\(?:physicaldrive|[a-z]:))/iu;
const HARMLESS_DEVICE = /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$|^(?:nul|con)$/iu;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[A-Za-z]:$|\\\\)/u;

export interface PathContext { root: string; rootReal: string; home: string; temp: string; agentRoots: string[] }

/**
 * `agentRoots`: the agent's own config folders (Claude's ~/.claude or the run's CLAUDE_CONFIG_DIR). Their plan and
 * memory folders belong to the agent, so writing there is not a write outside the project.
 */
export function pathContext(root: string, home = homedir(), agentRoots?: readonly string[]): PathContext {
  return { root, rootReal: realish(resolve(root)), home, temp: tmpdir(), agentRoots: (agentRoots ?? [join(home, '.claude')]).map(dir => realish(resolve(dir))) };
}

const AGENT_SERVICE_DIR = /^(?:plans|projects[\\/][^\\/]+[\\/]memory)(?:[\\/]|$)/u;

/** The path is inside an agent config folder's `plans/` or `projects/<project>/memory/` (already resolved, so no `..`). */
export function isAgentServicePath(abs: string, ctx: PathContext): boolean {
  return ctx.agentRoots.some(dir => {
    const rel = relative(dir, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && AGENT_SERVICE_DIR.test(rel);
  });
}

const HOME_VARS = new Set(['HOME', 'USERPROFILE', 'ENV:USERPROFILE', 'ENV:HOME']);
const TEMP_VARS = new Set(['TMPDIR', 'TEMP', 'TMP', 'ENV:TEMP', 'ENV:TMP']);

/** Expands only what is certain (~, HOME, PWD, TMPDIR); anything else is unresolved. */
function expand(word: Word | string, cwd: string | null, ctx: PathContext): string | null {
  if (typeof word !== 'string' && word.substitution) return null;
  let text = typeof word === 'string' ? word : word.text;
  const vars = typeof word === 'string' ? [] : word.vars;
  for (const name of vars) {
    let value: string | null = null;
    if (HOME_VARS.has(name)) value = ctx.home;
    else if (name === 'PWD' || name === 'ENV:PWD') value = cwd;
    else if (TEMP_VARS.has(name)) value = ctx.temp;
    if (value === null) return null;
    text = text.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])|%${name}%|\\$env:${name.replace(/^ENV:/u, '')}`, 'iu'), value);
  }
  if (typeof word !== 'string' ? word.tilde : text.startsWith('~')) {
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = ctx.home + text.slice(1);
    else return null;
  }
  return text;
}

/**
 * Where a word points. `noFollow`: the operation acts on the last path component itself (rm, unlink, mv of a
 * symlink removes or renames the link, not what it points to), so only the folders above it are resolved.
 */
export function resolveTarget(word: Word | string, cwd: string | null, ctx: PathContext, noFollow = false): Target {
  const raw = typeof word === 'string' ? word : word.text;
  const blank: Target = { raw, abs: null, where: 'unresolved', rel: null, protected: false, credential: isCredentialPath(raw), device: DEVICE.test(raw), root: false };
  const globbed = typeof word !== 'string' && word.glob;
  let text = expand(word, cwd, ctx);
  if (text === null || text === '') return blank;
  if (typeof word !== 'string' && word.glob) {
    // A glob acts on everything under the folder before its first wildcard.
    const first = text.search(/[*?[]/u);
    const cut = text.slice(0, first).lastIndexOf('/');
    text = cut < 0 ? '.' : text.slice(0, cut) || '/';
  }
  if (DEVICE.test(text)) return { ...blank, device: true, where: 'outside', abs: text };
  if (WINDOWS_ABSOLUTE.test(text) && sep === '/') return { ...blank, abs: text, where: 'outside', credential: isCredentialPath(text) };
  if (!isAbsolute(text) && cwd === null) return blank;
  const full = resolve(cwd ?? ctx.root, text);
  const abs = noFollow && !/[\\/]$/u.test(text) && basename(full) !== '..' && basename(full) !== '.' && dirname(full) !== full ? join(realish(dirname(full)), basename(full)) : realish(full);
  const rel = relative(ctx.rootReal, abs);
  const inside = rel === '' || !rel.startsWith('..') && !isAbsolute(rel);
  const relPath = inside ? rel.split(sep).join('/') : null;
  return { raw, abs, where: inside ? 'inside' : 'outside', rel: relPath, protected: !!relPath && isProtectedRel(relPath), credential: isCredentialPath(abs) || isCredentialPath(raw), device: false, root: rel === '' && !globbed };
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

const CLASS_RANK: Readonly<Record<ActionClass, number>> = {
  read_only: 0, edit_in_project: 1, vcs_local: 2, build_test: 3, install_deps: 4, process: 5, network_read: 6, unknown: 7,
  delete: 8, vcs_remote: 9, publish: 10, outside_project: 11, system: 12, credentials: 13
};
export const worseClass = (a: ActionClass, b: ActionClass): ActionClass => CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'lua', 'luajit', 'rscript', 'tsx', 'ts-node', 'deno', 'bun', 'osascript', 'jshell', 'groovy', 'julia', 'elixir', 'swift']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const EVAL_WORDS = new Set(['eval', 'iex', 'invoke-expression']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer', 'certutil', 'bitsadmin', 'lwp-download', 'ftp', 'tftp', 'nc', 'ncat', 'socat']);
const ELEVATION = new Set(['sudo', 'doas', 'pkexec', 'run0', 'runas', 'gsudo', 'please']);
const WRAPPERS = new Set(['nohup', 'time', 'nice', 'ionice', 'timeout', 'gtimeout', 'stdbuf', 'command', 'builtin', 'exec', 'caffeinate', 'watch', 'chronic', 'unbuffer', 'setsid', 'script']);
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'mosh', 'rsh', 'rcp', 'telnet', 'ftp', 'tftp', 'nc', 'ncat', 'netcat', 'socat', 'rlogin']);
const DISK = new Set(['mkfs', 'mke2fs', 'mkswap', 'newfs', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'parted', 'blkdiscard', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition', 'set-disk', 'mdadm', 'lvremove', 'vgremove', 'pvremove', 'cryptsetup', 'asr', 'fdformat', 'gpt']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer', 'init', 'telinit']);
const CREDENTIAL_TOOLS = new Set(['security', 'ssh-add', 'ssh-keygen', 'op', 'pass', 'keyring', 'vault', 'gpg', 'gpg2', 'cmdkey', 'secret-tool', 'aws-vault']);
const SYSTEM_TOOLS = new Set(['systemctl', 'service', 'launchctl', 'sc', 'crontab', 'at', 'defaults', 'scutil', 'networksetup', 'pfctl', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'csrutil', 'spctl', 'xattr', 'chflags', 'sysctl', 'mount', 'umount', 'reg', 'setx', 'set-executionpolicy', 'netsh', 'bcdedit', 'schtasks', 'wmic', 'dism', 'sfc', 'update-alternatives', 'chsh', 'useradd', 'usermod', 'userdel', 'passwd', 'visudo', 'dscl', 'kextload', 'kextunload', 'nvram', 'pmset', 'tccutil', 'sqlite3', 'new-service', 'set-service', 'modprobe', 'insmod', 'rmmod', 'ldconfig', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'zypper', 'pacman', 'apk', 'port', 'choco', 'winget', 'scoop', 'snap', 'flatpak', 'pipx', 'mas', 'softwareupdate', 'installer', 'hdiutil', 'mdutil', 'tmutil', 'fsck', 'diskutil']);
const PUBLISH_TOOLS = new Set(['vercel', 'netlify', 'firebase', 'fly', 'flyctl', 'heroku', 'wrangler', 'serverless', 'sls', 'terraform', 'tofu', 'pulumi', 'kubectl', 'helm', 'aws', 'gcloud', 'gsutil', 'az', 'eb', 'ansible', 'ansible-playbook', 'twine', 'railway', 'doctl', 'cdk', 'sam', 'amplify', 'supabase', 'render']);
const READ_ONLY = new Set(['ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'tree', 'du', 'df', 'which', 'where', 'whereis', 'whoami', 'id', 'date', 'uname', 'hostname', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'comm', 'jq', 'yq', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'xxd', 'hexdump', 'od', 'strings', 'man', 'ps', 'lsof', 'sha256sum', 'sha1sum', 'shasum', 'md5sum', 'md5', 'cksum', 'nl', 'column', 'fold', 'fmt', 'rev', 'seq', 'sleep', 'uptime', 'free', 'vm_stat', 'sw_vers', 'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'select-string', 'sls', 'get-item', 'measure-object', 'findstr', 'ver', 'cal', 'locale', 'tput', 'clear', 'type', 'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'alias', 'exit', 'return', ':', 'local', 'declare', 'read', 'wait', 'jobs', 'history', 'fc', 'tac', 'paste', 'join', 'expand', 'unexpand', 'look', 'bat', 'fd', 'fzf', 'exa', 'eza', 'dust', 'tokei', 'cloc', 'nproc', 'getconf', 'arch', 'vmstat', 'iostat', 'top', 'htop', 'pgrep', 'env', 'tldr', 'info', 'apropos', 'whatis', 'mdls', 'mdfind', 'otool', 'nm', 'objdump', 'ldd', 'size', 'test-path', 'resolve-path', 'get-command', 'get-process', 'write-output', 'write-host', 'ipconfig', 'ifconfig', 'netstat', 'ss', 'dig', 'nslookup', 'host', 'ping', 'traceroute', 'whois']);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'select-string', 'sls', 'findstr', 'look']);
const NO_PATH_ARGS = new Set(['echo', 'printf', 'write-output', 'write-host', 'seq', 'sleep', 'date', 'export', 'unset', 'set', 'alias', 'local', 'declare', 'test', '[', 'true', 'false', 'exit', 'return', ':', 'read', 'man', 'which', 'where', 'whereis', 'type', 'uname', 'hostname', 'whoami', 'id', 'ps', 'pgrep', 'tput', 'clear', 'dig', 'nslookup', 'host', 'ping', 'traceroute', 'whois', 'jobs', 'wait', 'history', 'get-command', 'get-process', 'tldr', 'info', 'apropos', 'whatis', 'ipconfig', 'ifconfig', 'netstat', 'ss', 'printenv', 'env']);
const NETWORK_READ_TOOLS = new Set(['dig', 'nslookup', 'host', 'ping', 'traceroute', 'whois']);
const WINDOWS_BUILTINS = new Set(['del', 'erase', 'rd', 'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'format', 'dir', 'type', 'findstr', 'cipher', 'attrib', 'icacls', 'takeown', 'mklink', 'md', 'mkdir', 'rmdir', 'tree', 'taskkill']);

/** A program's name for the tables: basename, lower case, without a Windows executable suffix. */
export function programName(argv0: string): string {
  const name = argv0.replace(/\\/gu, '/').split('/').pop() ?? argv0;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/u, '');
}

const isFlag = (value: string, windows = false): boolean => value.startsWith('-') && value !== '-' || windows && /^\/[A-Za-z?]{1,3}(?::.*)?$/u.test(value);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Acc {
  ctx: PathContext;
  cls: ActionClass;
  shape: CommandFacts['shape'] | null;
  shapeRank: number;
  writes: Target[]; deletes: Target[]; reads: Target[]; downloads: Target[];
  network: 'none' | 'download' | 'upload';
  scripts: Target[]; sourced: Target[];
  buildFiles: Set<string>; npmScripts: Set<string>;
  flags: Record<'elevation' | 'pipeToShell' | 'downloadExec' | 'disk' | 'forkBomb' | 'forcePush' | 'historyRewrite' | 'rmUnresolved' | 'power' | 'killAll' | 'encoded' | 'unterminated' | 'evalGenerated' | 'runsOutsideScript' | 'unresolvedVariables' | 'subshell' | 'inlineCode' | 'background' | 'gitConfigOverride' | 'gitPush' | 'credentialAccess' | 'protectedSystem', boolean>;
  depth: number;
  budget: number;
}

function classify(acc: Acc, cls: ActionClass, program?: string, args: readonly string[] = [], subcommand?: string): void {
  acc.cls = worseClass(acc.cls, cls);
  if (program === undefined) return;
  // The shape follows the part that set the class (the riskiest one).
  const rank = CLASS_RANK[cls];
  if (acc.shape && rank <= acc.shapeRank) return;
  const flags = [...new Set(args.filter(arg => arg.startsWith('-')).map(arg => arg.split('=')[0]!).filter(flag => /^--?[A-Za-z0-9][A-Za-z0-9-]{0,40}$/u.test(flag)))].slice(0, 16);
  acc.shape = { program: program.slice(0, 40), ...(subcommand && /^[a-z][a-z0-9-]{0,30}$/u.test(subcommand) ? { subcommand } : {}), flags };
  acc.shapeRank = rank;
}

function wordOf(text: string): Word { return { text, quoted: false, vars: [], substitution: false, inner: [], glob: false, tilde: false }; }

/** Analyses one shell command string (recursively for `bash -c`, `eval`, substitutions). */
function analyzeText(command: string, cwd: string | null, acc: Acc): string | null {
  if (acc.depth > 4 || --acc.budget < 0) { acc.flags.unterminated = true; return cwd; }
  acc.depth++;
  try {
    const lexed = lexShell(command);
    if (lexed.unterminated) acc.flags.unterminated = true;
    if (lexed.grouping) acc.flags.subshell = true;
    if (lexed.background) acc.flags.background = true;
    if (/(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1/u.test(command)) acc.flags.forkBomb = true;
    // PowerShell download-and-run: iex (iwr …), Invoke-Expression (New-Object Net.WebClient).DownloadString(…).
    if (/\b(?:iex|invoke-expression)\b/iu.test(command) && /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\.webclient|start-bitstransfer|curl|wget)\b/iu.test(command)) acc.flags.downloadExec = true;
    let current = cwd;
    const downloadedHere: Target[] = [];
    for (const segment of lexed.segments) current = analyzeSegment(segment, current, acc, downloadedHere);
    return current;
  } finally { acc.depth--; }
}

function analyzeSegment(segment: Segment, cwd: string | null, acc: Acc, downloadedHere: Target[]): string | null {
  const words = [...segment.words];
  // Leading NAME=value assignments.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!.text) && !words[0]!.quoted) words.shift();
  for (const word of segment.words) inspectWord(word, acc);
  for (const redirect of segment.redirects) {
    if (redirect.fdDup || !redirect.target) continue;
    inspectWord(redirect.target, acc);
    if (redirect.op.includes('<<')) continue;
    if (HARMLESS_DEVICE.test(redirect.target.text)) continue;
    const target = resolveTarget(redirect.target, cwd, acc.ctx);
    if (target.device) { if (/>/u.test(redirect.op)) acc.flags.disk = true; continue; }
    if (redirect.op.includes('>')) acc.writes.push(target); else acc.reads.push(target);
  }
  if (!words.length) return cwd;
  return analyzeArgv(words, cwd, acc, { pipeIn: segment.pipeIn, heredoc: segment.heredoc }, downloadedHere);
}

function inspectWord(word: Word, acc: Acc): void {
  const unresolved = word.vars.filter(name => !HOME_VARS.has(name) && !TEMP_VARS.has(name) && name !== 'PWD' && name !== 'ENV:PWD');
  if (unresolved.length) acc.flags.unresolvedVariables = true;
  if (word.substitution) {
    acc.flags.subshell = true;
    // A substitution runs its own command.
    for (const inner of word.inner) analyzeText(inner, null, acc);
  }
}

interface Stdin { pipeIn: boolean; heredoc: string | null }

/** Words → what the command does. Returns the working directory after it (for `cd`). */
function analyzeArgv(argvWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): string | null {
  const argv = argvWords.map(word => word.text);
  const argv0 = argv[0]!;
  const program = programName(argv0);
  const args = argv.slice(1);
  const argWords = argvWords.slice(1);
  const target = (word: Word | string): Target => resolveTarget(word, cwd, acc.ctx);
  const positional = (windows = false): Word[] => argWords.filter(word => !isFlag(word.text, windows));
  const substituted = argvWords.some(word => word.substitution);
  const innerFetch = argvWords.some(word => word.inner.some(inner => fetchesIn(inner)));

  // An argv0 that is itself a substitution or a variable: nobody can tell what runs.
  if (argvWords[0]!.substitution || argvWords[0]!.vars.length) { acc.flags.evalGenerated = true; classify(acc, 'unknown', 'unknown', args); return cwd; }

  if (ELEVATION.has(program) || program === 'su' || (program === 'start-process' && args.some(arg => /^-verb$/iu.test(arg)) && args.some(arg => /^runas$/iu.test(arg)))) {
    acc.flags.elevation = true;
    classify(acc, 'system', program, args);
    const inner = program === 'su' ? args.indexOf('-c') : argWords.findIndex(word => !isFlag(word.text));
    if (program === 'su' && inner >= 0 && args[inner + 1]) analyzeText(args[inner + 1]!, cwd, acc);
    else if (program !== 'su' && inner >= 0) analyzeArgv(argWords.slice(inner), cwd, acc, stdin, downloadedHere);
    return cwd;
  }

  // Wrappers run their argument as a command.
  if (WRAPPERS.has(program) || program === 'env' && args.some(arg => !arg.startsWith('-') && !arg.includes('=')) || program === 'xargs') {
    if (program === 'command' && (args[0] === '-v' || args[0] === '-V')) { classify(acc, 'read_only', program, args); return cwd; }
    if (program === 'env' && args.some(arg => arg === '-S' || arg.startsWith('--split-string'))) acc.flags.inlineCode = true;
    let i = 0;
    const takesValue = new Set(['-n', '-u', '-s', '-k', '-i', '-o', '-e', '-c', '-C', '-I', '-L', '-P', '-d', '--signal', '--kill-after', '--adjustment', '--unset', '--chdir', '--max-args', '--max-procs', '--replace', '--delimiter']);
    for (; i < argWords.length; i++) {
      const text = argWords[i]!.text;
      if (program === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(text)) continue;
      if (text.startsWith('-')) { if (takesValue.has(text) && program !== 'xargs' || program === 'xargs' && ['-n', '-P', '-I', '-L', '-d', '-s', '-E'].includes(text)) i++; continue; }
      if ((program === 'timeout' || program === 'gtimeout') && /^\d/u.test(text)) continue;
      if (program === 'nice' && /^-?\d+$/u.test(text)) continue;
      break;
    }
    if (i >= argWords.length) { classify(acc, program === 'xargs' ? 'unknown' : 'read_only', program, args); return cwd; }
    // xargs appends stdin to the command: its targets are not known.
    if (program === 'xargs') acc.flags.unresolvedVariables = true;
    const innerWords = argWords.slice(i);
    const innerProgram = programName(innerWords[0]!.text);
    if (program === 'xargs' && ['rm', 'rmdir', 'unlink', 'shred', 'del', 'remove-item'].includes(innerProgram) && innerWords.some(word => /^-[a-z]*r|^--recursive$|^\/s$/iu.test(word.text))) acc.flags.rmUnresolved = true;
    return analyzeArgv(innerWords, cwd, acc, program === 'xargs' ? { pipeIn: false, heredoc: null } : stdin, downloadedHere);
  }

  if (program === 'cd' || program === 'pushd' || program === 'chdir' || program === 'set-location' || program === 'sl') {
    classify(acc, 'read_only');
    const dest = positional()[0];
    if (!dest) return acc.ctx.home;
    if (dest.text === '-') return null;
    const where = target(dest);
    return where.abs;
  }
  if (program === 'popd') return null;

  if (EVAL_WORDS.has(program)) {
    classify(acc, 'unknown', program, []);
    if (program !== 'eval' || substituted || argWords.some(word => word.vars.length) || stdin.pipeIn) {
      acc.flags.evalGenerated = true;
      if (stdin.pipeIn || innerFetch) acc.flags.pipeToShell = true;
      return cwd;
    }
    return analyzeText(args.join(' '), cwd, acc);
  }

  if (program === 'source' || program === '.') {
    const file = positional()[0];
    if (!file) { acc.flags.evalGenerated = true; return cwd; }
    if (file.substitution) { acc.flags.evalGenerated = true; if (innerFetch) acc.flags.downloadExec = true; return cwd; }
    const script = target(file);
    acc.sourced.push(script);
    classify(acc, 'build_test', program, []);
    return cwd;
  }

  if (SHELLS.has(program) || POWERSHELLS.has(program) || program === 'cmd') return runShell(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);
  if (INTERPRETERS.has(program)) return runInterpreter(program, argWords, cwd, acc, stdin, downloadedHere, innerFetch);

  // A program named by path: inside the project it is a project script; outside, a system program by its name.
  if (/[\\/]/u.test(argv0)) {
    const file = target(argvWords[0]!);
    if (file.where === 'inside') { runScript(file, acc, program, args, downloadedHere); return cwd; }
    if (file.where === 'unresolved' || !/^(?:\/usr\/|\/bin\/|\/sbin\/|\/opt\/homebrew\/|\/opt\/local\/|\/System\/|\/Library\/Developer\/|[A-Za-z]:[\\/]windows[\\/])/iu.test(file.abs ?? '')) {
      acc.flags.runsOutsideScript = true;
      classify(acc, 'unknown', program, args);
      return cwd;
    }
  }

  classifyProgram(program, argWords, cwd, acc, stdin, downloadedHere);
  return cwd;
}

function fetchesIn(text: string): boolean {
  return /(?:^|[\s;|&(`])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch|http|aria2c|lwp-download)(?:\.exe)?(?=\s|$)/iu.test(text);
}

function runScript(file: Target, acc: Acc, program: string, args: readonly string[], downloadedHere: Target[]): void {
  if (downloadedHere.some(item => item.abs && item.abs === file.abs)) acc.flags.downloadExec = true;
  if (file.where !== 'inside') { acc.flags.runsOutsideScript = true; classify(acc, 'unknown', program, args); return; }
  acc.scripts.push(file);
  classify(acc, 'build_test', program, args);
}

function runShell(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  const powershell = POWERSHELLS.has(program);
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    const lower = text.toLowerCase();
    if (powershell && /^-(?:e|ec|enc|encodedcommand|encoded)$/iu.test(text)) { acc.flags.encoded = true; classify(acc, 'unknown', program, args); return cwd; }
    const inline = program === 'cmd' ? /^\/[ck]$/iu.test(text) : powershell ? /^-(?:c|command)$/iu.test(text) : /^-[a-z]*c[a-z]*$/u.test(text) && !text.startsWith('--');
    if (inline) {
      const rest = program === 'cmd' || powershell ? args.slice(i + 1).join(' ') : args[i + 1];
      if (rest === undefined || argWords[i + 1]?.substitution && program !== 'cmd') {
        acc.flags.evalGenerated = true;
        if (innerFetch) acc.flags.downloadExec = true;
        classify(acc, 'unknown', program, args);
        return cwd;
      }
      if (innerFetch) acc.flags.downloadExec = true;
      analyzeText(rest, cwd, acc);
      return cwd;
    }
    if (powershell && /^-(?:f|file)$/iu.test(text)) {
      const file = argWords[i + 1];
      if (!file) break;
      runScript(resolveTarget(file, cwd, acc.ctx), acc, program, args, downloadedHere);
      return cwd;
    }
    if (lower === '-s' && !powershell) break;
    if (isFlag(text, program === 'cmd')) { if (/^--?(?:rcfile|init-file|o)$/u.test(text)) i++; continue; }
    if (powershell && /^-/u.test(text)) continue;
    // The first operand is a script file; the rest are its arguments.
    const file = argWords[i]!;
    if (file.substitution) {
      // bash <(curl …): a download run as a script.
      acc.flags.evalGenerated = true;
      if (innerFetch) acc.flags.downloadExec = true;
      classify(acc, 'unknown', program, args);
      return cwd;
    }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, program, args, downloadedHere);
    return cwd;
  }
  // No script: the shell reads stdin.
  if (stdin.pipeIn) { acc.flags.pipeToShell = true; classify(acc, 'unknown', program, args); return cwd; }
  if (stdin.heredoc !== null) { analyzeText(stdin.heredoc, cwd, acc); return cwd; }
  // An interactive shell.
  classify(acc, 'unknown', program, args);
  return cwd;
}

const PYTHON_MODULES: Readonly<Record<string, ActionClass>> = {
  pytest: 'build_test', unittest: 'build_test', mypy: 'build_test', black: 'edit_in_project', ruff: 'build_test', flake8: 'build_test', pylint: 'build_test', isort: 'edit_in_project',
  pip: 'install_deps', venv: 'edit_in_project', 'http.server': 'process', json: 'read_only', 'json.tool': 'read_only', tox: 'build_test', nox: 'build_test', build: 'build_test', coverage: 'build_test'
};

function runInterpreter(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[], innerFetch: boolean): string | null {
  const args = argWords.map(word => word.text);
  if (args.length === 1 && /^(?:--?version|-v|-V)$/u.test(args[0]!)) { classify(acc, 'read_only', program, args); return cwd; }
  const python = program.startsWith('python') || program.startsWith('pypy');
  for (let i = 0; i < argWords.length; i++) {
    const text = args[i]!;
    if (python && text === '-m') {
      const module = args[i + 1] ?? '';
      const cls = PYTHON_MODULES[module] ?? 'unknown';
      if (module === 'pip') { classifyInstall('pip', args.slice(i + 2), acc); return cwd; }
      if (cls === 'build_test') addBuildFiles(module, acc);
      classify(acc, cls, program, args, module.replace(/\..*$/u, ''));
      return cwd;
    }
    if (/^(?:-c|-e|--eval|-p|--print|-r|-E)$/u.test(text) || program === 'deno' && text === 'eval' || program === 'osascript' && text === '-e') {
      acc.flags.inlineCode = true;
      if (innerFetch) acc.flags.downloadExec = true;
      if (argWords[i + 1] && fetchesIn(args[i + 1]!) && /\b(?:exec|eval|system|spawn|child_process|subprocess|os\.system)\b/u.test(args[i + 1]!)) acc.flags.downloadExec = true;
      classify(acc, 'unknown', program, args);
      return cwd;
    }
    if (text.startsWith('-')) { if (/^(?:-W|-X|--require|-r|--import|--loader|-I)$/u.test(text)) i++; continue; }
    if (program === 'deno' || program === 'bun') {
      if (['run', 'x', 'test', 'task', 'check', 'lint', 'fmt', 'compile', 'build', 'install', 'add'].includes(text)) {
        if (text === 'test' || text === 'check' || text === 'lint' || text === 'build' || text === 'compile') { addBuildFiles(program, acc); classify(acc, 'build_test', program, args, text); return cwd; }
        if (text === 'fmt') { classify(acc, 'edit_in_project', program, args, text); return cwd; }
        if (text === 'install' || text === 'add' || text === 'x') { acc.network = acc.network === 'upload' ? 'upload' : 'download'; classify(acc, 'install_deps', program, args, text); return cwd; }
        if (text === 'task' || program === 'bun' && text === 'run' && argWords[i + 1] && !/[./\\]/u.test(args[i + 1]!)) {
          const name = args[i + 1];
          if (name) acc.npmScripts.add(name);
          acc.buildFiles.add(program === 'deno' ? 'deno.json' : 'package.json');
          classify(acc, 'build_test', program, args, text);
          return cwd;
        }
        continue;
      }
    }
    const file = argWords[i]!;
    if (file.substitution) { acc.flags.evalGenerated = true; if (innerFetch) acc.flags.downloadExec = true; classify(acc, 'unknown', program, args); return cwd; }
    if (/^https?:\/\//iu.test(file.text)) { acc.flags.downloadExec = true; classify(acc, 'unknown', program, args); return cwd; }
    runScript(resolveTarget(file, cwd, acc.ctx), acc, program, args, downloadedHere);
    return cwd;
  }
  if (stdin.pipeIn) { acc.flags.pipeToShell = true; classify(acc, 'unknown', program, args); return cwd; }
  if (stdin.heredoc !== null) { acc.flags.inlineCode = true; classify(acc, 'unknown', program, args); return cwd; }
  classify(acc, 'unknown', program, args);
  return cwd;
}

/** The build files a tool executes before or while it runs (§3.1b `build_scripts_modified`). */
const BUILD_FILES: Readonly<Record<string, readonly string[]>> = {
  npm: ['package.json'], yarn: ['package.json'], pnpm: ['package.json'], bun: ['package.json', 'bunfig.toml'], deno: ['deno.json', 'deno.jsonc'],
  make: ['Makefile', 'makefile', 'GNUmakefile'], gmake: ['Makefile', 'makefile', 'GNUmakefile'], just: ['justfile', 'Justfile', '.justfile'], task: ['Taskfile.yml', 'Taskfile.yaml'],
  pytest: ['pyproject.toml', 'setup.cfg', 'tox.ini', 'pytest.ini', 'conftest.py'], tox: ['tox.ini', 'pyproject.toml', 'setup.cfg', 'setup.py'], nox: ['noxfile.py'],
  unittest: ['pyproject.toml', 'setup.cfg'], build: ['pyproject.toml', 'setup.py', 'setup.cfg'], coverage: ['pyproject.toml', 'setup.cfg', '.coveragerc'],
  cargo: ['Cargo.toml', 'build.rs'], gradle: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew'], gradlew: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  mvn: ['pom.xml'], mvnw: ['pom.xml'], cmake: ['CMakeLists.txt'], ninja: ['build.ninja'], meson: ['meson.build'], rake: ['Rakefile'], bundle: ['Gemfile', 'Rakefile'],
  jest: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'package.json'], vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts', 'vite.config.js'],
  mocha: ['.mocharc.js', '.mocharc.cjs', '.mocharc.json', 'package.json'], playwright: ['playwright.config.ts', 'playwright.config.js'], go: ['go.mod'], dotnet: [], swift: ['Package.swift'], mix: ['mix.exs'], sbt: ['build.sbt'], xcodebuild: []
};

function addBuildFiles(tool: string, acc: Acc): void { for (const file of BUILD_FILES[tool] ?? []) acc.buildFiles.add(file); }

const NPM_LIKE = new Set(['npm', 'yarn', 'pnpm']);
const NPM_INSTALL = new Set(['i', 'install', 'ci', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'dedupe', 'link', 'unlink', 'rebuild', 'prune', 'import', 'dlx', 'exec', 'x', 'create', 'init']);
const NPM_READ = new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'search', 'why', 'explain', 'config', 'help', 'version', 'root', 'prefix', 'bin', 'doctor', 'audit', 'fund', 'pack', 'query']);

function classifyInstall(tool: string, args: readonly string[], acc: Acc): void {
  const global = args.some(arg => ['-g', '--global', '--user', '--system', '--break-system-packages', '--root', '--target', '--prefix'].includes(arg) || arg.startsWith('--prefix=') || arg.startsWith('--target='));
  acc.network = acc.network === 'upload' ? 'upload' : 'download';
  // A global install changes the computer outside the project: person only.
  classify(acc, global ? 'system' : 'install_deps', tool, [...args], args.find(arg => !arg.startsWith('-')));
}

function classifyProgram(program: string, argWords: Word[], cwd: string | null, acc: Acc, stdin: Stdin, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const windows = WINDOWS_BUILTINS.has(program) || args.some(arg => /^\/[sq]$/iu.test(arg));
  const positional = argWords.filter(word => !isFlag(word.text, windows));
  const target = (word: Word | string): Target => resolveTarget(word, cwd, acc.ctx);
  const sub = positional[0]?.text;

  // Disks.
  if (DISK.has(program) || program.startsWith('mkfs') || program.startsWith('newfs')) { acc.flags.disk = true; classify(acc, 'system', program, args); return; }
  if (program === 'diskutil') {
    if (/^(?:erase|zero|random|secure|partition|reformat|apfs|cs|appleraid|ar|resetfusion|repairdisk|mergepartitions|splitpartition|resizevolume|addpartition)/iu.test(sub ?? '') || /^(?:deletecontainer|deletevolume|erasevolume)$/iu.test(positional[1]?.text ?? '')) acc.flags.disk = true;
    classify(acc, 'system', program, args, sub?.toLowerCase());
    return;
  }
  if (program === 'format' && positional.some(word => /^[A-Za-z]:\\?$/u.test(word.text))) { acc.flags.disk = true; classify(acc, 'system', program, args); return; }
  if (program === 'cipher' && args.some(arg => /^\/w/iu.test(arg))) { acc.flags.disk = true; classify(acc, 'system', program, args); return; }
  if (program === 'dd') {
    for (const arg of args) {
      const m = /^(if|of)=(.*)$/u.exec(arg);
      if (!m) continue;
      const t = target(m[2]!);
      if (m[1] === 'of') { if (t.device || /^\/dev\//u.test(m[2]!) && !HARMLESS_DEVICE.test(m[2]!)) acc.flags.disk = true; else acc.writes.push(t); }
      else if (!t.device && !HARMLESS_DEVICE.test(m[2]!)) acc.reads.push(t);
    }
    classify(acc, 'edit_in_project', program, args);
    return;
  }
  if (POWER.has(program) && !(program === 'init' && !/^[06]$/u.test(sub ?? ''))) { acc.flags.power = true; classify(acc, 'system', program, args); return; }

  if (REMOTE.has(program) || program === 'rsync' && positional.some(word => /^[^/\\]*:/u.test(word.text) && !/^[A-Za-z]:[\\/]/u.test(word.text))) {
    acc.network = 'upload';
    classify(acc, 'outside_project', program, args);
    for (const word of positional) if (!/:/u.test(word.text)) { const t = target(word); if (t.credential) acc.flags.credentialAccess = true; }
    return;
  }
  if (CREDENTIAL_TOOLS.has(program)) { acc.flags.credentialAccess = true; classify(acc, 'credentials', program, args, sub); return; }
  if (SYSTEM_TOOLS.has(program)) {
    if (program === 'brew' || ['apt', 'apt-get', 'yum', 'dnf', 'zypper', 'pacman', 'apk', 'port', 'choco', 'winget', 'scoop', 'snap', 'flatpak', 'pipx', 'mas'].includes(program)) acc.network = acc.network === 'upload' ? 'upload' : 'download';
    if ((program === 'systemctl' && /^(?:reboot|poweroff|halt|suspend|hibernate)$/u.test(sub ?? '')) || (program === 'pmset' && sub === 'sleepnow')) acc.flags.power = true;
    if (program === 'sqlite3') { classify(acc, 'unknown', program, args); return; }
    classify(acc, 'system', program, args, sub?.toLowerCase());
    return;
  }
  if (PUBLISH_TOOLS.has(program)) { acc.network = 'upload'; classify(acc, 'publish', program, args, sub); return; }

  if (program === 'git') { classifyGit(argWords, cwd, acc); return; }
  if (program === 'gh') {
    acc.network = acc.network === 'upload' ? 'upload' : 'download';
    const verb = positional[1]?.text;
    if (sub === 'auth' || sub === 'secret' || sub === 'ssh-key' || sub === 'gpg-key') { acc.flags.credentialAccess = true; classify(acc, 'credentials', program, args, sub); return; }
    if (sub === 'api' ? args.some(arg => /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u.test(arg)) : /^(?:create|merge|close|delete|edit|comment|review|reopen|ready|upload|run|enable|disable|set|fork|rename|archive|transfer|sync|lock|pin|transfer|develop)$/u.test(verb ?? '')) {
      acc.network = 'upload'; classify(acc, 'publish', program, args, sub); return;
    }
    classify(acc, 'network_read', program, args, sub);
    return;
  }
  if (NPM_LIKE.has(program) || program === 'bun') {
    const verb = sub ?? (program === 'yarn' ? 'install' : '');
    if (verb === 'publish' || verb === 'deprecate' || verb === 'unpublish' || verb === 'dist-tag' || verb === 'owner' || verb === 'access' || verb === 'team') { acc.network = 'upload'; classify(acc, 'publish', program, args, verb); return; }
    if (verb === 'login' || verb === 'adduser' || verb === 'token' || verb === 'logout' || verb === 'whoami') { acc.flags.credentialAccess = true; classify(acc, 'credentials', program, args, verb); return; }
    if (program === 'yarn' && verb === 'global' || args.includes('-g') || args.includes('--global') || args.includes('--location=global')) { classifyInstall(program, args, acc); return; }
    if (NPM_INSTALL.has(verb)) {
      if (verb === 'exec' || verb === 'x' || verb === 'dlx' || verb === 'create' || verb === 'init') acc.flags.inlineCode = acc.flags.inlineCode || verb !== 'init';
      classifyInstall(program, args.filter(arg => arg !== verb), acc);
      return;
    }
    if (NPM_READ.has(verb)) {
      if (verb === 'config' && /^(?:set|delete|edit|fix)$/u.test(positional[1]?.text ?? '')) { classify(acc, 'system', program, args, verb); return; }
      if (verb === 'audit' && args.includes('fix')) { classifyInstall(program, args, acc); return; }
      if (['view', 'info', 'show', 'outdated', 'search', 'audit', 'doctor'].includes(verb)) acc.network = acc.network === 'upload' ? 'upload' : 'download';
      classify(acc, 'read_only', program, args, verb);
      return;
    }
    if (verb === 'pkg') { classify(acc, positional[1]?.text === 'get' ? 'read_only' : 'edit_in_project', program, args, verb); return; }
    // test, start, run X, run-script X, a bare yarn/pnpm script name: runs package.json scripts.
    const script = verb === 'run' || verb === 'run-script' || verb === 'rum' ? positional[1]?.text : verb === 't' || verb === 'tst' ? 'test' : verb;
    if (script) acc.npmScripts.add(script);
    addBuildFiles(program, acc);
    if (script === 'test' || verb === 'test' || verb === 't') for (const file of ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js', '.mocharc.js', 'playwright.config.ts']) acc.buildFiles.add(file);
    classify(acc, 'build_test', program, args, verb === 'run' || verb === 'run-script' ? 'run' : verb);
    return;
  }
  if (program === 'npx' || program === 'bunx' || program === 'pnpx') { acc.network = acc.network === 'upload' ? 'upload' : 'download'; acc.flags.inlineCode = true; classify(acc, 'install_deps', program, args, sub); return; }
  if (['pip', 'pip3', 'poetry', 'uv', 'pipenv', 'conda', 'mamba', 'composer', 'gem', 'cpan', 'cpanm', 'pod', 'carthage'].includes(program)) {
    if (['list', 'show', 'freeze', 'check', 'search', 'config', 'env', 'info', 'outdated', 'tree', '--version', 'help'].includes(sub ?? '')) { classify(acc, 'read_only', program, args, sub); return; }
    if (program === 'poetry' && sub === 'publish' || program === 'gem' && sub === 'push' || program === 'uv' && sub === 'publish') { acc.network = 'upload'; classify(acc, 'publish', program, args, sub); return; }
    if (program === 'uv' && sub === 'run' || program === 'poetry' && sub === 'run' || program === 'pipenv' && sub === 'run' || program === 'conda' && sub === 'run') {
      const inner = argWords.slice(argWords.findIndex(word => word.text === 'run') + 1).filter((word, index, all) => index > 0 || !word.text.startsWith('-') || all.length === 1);
      const start = inner.findIndex(word => !word.text.startsWith('-'));
      if (start >= 0) analyzeArgv(inner.slice(start), cwd, acc, stdin, downloadedHere); else classify(acc, 'unknown', program, args, sub);
      return;
    }
    if (program === 'gem' && sub === 'install' || program === 'conda' && sub === 'create') { classifyInstall(program, ['--global', ...args], acc); return; }
    classifyInstall(program, args, acc);
    return;
  }
  if (program === 'cargo') {
    if (sub === 'publish' || sub === 'yank' || sub === 'owner' || sub === 'login') { acc.network = 'upload'; classify(acc, sub === 'login' ? 'credentials' : 'publish', program, args, sub); return; }
    if (sub === 'install') { classifyInstall(program, ['--global', ...args], acc); return; }
    if (sub === 'add' || sub === 'fetch' || sub === 'update' || sub === 'remove' || sub === 'generate-lockfile') { classifyInstall(program, args, acc); return; }
    if (sub === 'fmt') { classify(acc, 'edit_in_project', program, args, sub); return; }
    if (sub === 'clean') { classify(acc, 'delete', program, args, sub); return; }
    addBuildFiles('cargo', acc);
    classify(acc, 'build_test', program, args, sub);
    return;
  }
  if (program === 'go') {
    if (sub === 'install') { classifyInstall(program, ['--global', ...args], acc); return; }
    if (sub === 'get' || sub === 'mod' && positional[1]?.text !== 'graph' && positional[1]?.text !== 'why') { classifyInstall(program, args, acc); return; }
    if (sub === 'fmt') { classify(acc, 'edit_in_project', program, args, sub); return; }
    if (sub === 'generate') { acc.flags.inlineCode = true; classify(acc, 'unknown', program, args, sub); return; }
    if (sub === 'version' || sub === 'env' || sub === 'list' || sub === 'doc' || sub === 'help') { classify(acc, 'read_only', program, args, sub); return; }
    addBuildFiles('go', acc);
    classify(acc, 'build_test', program, args, sub);
    return;
  }
  const BUILD_TOOLS = ['make', 'gmake', 'just', 'task', 'cmake', 'ninja', 'meson', 'bazel', 'bazelisk', 'buck', 'buck2', 'gradle', 'gradlew', 'mvn', 'mvnw', 'ant', 'sbt', 'lein', 'mix', 'rustc', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'c++', 'javac', 'kotlinc', 'tsc', 'swiftc', 'xcodebuild', 'dotnet', 'msbuild', 'pytest', 'py.test', 'tox', 'nox', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'playwright', 'cypress', 'eslint', 'prettier', 'black', 'ruff', 'flake8', 'mypy', 'pyright', 'pylint', 'rubocop', 'rspec', 'rake', 'bundle', 'hatch', 'pdm', 'turbo', 'nx', 'lerna', 'vite', 'webpack', 'rollup', 'esbuild', 'parcel', 'next', 'nuxt', 'astro', 'svelte-kit', 'storybook', 'biome', 'stylelint', 'shellcheck', 'hadolint', 'golangci-lint', 'clippy-driver', 'gofmt', 'rustfmt', 'clang-format', 'isort', 'autopep8', 'yapf', 'ktlint', 'swiftlint', 'swiftformat', 'terraform-fmt'];
  if (BUILD_TOOLS.includes(program)) {
    const writesFiles = (program === 'prettier' && args.some(arg => arg === '--write' || arg === '-w')) || (program === 'eslint' || program === 'biome' || program === 'stylelint' || program === 'ruff' || program === 'rubocop') && args.some(arg => /^--fix|^-a$|^--apply|^--write|^-A$/u.test(arg))
      || ['black', 'isort', 'autopep8', 'yapf', 'rustfmt', 'swiftformat'].includes(program) && !args.some(arg => arg === '--check' || arg === '--diff') || (program === 'gofmt' || program === 'clang-format') && args.includes('-i') || program === 'ruff' && sub === 'format' && !args.includes('--check');
    if (program === 'bundle' && (sub === 'install' || sub === 'update' || sub === 'add')) { classifyInstall(program, args, acc); return; }
    if (program === 'bundle' && sub === 'exec') { const start = argWords.findIndex(word => word.text === 'exec'); if (argWords[start + 1]) analyzeArgv(argWords.slice(start + 1), cwd, acc, stdin, downloadedHere); return; }
    if (program === 'dotnet' && (sub === 'add' || sub === 'restore' || sub === 'tool')) { classifyInstall(program, args, acc); return; }
    if ((program === 'dotnet' && sub === 'nuget') || (program === 'mvn' || program === 'mvnw' || program === 'gradle' || program === 'gradlew') && args.some(arg => /^(?:deploy|publish|release:perform)$/u.test(arg))) { acc.network = 'upload'; classify(acc, 'publish', program, args, sub); return; }
    if (program === 'make' || program === 'gmake') { const dir = args.findIndex(arg => arg === '-C' || arg === '--directory'); if (dir >= 0 && args[dir + 1]) { const t = target(args[dir + 1]!); if (t.where !== 'inside') acc.flags.runsOutsideScript = true; } if (args.some(arg => arg === '-f' || arg.startsWith('--file') || arg.startsWith('--makefile'))) acc.flags.inlineCode = true; }
    addBuildFiles(program, acc);
    classify(acc, writesFiles ? 'edit_in_project' : 'build_test', program, args, sub && /^[a-z]/u.test(sub) ? sub : undefined);
    return;
  }
  if (program === 'docker' || program === 'podman' || program === 'nerdctl' || program === 'docker-compose') {
    if (sub === 'push' || sub === 'login') { acc.network = 'upload'; classify(acc, sub === 'login' ? 'credentials' : 'publish', program, args, sub); return; }
    if (sub === 'build' || sub === 'buildx') { acc.buildFiles.add('Dockerfile'); acc.network = acc.network === 'upload' ? 'upload' : 'download'; classify(acc, 'build_test', program, args, sub); return; }
    if (sub === 'ps' || sub === 'images' || sub === 'logs' || sub === 'inspect' || sub === 'version' || sub === 'info' || sub === 'stats') { classify(acc, 'read_only', program, args, sub); return; }
    if (sub === 'pull') { acc.network = acc.network === 'upload' ? 'upload' : 'download'; classify(acc, 'network_read', program, args, sub); return; }
    // run/exec/compose: a container can mount anything; the model reads the flags.
    classify(acc, 'process', program, args, sub);
    return;
  }

  // Deleting.
  if (['rm', 'unlink', 'shred', 'trash', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf', 'srm'].includes(program)) {
    const recursive = args.some(arg => /^-[a-zA-Z]*[rR]/u.test(arg) || arg === '--recursive' || /^\/s$/iu.test(arg) || /^-recurse$/iu.test(arg)) || program === 'rimraf' || program === 'rd';
    const targets = positional.filter(word => !/^-/u.test(word.text));
    for (const word of targets) {
      const t = resolveTarget(word, cwd, acc.ctx, true);
      if (t.where === 'unresolved' && recursive) acc.flags.rmUnresolved = true;
      if (program === 'shred' && t.device) acc.flags.disk = true;
      acc.deletes.push(t);
    }
    if (!targets.length && stdin.pipeIn) acc.flags.rmUnresolved = acc.flags.rmUnresolved || recursive;
    classify(acc, 'delete', program, args);
    return;
  }
  if (program === 'find') {
    const starts: Word[] = [];
    let i = 0;
    for (; i < argWords.length && !/^[-(!]/u.test(argWords[i]!.text); i++) starts.push(argWords[i]!);
    if (!starts.length) starts.push(wordOf('.'));
    const deleting = args.includes('-delete');
    const exec = args.findIndex(arg => /^-(?:exec|execdir|ok|okdir)$/u.test(arg));
    if (args.some(arg => /^-(?:fprint|fprint0|fprintf|fls)$/u.test(arg))) { const at = args.findIndex(arg => /^-f(?:print0?|printf|ls)$/u.test(arg)); if (args[at + 1]) acc.writes.push(target(args[at + 1]!)); }
    // The start folders are the scope of the deletion, not deleted themselves.
    if (deleting) { for (const start of starts) acc.deletes.push({ ...target(start), root: false }); classify(acc, 'delete', program, args); return; }
    if (exec >= 0) {
      const end = args.findIndex((arg, index) => index > exec && (arg === ';' || arg === '+' || arg === '\\;'));
      const inner = argWords.slice(exec + 1, end < 0 ? undefined : end).map(word => word.text === '{}' ? starts[0]! : word);
      if (inner.length) analyzeArgv(inner, cwd, acc, { pipeIn: false, heredoc: null }, downloadedHere);
      return;
    }
    for (const start of starts) acc.reads.push(target(start));
    classify(acc, 'read_only', program, args);
    return;
  }

  // Writing.
  if (['cp', 'install', 'ln', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'mklink', 'ditto', 'rsync', 'scp-local'].includes(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    const dest = files.length > 1 ? files[files.length - 1]! : program === 'install' && args.includes('-d') ? files[0] : undefined;
    if (dest) acc.writes.push(target(dest));
    for (const word of files.slice(0, dest ? -1 : undefined)) { const t = target(word); if (program === 'ln' && args.some(arg => /^-[a-z]*s/u.test(arg))) continue; acc.reads.push(t); }
    classify(acc, 'edit_in_project', program, args);
    return;
  }
  if (['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni'].includes(program)) {
    // A move changes both ends (a moved symlink is the link itself; the destination may be a folder it enters).
    const files = positional.filter(word => !/^-/u.test(word.text));
    files.forEach((word, index) => acc.writes.push(index < files.length - 1 ? resolveTarget(word, cwd, acc.ctx, true) : target(word)));
    classify(acc, 'edit_in_project', program, args);
    return;
  }
  if (['touch', 'mkdir', 'md', 'truncate', 'tee', 'new-item', 'ni', 'set-content', 'sc-content', 'add-content', 'ac', 'out-file', 'mkfifo', 'mktemp', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', 'zstd'].includes(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text));
    if (program === 'truncate') { const size = args.findIndex(arg => arg === '-s'); if (size >= 0) files.splice(files.findIndex(word => word.text === args[size + 1]), 1); }
    if (program === 'mktemp') { if (files.length) acc.writes.push(target(files[0]!)); else acc.writes.push(target(acc.ctx.temp)); }
    else for (const word of files) acc.writes.push(target(word));
    classify(acc, 'edit_in_project', program, args);
    return;
  }
  if (['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'attrib', 'icacls', 'takeown'].includes(program)) {
    const files = positional.filter(word => !/^-/u.test(word.text)).slice(program === 'attrib' || program === 'icacls' || program === 'takeown' ? 0 : 1);
    for (const word of files) acc.writes.push(target(word));
    classify(acc, 'edit_in_project', program, args);
    return;
  }
  if (program === 'sed' || program === 'perl' || program === 'gsed') {
    const inPlace = args.some(arg => /^-[a-zA-Z]*i/u.test(arg) || arg.startsWith('--in-place'));
    const explicitScript = args.some(arg => arg === '-e' || arg === '-f' || arg.startsWith('--expression'));
    const files = positional.filter(word => !/^-/u.test(word.text)).slice(explicitScript ? 0 : 1);
    const script = explicitScript ? args[args.findIndex(arg => arg === '-e') + 1] ?? '' : positional[0]?.text ?? '';
    if (program !== 'sed' && program !== 'gsed') { acc.flags.inlineCode = true; for (const word of files) (inPlace ? acc.writes : acc.reads).push(target(word)); classify(acc, 'unknown', program, args); return; }
    // sed's `w file`, `W file` and `e command` write or run: not a plain read.
    const runsOrWrites = /(?:^|[;{}\n]|\d|\/[gpIiMm0-9]*)\s*[wWe](?:\s|$)|\/[gpIiMm0-9]*[wWe]\s/u.test(script);
    for (const word of files) (inPlace ? acc.writes : acc.reads).push(target(word));
    classify(acc, runsOrWrites ? 'unknown' : inPlace ? 'edit_in_project' : 'read_only', program, args);
    return;
  }
  if (program === 'awk' || program === 'gawk' || program === 'mawk' || program === 'nawk') {
    const script = positional[0]?.text ?? '';
    for (const word of positional.slice(1)) acc.reads.push(target(word));
    classify(acc, /system\s*\(|\|\s*"|getline|>\s*"|print\s*>|printf\s*>/u.test(script) ? 'unknown' : 'read_only', program, args);
    return;
  }
  if (program === 'patch' || program === 'apply_patch' || program === 'git-apply') { classify(acc, 'edit_in_project', program, args); return; }
  if (program === 'tar' || program === 'bsdtar' || program === 'unzip' || program === '7z' || program === 'unrar') {
    const extract = program === 'unzip' || program === 'unrar' || program === '7z' && sub === 'x' || /^-?[a-zA-Z]*x/u.test(args[0] ?? '') || args.includes('--extract') || args.includes('-x');
    const dirFlag = args.findIndex(arg => arg === '-C' || arg === '--directory' || arg === '-d' || arg.startsWith('-o'));
    const dest = dirFlag >= 0 ? (args[dirFlag]!.startsWith('-o') && args[dirFlag]!.length > 2 ? args[dirFlag]!.slice(2) : args[dirFlag + 1]) : '.';
    if (extract && dest) acc.writes.push(target(dest));
    const fileFlag = args.findIndex(arg => /^-?[a-zA-Z]*f$/u.test(arg) || arg === '--file');
    if (!extract && fileFlag >= 0 && args[fileFlag + 1]) acc.writes.push(target(args[fileFlag + 1]!));
    classify(acc, extract ? 'edit_in_project' : 'read_only', program, args);
    return;
  }

  // Network.
  if (FETCHERS.has(program) || NETWORK_READ_TOOLS.has(program)) {
    if (NETWORK_READ_TOOLS.has(program)) { acc.network = acc.network === 'upload' ? 'upload' : 'download'; classify(acc, 'network_read', program, args); return; }
    classifyFetch(program, argWords, cwd, acc, downloadedHere);
    return;
  }

  // Processes.
  if (program === 'kill' || program === 'pkill' || program === 'killall' || program === 'taskkill' || program === 'stop-process' || program === 'spps') {
    if (program === 'kill' && positional.some(word => /^-1$/u.test(word.text)) || args.some(arg => arg === '-1')) acc.flags.killAll = true;
    classify(acc, 'process', program, args);
    return;
  }
  if (['open', 'xdg-open', 'start', 'start-process', 'saps', 'pm2', 'screen', 'tmux', 'nodemon', 'forever', 'serve', 'http-server', 'live-server', 'ngrok', 'cloudflared'].includes(program)) {
    if (program === 'ngrok' || program === 'cloudflared') acc.network = 'upload';
    classify(acc, program === 'ngrok' || program === 'cloudflared' ? 'publish' : 'process', program, args, sub);
    return;
  }

  if (READ_ONLY.has(program)) {
    if (!NO_PATH_ARGS.has(program)) {
      const files = positional.filter(word => !/^-/u.test(word.text)).slice(PATTERN_FIRST.has(program) && !args.some(arg => arg === '-e' || arg === '-f' || arg === '--regexp') ? 1 : 0);
      for (const word of files) acc.reads.push(target(word));
      if (program === 'rg' && args.some(arg => arg.startsWith('--pre') || arg === '-z' || arg === '--search-zip')) { classify(acc, 'unknown', program, args); return; }
    }
    classify(acc, 'read_only', program, args);
    return;
  }
  classify(acc, 'unknown', program, args, sub && /^[a-z]/u.test(sub) ? sub : undefined);
}

function isLoopbackUrl(text: string): boolean {
  try { const url = new URL(/^[a-z]+:\/\//iu.test(text) ? text : `http://${text}`); return /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/iu.test(url.hostname); } catch { return false; }
}

function classifyFetch(program: string, argWords: Word[], cwd: string | null, acc: Acc, downloadedHere: Target[]): void {
  const args = argWords.map(word => word.text);
  const target = (word: Word | string): Target => resolveTarget(word, cwd, acc.ctx);
  const urls = args.filter(arg => /^[a-z]+:\/\//iu.test(arg) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/iu.test(arg) || /^localhost[:/]/iu.test(arg));
  const local = urls.length > 0 && urls.every(isLoopbackUrl);
  let upload = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = argWords[i + 1];
    if (/^(?:-d|--data|--data-binary|--data-raw|--data-urlencode|--json|-F|--form|--form-string|-T|--upload-file|--post-data|--post-file|--body-data|--body-file|-body|-infile)$/iu.test(arg) || /^--data/u.test(arg)) {
      upload = true;
      const value = next?.text ?? '';
      const file = arg === '-T' || arg === '--upload-file' || /^--(?:post|body)-file$/u.test(arg) || /^-infile$/iu.test(arg) ? value : value.startsWith('@') ? value.slice(1) : /=@|^@|<@/u.test(value) ? value.replace(/^.*?@/u, '') : null;
      if (file) { const t = target(file); if (t.credential) acc.flags.credentialAccess = true; acc.reads.push(t); }
      i++; continue;
    }
    if (/^(?:-X|--request|-method|--method)$/iu.test(arg) && next && !/^(?:GET|HEAD|OPTIONS)$/iu.test(next.text)) { upload = true; i++; continue; }
    if (/^-X(?:POST|PUT|PATCH|DELETE)$/iu.test(arg)) { upload = true; continue; }
    if ((arg === '-o' || arg === '--output' || arg === '-O' && program === 'wget' || arg === '--output-document' || /^-outfile$/iu.test(arg) || arg === '-P' || arg === '--directory-prefix') && next) {
      const t = target(next); acc.writes.push(t); acc.downloads.push(t); downloadedHere.push(t); i++; continue;
    }
    if (arg === '-O' || arg === '--remote-name' || arg === '--remote-name-all') {
      const url = urls[0];
      const name = url ? url.replace(/[?#].*$/u, '').split('/').pop() || 'index.html' : null;
      const t = name ? target(name) : target('.');
      acc.writes.push(t); acc.downloads.push(t); downloadedHere.push(t);
    }
  }
  if (program === 'wget' && !args.some(arg => /^(?:-O|--output-document|-P|--directory-prefix|--spider|-q-?O-?)$/u.test(arg)) && !args.some(arg => arg === '-O-' || arg === '-qO-')) {
    const url = urls[0];
    const name = url ? url.replace(/[?#].*$/u, '').split('/').pop() || 'index.html' : 'index.html';
    const t = target(name); acc.writes.push(t); acc.downloads.push(t); downloadedHere.push(t);
  }
  if (program === 'nc' || program === 'ncat' || program === 'socat' || program === 'ftp' || program === 'tftp') upload = true;
  if (upload && !local) { acc.network = 'upload'; classify(acc, 'publish', program, args); return; }
  if (acc.network !== 'upload') acc.network = local ? acc.network : 'download';
  classify(acc, local ? 'process' : 'network_read', program, args);
}

function classifyGit(argWords: Word[], cwd: string | null, acc: Acc): void {
  const args = argWords.map(word => word.text);
  let i = 0, dir = cwd;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C') { dir = args[i + 1] ? resolveTarget(argWords[i + 1]!, cwd, acc.ctx).abs : null; i++; continue; }
    if (arg === '-c' || arg.startsWith('--config-env')) { acc.flags.gitConfigOverride = true; if (arg === '-c') i++; continue; }
    if (arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace' || arg === '--exec-path') { acc.flags.gitConfigOverride = true; i++; continue; }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--exec-path=')) { acc.flags.gitConfigOverride = true; continue; }
    if (arg.startsWith('-')) continue;
    break;
  }
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);
  const restWords = argWords.slice(i + 1);
  const where = dir === null ? null : resolveTarget(dir, cwd, acc.ctx);
  const paths = (): Target[] => { const dash = rest.indexOf('--'); return (dash >= 0 ? restWords.slice(dash + 1) : []).map(word => resolveTarget(word, dir, acc.ctx)); };
  const all = ['git', ...args];
  const cls = (value: ActionClass): void => {
    classify(acc, value, 'git', all.slice(1), sub);
    // `git -C <folder outside>`: that repository is read, changed or cleaned.
    if (where && where.where === 'outside') (value === 'read_only' || value === 'network_read' ? acc.reads : value === 'delete' ? acc.deletes : acc.writes).push({ ...where, root: false });
  };
  switch (sub) {
    case 'status': case 'log': case 'diff': case 'show': case 'rev-parse': case 'ls-files': case 'blame': case 'grep': case 'describe': case 'shortlog':
    case 'reflog': case 'cat-file': case 'ls-tree': case 'merge-base': case 'whatchanged': case 'count-objects': case 'var': case 'help': case 'version': case 'annotate': case 'name-rev': case 'show-ref': case 'for-each-ref': case 'check-ignore': case 'cherry': case 'range-diff':
      if (rest.some(arg => arg.startsWith('--output') || arg === '--ext-diff' || arg === '--textconv')) { cls('unknown'); return; }
      if (sub === 'reflog' && /^(?:expire|delete)$/u.test(rest[0] ?? '')) { cls('delete'); return; }
      for (const t of paths()) acc.reads.push(t);
      cls('read_only'); return;
    case 'branch': case 'tag':
      if (!rest.some(arg => !arg.startsWith('-')) || rest.every(arg => /^(?:-a|-r|-v|-vv|--list|-l|--all|--remotes|--show-current|--merged|--no-merged|--contains|--sort=.*|--format=.*|-n\d*)$/u.test(arg) || !arg.startsWith('-') && rest.some(flag => flag === '--list' || flag === '-l'))) { cls('read_only'); return; }
      cls(rest.some(arg => arg === '-D' || arg === '--delete' && rest.includes('--force')) ? 'delete' : 'vcs_local'); return;
    case 'stash':
      if (rest[0] === 'list' || rest[0] === 'show') { cls('read_only'); return; }
      cls(rest[0] === 'drop' || rest[0] === 'clear' ? 'delete' : 'vcs_local'); return;
    case 'remote':
      if (!rest.length || rest.every(arg => arg === '-v' || arg === '--verbose') || rest[0] === 'get-url') { cls('read_only'); return; }
      if (rest[0] === 'show' || rest[0] === 'update' || rest[0] === 'prune') { acc.network = acc.network === 'upload' ? 'upload' : 'download'; cls('network_read'); return; }
      cls('vcs_local'); return;
    case 'config':
      if (rest.some(arg => arg === '--global' || arg === '--system' || arg.startsWith('--file') || arg === '-f')) { cls('system'); return; }
      if (rest.some(arg => /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)$/u.test(arg)) || rest.filter(arg => !arg.startsWith('-')).length === 1) { cls('read_only'); return; }
      // A local config write changes .git/config: a protected path.
      acc.flags.protectedSystem = true; cls('system'); return;
    case 'add': case 'commit': case 'switch': case 'merge': case 'rebase': case 'cherry-pick': case 'revert': case 'mv': case 'init': case 'notes': case 'am': case 'apply': case 'bisect': case 'worktree': case 'sparse-checkout': case 'gc': case 'prune': case 'maintenance': case 'fsck': case 'pack-refs': case 'repack': case 'update-index': case 'format-patch':
      if (sub === 'commit' && rest.some(arg => arg === '--no-verify' || arg === '-n')) acc.flags.gitConfigOverride = true;
      if (sub === 'worktree' && (rest[0] === 'list')) { cls('read_only'); return; }
      if (sub === 'worktree' && rest[0] === 'remove') { cls('delete'); return; }
      if (sub === 'worktree' && rest[0] === 'add') { const target = restWords.slice(1).find(word => !word.text.startsWith('-')); if (target) acc.writes.push(resolveTarget(target, dir, acc.ctx)); }
      cls('vcs_local'); return;
    case 'checkout':
      if (rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force') || rest.some(arg => arg === '-p' || arg === '--patch')) { cls('delete'); return; }
      cls('vcs_local'); return;
    case 'restore':
      cls(rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W') ? 'vcs_local' : 'delete'); return;
    case 'reset':
      cls(rest.some(arg => arg === '--hard' || arg === '--merge' || arg === '--keep') ? 'delete' : 'vcs_local'); return;
    case 'clean': case 'rm':
      for (const word of restWords.filter(word => !word.text.startsWith('-'))) acc.deletes.push(resolveTarget(word, dir, acc.ctx, true));
      cls('delete'); return;
    case 'fetch': case 'pull': case 'ls-remote': case 'submodule': case 'lfs':
      acc.network = acc.network === 'upload' ? 'upload' : 'download';
      if (sub === 'submodule' && (rest[0] === 'status' || rest[0] === 'summary')) { cls('read_only'); return; }
      cls(sub === 'pull' ? worseClass('network_read', 'vcs_local') : 'network_read'); return;
    case 'clone': {
      acc.network = acc.network === 'upload' ? 'upload' : 'download';
      const positional = restWords.filter(word => !word.text.startsWith('-'));
      const url = positional[0]?.text ?? '';
      const destWord = positional[1] ?? wordOf(url.replace(/[?#].*$/u, '').replace(/\.git$/u, '').split(/[/:]/u).pop() || 'repo');
      acc.writes.push(resolveTarget(destWord, dir, acc.ctx));
      cls('network_read'); return;
    }
    case 'push': {
      acc.flags.gitPush = true; acc.network = 'upload';
      if (rest.some(arg => /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|--mirror|--delete|-d|--prune|--all)$/u.test(arg)) || rest.some(arg => /^\+|^:/u.test(arg))) acc.flags.forcePush = true;
      if (rest.some(arg => arg === '--no-verify')) acc.flags.gitConfigOverride = true;
      cls('vcs_remote'); return;
    }
    case 'send-email': case 'request-pull': acc.network = 'upload'; cls('publish'); return;
    case 'filter-branch': case 'filter-repo': case 'replace': acc.flags.historyRewrite = true; cls('delete'); return;
    case 'credential': case 'credential-store': case 'credential-cache': acc.flags.credentialAccess = true; cls('credentials'); return;
    case 'daemon': case 'instaweb': case 'http-backend': cls('process'); return;
    default: cls('unknown');
  }
}

// ---------------------------------------------------------------------------
// The whole request
// ---------------------------------------------------------------------------

export interface FactsInput {
  action: ReviewAction;
  root: string;
  sessionId: string;
  requestTypedByPerson: boolean;
  tracker?: SessionWriteTracker;
  git?: GitRunner | null;
  home?: string;
  agentRoots?: readonly string[];
  signal?: AbortSignal;
}

const TOOL_LABELS: Readonly<Record<string, string>> = { execute: 'Bash', edit: 'Edit', delete: 'Delete', move: 'Move', read: 'Read', search: 'Search', fetch: 'Fetch' };

function freshAcc(ctx: PathContext): Acc {
  return {
    ctx, cls: 'read_only', shape: null, shapeRank: -1, writes: [], deletes: [], reads: [], downloads: [], network: 'none', scripts: [], sourced: [],
    buildFiles: new Set(), npmScripts: new Set(), depth: 0, budget: 64,
    flags: { elevation: false, pipeToShell: false, downloadExec: false, disk: false, forkBomb: false, forcePush: false, historyRewrite: false, rmUnresolved: false, power: false, killAll: false, encoded: false, unterminated: false, evalGenerated: false, runsOutsideScript: false, unresolvedVariables: false, subshell: false, inlineCode: false, background: false, gitConfigOverride: false, gitPush: false, credentialAccess: false, protectedSystem: false }
  };
}

/** Converts an argv array (Codex style `["bash","-lc","…"]`) into one command string. */
export function commandFromArgv(argv: readonly string[]): string { return argv.map(shellQuote).join(' '); }

/**
 * The synchronous part: parse, classify, resolve paths. Git and the session tracker are added by
 * `computeCommandFacts`. Exported for the rules table tests.
 */
export function analyzeAction(action: ReviewAction, root: string, options: { home?: string; agentRoots?: readonly string[]; requestTypedByPerson?: boolean } = {}): CommandFacts {
  return analyzeInternal(action, root, options).facts;
}

function analyzeInternal(action: ReviewAction, root: string, options: { home?: string; agentRoots?: readonly string[]; requestTypedByPerson?: boolean }): { facts: CommandFacts; sourced: Target[]; scripts: Target[] } {
  const ctx = pathContext(root, options.home, options.agentRoots);
  const acc = freshAcc(ctx);
  const commandCwd = action.commandCwd ? resolveTarget(action.commandCwd, ctx.rootReal, ctx) : null;
  const cwd = commandCwd ? commandCwd.abs : ctx.rootReal;
  let truncated = action.inputTruncated;
  let path: string | null = null;
  const kind = action.kind;
  if (kind === 'execute' || kind === null && action.command) {
    if (action.command === null || !action.command.trim()) { acc.flags.unterminated = true; classify(acc, 'unknown', 'unknown'); }
    else {
      if (action.command.length > FIELD_BOUNDS.command) truncated = true;
      analyzeText(action.command, cwd, acc);
    }
  } else {
    const targets = action.paths.map(item => resolveTarget(item, cwd, ctx, kind === 'delete'));
    path = targets.find(t => t.rel !== null)?.rel ?? null;
    if (action.content !== null && action.content.length > FIELD_BOUNDS.command) truncated = true;
    switch (kind) {
      case 'edit': case 'move':
        acc.writes.push(...targets); classify(acc, 'edit_in_project', TOOL_LABELS[kind]!.toLowerCase()); break;
      case 'delete':
        acc.deletes.push(...targets); classify(acc, 'delete', 'delete'); break;
      case 'read': case 'search':
        acc.reads.push(...targets);
        // A read outside the project is not a write, but it is not an ordinary project read either.
        classify(acc, targets.some(t => t.where !== 'inside') ? 'unknown' : 'read_only', kind); break;
      case 'fetch':
        acc.network = 'download'; classify(acc, action.url && isLoopbackUrl(action.url) ? 'process' : 'network_read', 'fetch'); break;
      default:
        classify(acc, 'unknown', 'unknown');
    }
    if (!targets.length && (kind === 'edit' || kind === 'delete' || kind === 'move')) acc.flags.unterminated = true;
  }

  // Path overrides: outside the project, protected places, credentials.
  const writesOutside = acc.writes.some(t => t.where === 'outside' && !t.device && !(t.abs && !t.credential && isAgentServicePath(t.abs, acc.ctx)));
  // Deleting the working folder itself counts as deleting outside it.
  const deletesOutside = acc.deletes.some(t => t.where === 'outside' || t.root);
  const writesUnresolved = acc.writes.some(t => t.where === 'unresolved') || acc.deletes.some(t => t.where === 'unresolved');
  if (writesUnresolved) acc.flags.unresolvedVariables = true;
  if (writesOutside || deletesOutside) acc.cls = worseClass(acc.cls, 'outside_project');
  const protectedWrite = acc.flags.protectedSystem || [...acc.writes, ...acc.deletes].some(t => t.where === 'inside' && t.protected);
  if (protectedWrite) acc.cls = worseClass(acc.cls, 'system');
  const credential = acc.flags.credentialAccess || [...acc.writes, ...acc.deletes, ...acc.reads].some(t => t.credential);
  if (credential) acc.cls = worseClass(acc.cls, 'credentials');
  const readsOutside = acc.reads.some(t => t.where !== 'inside' && !t.device);
  const everything = [...acc.writes, ...acc.deletes, ...acc.reads, ...acc.scripts, ...acc.sourced];
  const stays: CommandFacts['stays'] = writesOutside || deletesOutside || acc.network === 'upload' || acc.cls === 'outside_project' ? 'no'
    : everything.some(t => t.where === 'unresolved') || acc.flags.unresolvedVariables ? 'unknown' : readsOutside ? 'no' : 'yes';
  const deletes: CommandFacts['deletes'] = deletesOutside ? 'outside the project' : acc.deletes.length || acc.cls === 'delete' ? 'inside the project' : 'no';
  const facts: CommandFacts = {
    tool: kind === null ? 'Bash' : TOOL_LABELS[kind] ?? 'Tool', kind, command: kind === 'execute' || kind === null ? action.command : null,
    actionClass: acc.cls, shape: acc.shape ?? { program: 'unknown', flags: [] },
    stays, network: acc.network === 'upload' ? 'sends data to a remote' : acc.network === 'download' ? 'downloads' : 'none', deletes,
    elevation: acc.flags.elevation, pipeToShell: acc.flags.pipeToShell, downloadExec: acc.flags.downloadExec, disk: acc.flags.disk, forkBomb: acc.flags.forkBomb,
    writesOutside, deletesOutside,
    forcePush: acc.flags.forcePush, historyRewrite: acc.flags.historyRewrite, rmUnresolved: acc.flags.rmUnresolved, power: acc.flags.power, killAll: acc.flags.killAll,
    encoded: acc.flags.encoded, unterminated: acc.flags.unterminated,
    evalGenerated: acc.flags.evalGenerated, sourceUntracked: false, runsDownloaded: false, runsOutsideScript: acc.flags.runsOutsideScript,
    unresolvedVariables: acc.flags.unresolvedVariables, subshell: acc.flags.subshell, inlineCode: acc.flags.inlineCode, background: acc.flags.background,
    gitConfigOverride: acc.flags.gitConfigOverride, gitPush: acc.flags.gitPush, protectedWrite, credentialAccess: credential,
    runsChangedScript: false, buildScriptsModified: null, gitTree: 'unknown', truncated,
    requestTypedByPerson: options.requestTypedByPerson ?? false,
    scripts: [...new Set([...acc.scripts, ...acc.sourced].map(t => t.rel).filter((rel): rel is string => rel !== null))],
    changedScripts: [], buildFiles: [...acc.buildFiles], changedBuildFiles: [], npmScripts: [...acc.npmScripts],
    writeTargets: [...acc.writes, ...acc.deletes].map(t => t.abs).filter((abs): abs is string => !!abs),
    downloadTargets: acc.downloads.map(t => t.abs).filter((abs): abs is string => !!abs),
    path
  };
  return { facts, sourced: acc.sourced, scripts: acc.scripts };
}

/**
 * Everything, with git and the session's own writes: which scripts the command runs that the session wrote or
 * that have uncommitted changes, whether the build files it executes changed, whether a sourced file is tracked.
 * Bounded by `REVIEW_LIMITS.factsMs` through the caller's signal; a fact git could not give is taken as risky.
 */
export async function computeCommandFacts(input: FactsInput): Promise<CommandFacts> {
  const { facts, sourced, scripts } = analyzeInternal(input.action, input.root, { ...(input.home ? { home: input.home } : {}), ...(input.agentRoots ? { agentRoots: input.agentRoots } : {}), requestTypedByPerson: input.requestTypedByPerson });
  const signal = input.signal ?? new AbortController().signal;
  const rootReal = realish(resolve(input.root));

  // Files the package.json scripts name (npm run X → node scripts/x.js) are run too.
  const npmFiles = facts.npmScripts.length ? npmScriptFiles(rootReal, facts.npmScripts) : [];
  const runTargets = [...scripts, ...npmFiles.map(rel => resolveTarget(rel, rootReal, pathContext(rootReal, input.home)))];
  const buildTargets = facts.buildFiles.map(file => resolve(rootReal, file)).filter(abs => existsQuiet(abs));

  const git = input.git === null ? null : input.git ?? defaultGit;
  const insideFiles = [...runTargets, ...sourced].filter(t => t.where === 'inside' && t.abs).map(t => t.abs!);
  const state = git ? await gitState(rootReal, [...insideFiles, ...buildTargets, ...npmFiles.map(rel => resolve(rootReal, rel))], git, signal) : null;
  facts.gitTree = !state ? 'unknown' : !state.repo ? 'none' : state.changed.size ? 'dirty' : 'clean';
  const origin = (abs: string | null): WriteOrigin | null => abs && input.tracker ? input.tracker.origin(input.sessionId, abs) : null;
  // Changed: written by the session, not committed, or no way to tell (no git, not a repository).
  const changed = (abs: string | null): boolean => !!abs && (origin(abs) !== null || !state || !state.repo || state.changed.has(realish(abs)));

  for (const t of [...runTargets, ...sourced]) if (origin(t.abs) === 'download') facts.runsDownloaded = true;
  const changedRuns = runTargets.filter(t => t.where === 'inside' && changed(t.abs));
  facts.changedScripts = [...new Set(changedRuns.map(t => t.rel!).filter(Boolean))];
  facts.scripts = [...new Set([...facts.scripts, ...runTargets.map(t => t.rel).filter((rel): rel is string => rel !== null)])];
  facts.runsChangedScript = facts.changedScripts.length > 0 || sourced.some(t => t.where === 'inside' && changed(t.abs));

  // source/. of a file that is not tracked in the project: nobody reviewed what it defines.
  if (sourced.length) facts.sourceUntracked = sourced.some(t => t.where !== 'inside' || !state?.repo || !t.abs || !state.tracked.has(realish(t.abs)) || origin(t.abs) !== null);
  if (facts.buildFiles.length || npmFiles.length) {
    const changedBuild = [...buildTargets.filter(abs => changed(abs)), ...npmFiles.map(rel => resolve(rootReal, rel)).filter(abs => changed(abs))];
    facts.changedBuildFiles = [...new Set(changedBuild.map(abs => relative(rootReal, abs).split(sep).join('/')))];
    // Not a git repository (or git failed): whether they changed cannot be told.
    facts.buildScriptsModified = !state || !state.repo ? true : facts.changedBuildFiles.length > 0;
  }
  return facts;
}

function existsQuiet(path: string): boolean {
  try { realpathSync.native(path); return true; } catch { return false; }
}

