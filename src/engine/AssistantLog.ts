import { createHmac, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_POLICY, type ActionClass, type AssistantMode, type AssistantUseCase, type Band, type BackendFamily, type QualifiedOutcome } from '../shared/catalog.ts';
import type { AssistantBranch, AssistantLabelSource, AssistantVariant } from '../shared/settings.ts';
import type { DataClass } from '../shared/settings.ts';
import type { S1Answer, S1Usage } from '../shared/systemOne.ts';
import { canonicalJson } from './AssistantCache.ts';

/**
 * The decision log (assistant spec §5.7): `userData/assistant/decisions-YYYY-MM.jsonl`, append-only, mode 0600,
 * monthly files, 90 days by default and 50 MB in total (the oldest file goes first). The per-install salt is
 * `userData/assistant/salt` (32 random bytes, 0600).
 *
 * Never logged: task, screen or command text beyond the code-authored `summary`, paths, raw model paths, keys,
 * session ids, error bodies. Records are built field by field from this whitelist; nothing else is written.
 */

export interface DecisionRecordInput {
  id: string; at: number; useCase: AssistantUseCase; mode: AssistantMode;
  catalogVersion: number; questionSetHash: string | null; stateHash: string | null; stateBytes: number;
  fields: { sent: Array<[string, DataClass]>; withheld: Array<[string, DataClass]> };
  dataCheck: { mode: 'strict' | 'warn' | 'off'; grant: 'off' | DataClass; level: { cap: DataClass; source: string } | null; aboveLevel: boolean } | null;
  redactions: number;
  backend: { id: string; preset: string; family: BackendFamily; dialect: string; modelLabel: string | null; resolvedVersion: string | null; pinned: boolean; calibrated: string; T: number } | null;
  requestId: string | null; latencyMs: number | null; attempts: number; cached: boolean;
  usage: S1Usage | null;
  answers: Record<string, S1Answer> | null;
  vendorConfidence: Record<string, number> | null;
  bands: Record<string, Band> | null;
  variant: AssistantVariant | null;
  branch: AssistantBranch; outcome: string | null; qualifiedOutcome: QualifiedOutcome | null;
  actionClass: ActionClass | null; fallbackReason: string | null; truncated: boolean;
  sessionRef: string | null; summary: string | null;
}

export type DecisionRecord = Omit<DecisionRecordInput, 'answers'> & { v: 1; kind: 'decision'; answers: Record<string, unknown> | null };
export interface LabelRecord { v: 1; kind: 'label'; auditId: string; label: string; source: AssistantLabelSource; agrees: boolean; baselineAgrees: boolean | null; at: number }
export type LogRecord = DecisionRecord | LabelRecord;

const round = (value: number): number => Math.round(value * 10 ** LOG_POLICY.decimals) / 10 ** LOG_POLICY.decimals;
const SAFE_NAME = /^[A-Za-z0-9_.@-]{1,64}$/u;
/** A model label as §2.2 makes it (a versioned id, or basename#hash); a raw filesystem path never passes. */
const MODEL_LABEL = /^[A-Za-z0-9~][A-Za-z0-9._/~#@:+-]{0,119}$/u;
const safe = (value: string | null | undefined, max = 64): string | null => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]*$/u.test(value) ? value : null;

function loggedAnswer(answer: S1Answer): Record<string, unknown> {
  if (answer.type === 'noul') return { p: round(answer.p) };
  if (answer.type === 'score') return { level: answer.level, expectation: round(answer.expectation), probabilities: answer.probabilities.map(round) };
  return { choice: answer.choice, probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([label, p]) => [label, round(p)])) };
}

/** The whitelist: every value is a code constant, a class, a hash, a number or the bounded code-authored summary. */
export function decisionRecord(input: DecisionRecordInput): DecisionRecord {
  const fields = (list: Array<[string, DataClass]>): Array<[string, DataClass]> => list.filter(([name]) => SAFE_NAME.test(name)).map(([name, cls]) => [name, cls]);
  return {
    v: 1, kind: 'decision', id: input.id, at: input.at, useCase: input.useCase, mode: input.mode,
    catalogVersion: input.catalogVersion, questionSetHash: safe(input.questionSetHash, 80), stateHash: safe(input.stateHash, 80), stateBytes: Math.max(0, Math.floor(input.stateBytes)),
    fields: { sent: fields(input.fields.sent), withheld: fields(input.fields.withheld) },
    dataCheck: input.dataCheck ? (input.dataCheck.mode === 'off' ? { mode: 'off', grant: input.dataCheck.grant, level: null, aboveLevel: false } : structuredClone(input.dataCheck)) : null,
    redactions: input.redactions,
    backend: input.backend ? { ...input.backend, modelLabel: input.backend.modelLabel && MODEL_LABEL.test(input.backend.modelLabel) ? input.backend.modelLabel : null, resolvedVersion: input.backend.resolvedVersion && MODEL_LABEL.test(input.backend.resolvedVersion) ? input.backend.resolvedVersion : null } : null,
    requestId: safe(input.requestId, 120), latencyMs: input.latencyMs, attempts: input.attempts, cached: input.cached,
    usage: input.usage ? { ...input.usage } : null,
    answers: input.answers ? Object.fromEntries(Object.entries(input.answers).filter(([id]) => SAFE_NAME.test(id)).map(([id, answer]) => [id, loggedAnswer(answer)])) : null,
    vendorConfidence: input.vendorConfidence ? Object.fromEntries(Object.entries(input.vendorConfidence).filter(([id, value]) => SAFE_NAME.test(id) && Number.isFinite(value)).map(([id, value]) => [id, round(value)])) : null,
    bands: input.bands ? { ...input.bands } : null, variant: input.variant,
    branch: input.branch, outcome: safe(input.outcome, 40), qualifiedOutcome: input.qualifiedOutcome,
    actionClass: input.actionClass, fallbackReason: safe(input.fallbackReason, 40), truncated: input.truncated,
    sessionRef: safe(input.sessionRef, 80), summary: typeof input.summary === 'string' ? input.summary.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, LOG_POLICY.summaryMaxChars) : null
  };
}

const FILE = /^decisions-(\d{4})-(\d{2})\.jsonl$/u;

export class AssistantLog {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly retentionDays: () => number;
  private salt: Buffer | null = null;
  private saltLoading: Promise<Buffer> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private lastPrune = 0;

  /** Nothing touches the disk until the first record or read. */
  constructor(options: { directory: string; now?: () => number; retentionDays?: () => number }) {
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
    this.retentionDays = options.retentionDays ?? (() => LOG_POLICY.retentionDays);
  }

  private async ensureSalt(): Promise<Buffer> {
    if (this.salt) return this.salt;
    this.saltLoading ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, 'salt');
      let salt: Buffer;
      try {
        salt = await readFile(path);
        if (salt.length !== 32) throw new Error('bad salt');
      } catch {
        salt = randomBytes(32);
        await writeFile(path, salt, { mode: 0o600 });
      }
      await chmod(path, 0o600).catch(() => undefined);
      this.salt = salt;
      return salt;
    })();
    return this.saltLoading;
  }

  /** `hmac:<hex>` of a value under the per-install salt: joins records without revealing the value. */
  async hmac(value: unknown): Promise<string> {
    const salt = await this.ensureSalt();
    return `hmac:${createHmac('sha256', salt).update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')}`;
  }

  private fileFor(at: number): string {
    const date = new Date(at);
    return join(this.directory, `decisions-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
  }

  append(record: LogRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const write = this.queue.catch(() => undefined).then(async () => {
      await this.ensureSalt();
      const path = this.fileFor(record.at);
      await appendFile(path, line, { mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
      if (this.now() - this.lastPrune > 3_600_000) { this.lastPrune = this.now(); await this.prune(); }
    });
    this.queue = write;
    return write;
  }

  private async files(): Promise<Array<{ name: string; path: string; end: number }>> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return []; }
    return names.map(name => ({ name, match: FILE.exec(name) })).filter(item => item.match)
      .map(item => ({ name: item.name, path: join(this.directory, item.name), end: Date.UTC(Number(item.match![1]), Number(item.match![2]), 1) }))
      .sort((a, b) => a.end - b.end);
  }

  /** Retention: a month file whose last day is older than the retention window goes; then the oldest until ≤ 50 MB. */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retentionDays() * 86_400_000;
    const files = await this.files();
    const kept: Array<{ path: string; size: number }> = [];
    for (const file of files) {
      if (file.end < cutoff) { await rm(file.path, { force: true }); continue; }
      kept.push({ path: file.path, size: (await stat(file.path).catch(() => ({ size: 0 }))).size });
    }
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    while (total > LOG_POLICY.maxTotalBytes && kept.length > 1) {
      const oldest = kept.shift()!;
      await rm(oldest.path, { force: true });
      total -= oldest.size;
    }
  }

  /** Every record since `from` (malformed lines are skipped). */
  async read(from = 0): Promise<LogRecord[]> {
    await this.queue.catch(() => undefined);
    const records: LogRecord[] = [];
    for (const file of await this.files()) {
      if (file.end < from) continue;
      const text = await readFile(file.path, 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as LogRecord;
          if (record && record.v === 1 && (record.kind === 'decision' || record.kind === 'label') && record.at >= from) records.push(record);
        } catch { /* skipped */ }
      }
    }
    return records;
  }

  /** «Очистить журнал». The salt stays, so later joins still work. */
  async clear(): Promise<void> {
    await this.queue.catch(() => undefined);
    for (const file of await this.files()) await rm(file.path, { force: true });
  }
}
