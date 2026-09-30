import {
  ASSISTANT_CATALOG_VERSION, DEMOTE_ON_ERROR_CLASSES, PROMOTION, QUALIFICATION, WILSON_Z,
  type AssistantUseCase, type Band, type BackendFamily, type QualifiedOutcome
} from '../shared/catalog.ts';
import type { AssistantStatsExport, AssistantUseCaseStats } from '../shared/settings.ts';
import type { DecisionRecord, LabelRecord, LogRecord } from './AssistantLog.ts';
import { wilsonUpper } from './thresholdFit.ts';

/**
 * Statistics and promotion (assistant spec §4.3, §4.5). Everything is computed from the content-free log: the
 * decision records and the label records joined to them by `auditId`.
 *
 * A key is (use case, outcome, backend family, resolvedVersion, catalog version): a new version is a new bucket
 * (R6), so AUTO is demoted by construction until the new bucket qualifies. Agreement counts only non-proxy labels;
 * for command review only the person's own answers count (R11).
 */

export interface QualificationKey { useCase: AssistantUseCase; outcome: QualifiedOutcome; family: BackendFamily; resolvedVersion: string | null; catalogVersion?: number }
export interface Qualification { qualified: boolean; n: number; nMin: number; errorUpperBound: number | null; eMax: number; reason: string | null }

const HIGH_CONFIDENCE = 0.9;
/** The most decisions kept in memory whatever their age; the log on disk is capped the same way (50 MB). */
export const STATS_MAX_DECISIONS = 100_000;

const labelKey = (record: LabelRecord): string => JSON.stringify([record.auditId, record.at, record.source, record.label, record.agrees]);

function decisionConfidence(record: DecisionRecord): number {
  let lowest = 1;
  for (const answer of Object.values(record.answers ?? {}) as Array<Record<string, unknown>>) {
    let top: number | null = null;
    if (typeof answer.p === 'number') top = Math.max(answer.p, 1 - answer.p);
    else if (answer.probabilities && typeof answer.probabilities === 'object') top = Math.max(...Object.values(answer.probabilities as Record<string, number>));
    if (top !== null) lowest = Math.min(lowest, top);
  }
  return lowest;
}

function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export class AssistantStats {
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly labels: LabelRecord[] = [];
  private readonly forced = new Set<string>();
  private readonly seenLabels = new Set<string>();

  /** Idempotent: a record read back from the log after it was ingested live counts once. */
  ingest(record: LogRecord): void {
    if (record.kind === 'decision') { this.decisions.set(record.id, record); return; }
    const key = labelKey(record);
    if (this.seenLabels.has(key)) return;
    this.seenLabels.add(key);
    this.labels.push(record);
  }

  ingestAll(records: readonly LogRecord[]): void { for (const record of records) this.ingest(record); }
  clear(): void { this.decisions.clear(); this.labels.length = 0; this.seenLabels.clear(); }

  get size(): { decisions: number; labels: number } { return { decisions: this.decisions.size, labels: this.labels.length }; }

  /**
   * Memory follows the log's retention: decisions and labels older than `before` go, then the oldest decisions past
   * `maxDecisions`, with the labels joined to them — what a restart would read back from the log is what stays.
   */
  prune(before: number, maxDecisions = STATS_MAX_DECISIONS): void {
    const gone = new Set<string>();
    for (const [id, record] of this.decisions) if (record.at < before) gone.add(id);
    if (this.decisions.size - gone.size > maxDecisions) {
      const rest = [...this.decisions.values()].filter(record => !gone.has(record.id)).sort((a, b) => a.at - b.at);
      for (const record of rest.slice(0, rest.length - maxDecisions)) gone.add(record.id);
    }
    for (const id of gone) this.decisions.delete(id);
    const kept = this.labels.filter(label => label.at >= before && !gone.has(label.auditId));
    if (kept.length === this.labels.length) return;
    this.labels.length = 0;
    this.seenLabels.clear();
    for (const label of kept) { this.labels.push(label); this.seenLabels.add(labelKey(label)); }
  }

  /** Labels that count for a use case: non-proxy, and for command review only the person's own. */
  private counts(useCase: AssistantUseCase, label: LabelRecord): boolean {
    if (label.source === 'proxy') return false;
    if (useCase === 'command.review') return label.source === 'person';
    return label.source !== 'smart';
  }

  private joined(key: QualificationKey): Array<{ decision: DecisionRecord; label: LabelRecord }> {
    const catalogVersion = key.catalogVersion ?? ASSISTANT_CATALOG_VERSION;
    const out: Array<{ decision: DecisionRecord; label: LabelRecord }> = [];
    for (const label of this.labels) {
      const decision = this.decisions.get(label.auditId);
      if (!decision || decision.useCase !== key.useCase || decision.qualifiedOutcome !== key.outcome || decision.catalogVersion !== catalogVersion) continue;
      if (!decision.backend || decision.backend.family !== key.family || decision.backend.resolvedVersion !== key.resolvedVersion) continue;
      if (!this.counts(key.useCase, label)) continue;
      out.push({ decision, label });
    }
    return out.sort((a, b) => a.label.at - b.label.at);
  }

  /**
   * Whether an outcome may act in Auto (§4.3): n ≥ N_min labels in its AUTO band, the Wilson upper bound of the
   * error rate ≤ E_max (z = 1.96 on default thresholds, 3.09 on fitted ones), no high-confidence error in the last
   * 50 labels (none at all on delete/publish/vcs_remote/outside_project), rolling agreement over the last 100 at
   * least 1 − 2·E_max, and, where the assistant-off path made a comparable prediction, beating it by 5 points.
   */
  qualification(key: QualificationKey, thresholds: 'default' | 'fitted' = 'default'): Qualification {
    const table = QUALIFICATION[key.useCase][key.outcome];
    if (!table) return { qualified: false, n: 0, nMin: 0, errorUpperBound: null, eMax: 0, reason: 'no-auto-for-this-outcome' };
    const rows = this.joined(key);
    const n = rows.length;
    const errors = rows.filter(row => !row.label.agrees).length;
    const upper = n ? wilsonUpper(errors, n, thresholds === 'fitted' ? WILSON_Z.fitted : WILSON_Z.default) : null;
    const base = { n, nMin: table.nMin, errorUpperBound: upper, eMax: table.eMax };
    if (n < table.nMin) return { ...base, qualified: false, reason: 'not-enough-labels' };
    if (upper === null || upper > table.eMax) return { ...base, qualified: false, reason: 'error-bound' };
    const highConfidenceError = (row: { decision: DecisionRecord; label: LabelRecord }): boolean => !row.label.agrees && decisionConfidence(row.decision) >= HIGH_CONFIDENCE;
    if (rows.slice(-PROMOTION.recentWindow).some(highConfidenceError)) return { ...base, qualified: false, reason: 'recent-high-confidence-error' };
    if (key.useCase === 'command.review' && rows.some(row => highConfidenceError(row) && row.decision.actionClass && DEMOTE_ON_ERROR_CLASSES.includes(row.decision.actionClass))) return { ...base, qualified: false, reason: 'high-confidence-error-on-person-class' };
    const rolling = rows.slice(-PROMOTION.rollingWindow);
    if (rolling.filter(row => row.label.agrees).length / rolling.length < 1 - 2 * table.eMax) return { ...base, qualified: false, reason: 'agreement-dropped' };
    const baseline = rows.filter(row => row.label.baselineAgrees !== null);
    if (baseline.length >= table.nMin) {
      const model = baseline.filter(row => row.label.agrees).length / baseline.length;
      const rules = baseline.filter(row => row.label.baselineAgrees).length / baseline.length;
      if (model < rules + PROMOTION.baselineMargin) return { ...base, qualified: false, reason: 'weaker-than-rules' };
    }
    return { ...base, qualified: true, reason: null };
  }

  /**
   * The engine's gate for acting in Auto. A low-risk use case the person forced (§4.3) acts with a warning, except
   * on a backend measured weaker than the rules; command review is never forceable.
   */
  qualified(key: QualificationKey, thresholds: 'default' | 'fitted' = 'default'): boolean {
    const result = this.qualification(key, thresholds);
    if (result.qualified) return true;
    return key.useCase !== 'command.review' && this.forced.has(`${key.useCase}/${key.family}`) && result.reason !== 'weaker-than-rules';
  }

  force(useCase: AssistantUseCase, family: BackendFamily, on: boolean): void {
    if (useCase === 'command.review') return;
    const key = `${useCase}/${family}`;
    if (on) this.forced.add(key); else this.forced.delete(key);
  }

  /** Statistics without content (§4.5); the export is this object as JSON. */
  summary(from: number, to: number): AssistantStatsExport {
    const useCases: AssistantStatsExport['useCases'] = {};
    const latency = new Map<AssistantUseCase, number[]>();
    const keys = new Map<string, QualificationKey>();
    for (const record of this.decisions.values()) {
      if (record.at < from || record.at > to) continue;
      const stats: AssistantUseCaseStats = useCases[record.useCase] ??= { calls: 0, labelled: 0, agreement: null, bands: {}, fallbacks: {}, latencyMs: { p50: null, p95: null }, costUsd: 0 };
      stats.calls++;
      for (const band of Object.values(record.bands ?? {}) as Band[]) stats.bands[band] = (stats.bands[band] ?? 0) + 1;
      if (record.fallbackReason) stats.fallbacks[record.fallbackReason] = (stats.fallbacks[record.fallbackReason] ?? 0) + 1;
      if (typeof record.latencyMs === 'number' && !record.cached) (latency.get(record.useCase) ?? latency.set(record.useCase, []).get(record.useCase)!).push(record.latencyMs);
      stats.costUsd += record.usage?.costUsd ?? 0;
      if (record.qualifiedOutcome && record.backend) {
        const key: QualificationKey = { useCase: record.useCase, outcome: record.qualifiedOutcome, family: record.backend.family, resolvedVersion: record.backend.resolvedVersion };
        keys.set(JSON.stringify(key), key);
      }
    }
    const agree = new Map<AssistantUseCase, { n: number; ok: number }>();
    for (const label of this.labels) {
      const decision = this.decisions.get(label.auditId);
      if (!decision || decision.at < from || decision.at > to || !this.counts(decision.useCase, label)) continue;
      const entry = agree.get(decision.useCase) ?? { n: 0, ok: 0 };
      entry.n++; if (label.agrees) entry.ok++;
      agree.set(decision.useCase, entry);
    }
    for (const [useCase, stats] of Object.entries(useCases) as Array<[AssistantUseCase, AssistantUseCaseStats]>) {
      const values = latency.get(useCase) ?? [];
      stats.latencyMs = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
      const entry = agree.get(useCase);
      stats.labelled = entry?.n ?? 0;
      stats.agreement = entry && entry.n ? entry.ok / entry.n : null;
    }
    const qualification = [...keys.entries()].map(([id, key]) => ({ key: id, ...key, resolvedVersion: key.resolvedVersion, ...this.qualification(key) }));
    return { catalogVersion: ASSISTANT_CATALOG_VERSION, from, to, useCases, qualification };
  }
}
