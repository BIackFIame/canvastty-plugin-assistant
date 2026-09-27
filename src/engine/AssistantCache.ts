import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CACHE_MAX_ENTRIES } from '../shared/catalog.ts';
import type { S1Answer } from '../shared/systemOne.ts';

/** JSON with object keys sorted at every level: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
/** `sha256:<hex>` of a question set's canonical JSON (§3). */
export function questionSetHash(set: unknown): string { return `sha256:${sha256(canonicalJson(set))}`; }

export interface CacheKeyParts {
  backendId: string;
  /** resolvedVersion, else the requested model. */
  version: string;
  temperature: number;
  catalogVersion: number;
  questionSetHash: string;
  state: unknown;
  /** The data-check mode, the grant and the backend's level with its source (§1.5, §5.4). */
  privacyRevision: string;
  /** Command review: session + cwd + facts hash. */
  scope?: string;
}

export interface CachedAnswers {
  answers: Record<string, S1Answer>;
  resolvedVersion: string | null;
  modelLabel: string;
}

/**
 * The answer cache (§5.4): in memory only, LRU, never on disk. It stores answers, never outcomes, so the band
 * and mode logic runs again on every hit and a cached answer can never carry an allow past a later suspect or
 * strict flag, a breaker trip or a demotion. Its salt lives only as long as the process.
 */
export class AssistantCache {
  private readonly salt = randomBytes(32);
  private readonly entries = new Map<string, CachedAnswers & { expiresAt: number }>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES;
  }

  key(parts: CacheKeyParts): string {
    const stateMac = createHmac('sha256', this.salt).update(canonicalJson(parts.state)).digest('hex');
    return sha256(canonicalJson([parts.backendId, parts.version, parts.temperature, parts.catalogVersion, parts.questionSetHash, stateMac, parts.privacyRevision, parts.scope ?? '']));
  }

  get(key: string): CachedAnswers | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return structuredClone({ answers: entry.answers, resolvedVersion: entry.resolvedVersion, modelLabel: entry.modelLabel });
  }

  set(key: string, value: CachedAnswers, ttlMs: number): void {
    if (!(ttlMs > 0)) return;
    this.entries.delete(key);
    this.entries.set(key, { ...structuredClone(value), expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
