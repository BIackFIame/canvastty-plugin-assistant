/**
 * Command review (assistant spec §3.1b, L17): the shared shapes, ported from the CanvasTTY chain. The review is part
 * of the assistant and follows its switch: while the assistant or `command.review` is off nothing is reviewed,
 * computed or called (R8). No Node APIs.
 */

/** Tool kinds (ACP v1 `ToolKind`, which the CLI hooks' tools are mapped onto). Anything else is `other`. */
export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;
export type AcpToolKind = typeof ACP_TOOL_KINDS[number];

/** The kinds a reviewer may answer at all. `think`, `switch_mode`, `other` and a missing kind stay with the person (R2). */
export const REVIEWABLE_ACP_KINDS: readonly AcpToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch'];

/** Bounds of what the review reads. */
export const REVIEW_LIMITS = Object.freeze({
  /** New text of an edit, per request. */
  contentChars: 16_384,
  locations: 32,
  pathChars: 4_096,
  /** At most this many project files the command runs go to the smart verifier, each at most this many bytes (§2.6). */
  referencedFiles: 2,
  referencedFileBytes: 8_192,
  /** Code facts (git status, realpath) share this budget; past it the fact is unknown and treated as risky. */
  factsMs: 3_000
});

/** What the review keeps of one tool call, privately (never shown, never logged). */
export interface AcpPermissionDetail {
  toolCallId: string | null;
  kind: AcpToolKind | null;
  title: string | null;
  /** The parsed input when it fit the bound; otherwise null with `rawInputTruncated`. */
  rawInput: unknown;
  rawInputText: string | null;
  rawInputTruncated: boolean;
  /** Paths the tool names, bounded. */
  locations: string[];
  /** Edit diffs: the new text per path, bounded in total. */
  diffs: Array<{ path: string; newText: string }>;
  contentTruncated: boolean;
}

/** One reason, as a code constant the settings page words (en/ru). */
export type ReviewReason =
  | 'rule-deny' | 'rule-ask' | 'rule-allow'
  | 'person-only' | 'unseeable' | 'risk' | 'not-requested' | 'external' | 'suspect' | 'circuit'
  | 'auto-band' | 'both-agree' | 'model-deny' | 'smart-deny' | 'disagree' | 'needs-second'
  | 'unavailable' | 'no-kind' | 'learning';
