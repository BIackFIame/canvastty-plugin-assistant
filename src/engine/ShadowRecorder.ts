import { SHADOW_RECORDER, type AssistantUseCase } from '../shared/catalog.ts';
import type { AssistantLabelSource } from '../shared/settings.ts';
import type { LabelRecord } from './AssistantLog.ts';

/**
 * The ground-truth join (assistant spec §4.2): a bounded map `auditId → {useCase, outcome, expiresAt}` (≤ 2,000
 * entries, 24 h). A label for a known decision becomes a separate log record; a label for an unknown or expired
 * decision is dropped. The recorder keeps no answers and no content: the decision record in the log has them.
 */

export interface ShadowEntry { useCase: AssistantUseCase; outcome: string | null; expiresAt: number }
export interface ShadowLabel { label: string; source: AssistantLabelSource; agrees: boolean; baselineAgrees?: boolean | null }

const LABEL = /^[a-z][a-z0-9_-]{0,39}$/u;

export class ShadowRecorder {
  private readonly entries = new Map<string, ShadowEntry>();
  private readonly now: () => number;
  private readonly sink: (record: LabelRecord) => void;

  constructor(options: { sink: (record: LabelRecord) => void; now?: () => number }) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
  }

  register(auditId: string, entry: Omit<ShadowEntry, 'expiresAt'>): void {
    this.prune();
    this.entries.delete(auditId);
    this.entries.set(auditId, { ...entry, expiresAt: this.now() + SHADOW_RECORDER.ttlMs });
    while (this.entries.size > SHADOW_RECORDER.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  has(auditId: string): boolean { this.prune(); return this.entries.has(auditId); }

  /**
   * Joins one label. Returns false (and records nothing) for an unknown or expired decision, or a malformed label.
   * Command review labels from anyone but the person are still recorded, for comparison only; statistics count
   * only `source:'person'` for it (R11).
   */
  label(auditId: string, label: ShadowLabel): boolean {
    this.prune();
    const entry = this.entries.get(auditId);
    if (!entry || !LABEL.test(label.label) || typeof label.agrees !== 'boolean') return false;
    this.sink({ v: 1, kind: 'label', auditId, label: label.label, source: label.source, agrees: label.agrees, baselineAgrees: typeof label.baselineAgrees === 'boolean' ? label.baselineAgrees : null, at: this.now() });
    return true;
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) { if (entry.expiresAt <= now) this.entries.delete(id); else break; }
  }
}
