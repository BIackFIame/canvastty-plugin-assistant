import { classAtMost, classRank, maxClass, textEgressCap, type AssistantBackendSettings, type AssistantGrant, type AssistantTarget, type AssistantVariant, type DataClass, type DataClassMode, type TrustSource } from '../shared/settings.ts';
import type { S1Locality } from '../shared/systemOne.ts';

/**
 * What a backend may receive (assistant spec §1.3, §1.5). The assistant reads the data-check mode, the person's
 * grant and the backend's level on every call.
 *
 * | target | Strict            | Warn only                                                            | Off                                  |
 * | remote | min(grant, level) | grant, limited by a level the person set; a review/estimate is a notice | any class when the grant allows text |
 * | local  | D3                | D3                                                                   | D3                                   |
 *
 * The consent to send text at all (a grant other than metadata only) is not a data-class check and holds in every
 * mode for everything that leaves this computer. Metadata fields (code facts, the command's shape) carry no text
 * and always pass. Credential redaction runs before this, in every mode (redact.ts).
 */

export { classAtMost };

export type GateTarget =
  | { kind: 'local' }
  | { kind: 'remote'; level: { cap: DataClass; source: TrustSource } };

export interface GateCap {
  /** The highest class of text this target may receive; null = no text at all (metadata only). */
  cap: DataClass | null;
  /** Warn only: a review or estimate level below what was allowed. The log records it. */
  notice?: { cap: DataClass; source: TrustSource };
}

export function gateCap(mode: DataClassMode, grant: AssistantGrant, target: GateTarget): GateCap {
  if (target.kind === 'local') return { cap: 'D3' };
  const result = textEgressCap(mode, grant, target.level);
  return result.notice ? { cap: result.cap, notice: result.notice } : { cap: result.cap };
}

/** privacyGate(mode, grant, level, stateClass) of §2.7 step 4. */
export function privacyGate(mode: DataClassMode, grant: AssistantGrant, target: GateTarget, stateClass: DataClass): { allowed: boolean } & GateCap {
  const result = gateCap(mode, grant, target);
  const allowed = classAtMost(stateClass, result.cap);
  // A notice matters only when this state is above the level it describes.
  const notice = allowed && result.notice && classRank(stateClass) > classRank(result.notice.cap) ? result.notice : undefined;
  return { allowed, cap: result.cap, ...(notice ? { notice } : {}) };
}

// ---------------------------------------------------------------------------
// Levels and targets
// ---------------------------------------------------------------------------

/** A remote backend's level: the person's trust, else CanvasTTY's estimate (D0). */
export function backendLevel(entry: Pick<AssistantBackendSettings, 'trust'>): { cap: DataClass; source: TrustSource } {
  if (entry.trust !== undefined) return { cap: entry.trust, source: 'trust' };
  return { cap: 'D0', source: 'estimate' };
}

/**
 * Where a backend sits for the gate (§1.4, §1.5). Local needs a literal loopback address, a model proven local
 * (Ollama's probe) or a non-Ollama server, and the person's one-time «Да» for that port. Everything else is remote.
 * (The chain's listener check, lsof on the port, is not ported: the person's confirmation stands alone.)
 */
export function gateTarget(entry: AssistantBackendSettings, locality: S1Locality, port: number | null): { kind: AssistantTarget; target: GateTarget } {
  if (locality !== 'loopback' || !entry.localConfirmed || port === null || entry.localConfirmed.port !== port) {
    return { kind: 'remote', target: { kind: 'remote', level: backendLevel(entry) } };
  }
  return { kind: 'local', target: { kind: 'local' } };
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** One named state field (§2.7 step 3). `name` may be a dotted path into the state object. */
export interface AssistantField {
  name: string;
  value: unknown;
  dataClass: DataClass;
  /** `metadata`: code facts and shapes, never free text; `content`: text. */
  disclosure: 'metadata' | 'content';
}

export interface GatedState {
  variant: AssistantVariant | null;
  state: Record<string, unknown>;
  sent: Array<[string, DataClass]>;
  withheld: Array<[string, DataClass]>;
  /** The class of what was sent (the max of the sent content fields; D0 for metadata only). */
  stateClass: DataClass;
  notice?: { cap: DataClass; source: TrustSource };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/**
 * Applies the gate to every field. When every content field may go, the full state goes. When any content field
 * is above the cap: with a metadata-only variant the state keeps only the metadata fields (R9: those answers only
 * tighten); without one this backend is skipped (`variant: null`). A partial content state is never sent, since
 * a question about a withheld field would be answered from nothing.
 */
export function gateFields(fields: readonly AssistantField[], mode: DataClassMode, grant: AssistantGrant, target: GateTarget, hasMetadataVariant: boolean): GatedState {
  const { cap, notice } = gateCap(mode, grant, target);
  const content = fields.filter(field => field.disclosure === 'content');
  const metadata = fields.filter(field => field.disclosure === 'metadata');
  const contentClass = content.reduce<DataClass>((acc, field) => maxClass(acc, field.dataClass), 'D0');
  const build = (list: readonly AssistantField[]): Record<string, unknown> => {
    const state: Record<string, unknown> = {};
    for (const field of list) setPath(state, field.name, field.value);
    return state;
  };
  const allContent = content.every(field => classAtMost(field.dataClass, cap));
  if (allContent) {
    const shown = notice && content.length && classRank(contentClass) > classRank(notice.cap) ? notice : undefined;
    return { variant: 'full', state: build(fields), sent: fields.map(field => [field.name, field.dataClass]), withheld: [], stateClass: content.length ? contentClass : 'D0', ...(shown ? { notice: shown } : {}) };
  }
  const withheld = content.map(field => [field.name, field.dataClass] as [string, DataClass]);
  if (!hasMetadataVariant || !metadata.length) return { variant: null, state: {}, sent: [], withheld, stateClass: 'D0' };
  return { variant: 'metadata', state: build(metadata), sent: metadata.map(field => [field.name, field.dataClass]), withheld, stateClass: 'D0' };
}
