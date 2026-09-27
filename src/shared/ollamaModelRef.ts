/**
 * Ollama model names and server versions, shared by main (discovery, launch preflight, the assistant's probe) and
 * the renderer (badges, the launcher's model list). Ports of Ollama v0.34.4's own parser; no I/O.
 */

/** A port of Ollama's model-name source parser: `:cloud` / `-cloud` tags go to ollama.com, `:local` forces local. */
export function parseOllamaModelRef(raw: string): { base: string; source: 'cloud' | 'local' | 'unspecified' } {
  const name = raw.trim();
  const i = name.lastIndexOf(':');
  if (i >= 0) {
    const suffixRaw = name.slice(i + 1).trim();
    const suffix = suffixRaw.toLowerCase();
    if (suffix === 'cloud') return { base: name.slice(0, i), source: 'cloud' };
    if (suffix === 'local') return { base: name.slice(0, i), source: 'local' };
    if (!suffixRaw.includes('/') && suffix.endsWith('-cloud')) return { base: name.slice(0, i + 1) + suffixRaw.slice(0, -'-cloud'.length), source: 'cloud' };
  }
  return { base: name, source: 'unspecified' };
}

/** `name` → `name:latest` when it has no tag (a `:` after the last `/`), as Ollama lists it. */
export function canonicalOllamaName(name: string): string {
  const slash = name.lastIndexOf('/');
  return name.slice(slash + 1).includes(':') ? name : `${name}:latest`;
}

/** Numeric semver comparison of `a.b.c` prefixes (pre-release suffixes ignored); an unreadable version sorts lowest. */
export function compareVersions(a: string | null, b: string): number {
  const parse = (text: string | null): number[] | null => {
    const match = text ? /^v?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(text.trim()) : null;
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
  };
  const left = parse(a), right = parse(b)!;
  if (!left) return -1;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
}

/** From this version the server itself refuses `name:local` for a cloud stub, so the pin is enforced (and `:cloud`
 *  names need no pulled stub). */
export const OLLAMA_MIN_LOCAL_PIN = '0.18.0';
