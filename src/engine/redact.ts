import { redactCredentials } from '../shared/credentialRedaction.ts';

/**
 * Redaction before egress (assistant spec §5.8). Always on, in every data-check mode, Off included, and for
 * local backends too: secrets never help a decision.
 *
 * Two passes, both before any length bound, so a cut can never leave half a key:
 * 1. L9b's `redactCredentials` (shared with the Jev task text and pool handoffs);
 * 2. this stricter, assistant-only pass: every env-assignment value, every URL query string, long base64 or hex
 *    runs (commit SHAs included), and values under keys named like a secret.
 */

const marker = (kind: string): string => `<redacted:${kind}>`;
const NOT_MASKED = '(?!<redacted:)';

const EXTRA_RULES: ReadonlyArray<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // `FOO=value`, `export FOO="a b"` — any upper-case environment name, whatever it is called.
  { pattern: new RegExp(`(\\b[A-Z_][A-Z0-9_]{1,63}=)${NOT_MASKED}(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"'<>;&|]+)`, 'gu'), replace: (_m, prefix) => `${prefix}${marker('env')}` },
  // Every URL query string (not only the secret-looking parameters).
  { pattern: new RegExp(`(\\b[a-z][a-z0-9+.-]{1,20}://[^\\s?#"'<>]*\\?)${NOT_MASKED}[^\\s#"'<>]+`, 'giu'), replace: (_m, prefix) => `${prefix}${marker('query')}` },
  // Long base64 or hex runs, commit SHAs included.
  // A path (several `/`-separated words) is not a blob; a base64 run mixes digits and both letter cases.
  { pattern: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/gu,
    replace: match => /^[A-Fa-f0-9]+$/u.test(match) || /[0-9]/u.test(match) && /[A-Z]/u.test(match) && /[a-z]/u.test(match) && (match.match(/\//gu)?.length ?? 0) < 2 ? marker('blob') : match }
];

/** #40556's `_SENSITIVE_KEY_PARTS`: a value under such a key is masked whatever it looks like. */
const SENSITIVE_KEY = /api[_-]?key|credential|password|private[_-]?key|secret|token/iu;

function extraPass(text: string): { text: string; count: number } {
  let count = 0, result = text;
  for (const rule of EXTRA_RULES) {
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const end = rest.findIndex(value => typeof value === 'number');
      const groups = (end < 0 ? [] : rest.slice(0, end)).map(value => typeof value === 'string' ? value : '');
      const replaced = rule.replace(match, ...groups);
      if (replaced !== match) count++;
      return replaced;
    });
  }
  return { text: result, count };
}

/** Both passes over one string. Idempotent: a marker is never masked again. */
export function redactForEgress(text: string): { text: string; count: number } {
  const base = redactCredentials(text);
  const extra = extraPass(base.text);
  return { text: extra.text, count: base.count + extra.count };
}

/** Both passes over every string in a JSON-like value; values under secret-named keys are masked whole. */
export function redactValue(value: unknown, depth = 0): { value: unknown; count: number } {
  if (depth > 16) return { value: null, count: 0 };
  if (typeof value === 'string') { const result = redactForEgress(value); return { value: result.text, count: result.count }; }
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map(item => { const result = redactValue(item, depth + 1); count += result.count; return result.value; });
    return { value: items, count };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && item !== null && item !== undefined && item !== '' && typeof item !== 'boolean') { out[key] = marker('key-value'); count++; continue; }
      const result = redactValue(item, depth + 1);
      out[key] = result.value; count += result.count;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/**
 * Redacts, then bounds. A value cut by its bound is `truncated`, which rules out AUTO (R3); redaction itself
 * never counts as truncation. The cut never lands inside a `<redacted:…>` marker.
 */
export function redactAndBound(text: string, maxChars: number): { text: string; count: number; truncated: boolean } {
  const redacted = redactForEgress(text);
  if (redacted.text.length <= maxChars) return { text: redacted.text, count: redacted.count, truncated: false };
  let cut = maxChars;
  const open = redacted.text.lastIndexOf('<redacted:', cut);
  if (open >= 0 && redacted.text.indexOf('>', open) >= cut) cut = open;
  return { text: redacted.text.slice(0, cut), count: redacted.count, truncated: true };
}
