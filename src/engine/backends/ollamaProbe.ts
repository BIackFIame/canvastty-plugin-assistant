import { SystemOneError } from '../../shared/systemOne.ts';
import { OLLAMA_MIN_LOCAL_PIN, canonicalOllamaName, compareVersions, parseOllamaModelRef } from '../../shared/ollamaModelRef.ts';

/**
 * A minimal read-only probe of an Ollama server for one model (§1.4, §2.5): version, locality, digest,
 * capabilities, thinking metadata and context length. It runs only when a caller asks (adding the backend,
 * «Проверить», or before its first call); it never pulls, loads or unloads a model. Part 2's OllamaDiscovery
 * has not landed, so this is the probe the spec allows in its place.
 */

/** One JSON exchange with the server: status 200..599 with the parsed body (null when none or unreadable). Throws `transport` when unreachable. */
export type ProbeHttp = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

/** logprobs/top_logprobs on /api/chat and /api/generate (earlier servers use the JSON mode). */
export const OLLAMA_MIN_LOGPROBS = '0.12.11';
// The name parser, version compare and the pin gate live in shared/ollamaModelRef.ts (launch preflight and the UI use them too).
export { OLLAMA_MIN_LOCAL_PIN, canonicalOllamaName, compareVersions, parseOllamaModelRef } from '../../shared/ollamaModelRef.ts';

export type OllamaCloudReason =
  | 'name'              // the name parses as cloud (`:cloud`, `-cloud`)
  | 'tags-remote-host'  // /api/tags lists it with remote_host (a pulled cloud stub under a plain name)
  | 'show-remote-host'  // /api/show reports remote_host
  | 'local-pin-refused' // the server refused `name:local` (a stub the ≥ 0.18.0 guard caught)
  | 'old-server';       // below 0.18.0 the pin is not enforced, and cloud is not reported disabled

export interface OllamaThinking { values: (boolean | string)[]; default: unknown }

export interface OllamaProbeResult {
  version: string | null;
  /** ≥ 0.12.11: letter readout possible; otherwise the JSON mode only. */
  logprobs: boolean;
  /** ≥ 0.18.0: requests carry `name:local` and the server refuses a cloud stub. */
  localPin: boolean;
  /** GET /api/status `cloud.disabled` (null when the server has no such route). */
  cloudDisabled: boolean | null;
  /** §1.4: local only when every check agrees; otherwise a remote backend (Ollama Cloud). */
  locality: 'local' | 'ollama-cloud';
  cloudReasons: OllamaCloudReason[];
  /** The name every inference call sends: `name:local` on a local model with a pin-enforcing server. */
  requestName: string;
  /** The model is in /api/tags (cloud names by source need no pull and are never listed). */
  installed: boolean;
  /** sha256 hex of the manifest (/api/tags), else null. */
  digest: string | null;
  /** The model's /api/tags entry as far as the pin goes (null when it is not listed): re-read before each call. */
  listing: OllamaListing | null;
  capabilities: string[] | null;
  /** /api/show `thinking` (≥ 0.34.3); null = no metadata. */
  thinking: OllamaThinking | null;
  /** `think:false` goes on every chat call, except when /api/show reports `thinking.values` exactly `[false]`. */
  sendThinkFalse: boolean;
  /** model_info[`${general.architecture}.context_length`], else details.context_length. */
  contextLength: number | null;
  /** `PARAMETER num_ctx` of the model's Modelfile (/api/show parameters): the context it runs with, else null
   *  (the server default, which the API does not report). */
  modelfileNumCtx: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function positive(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
const remoteHost = (entry: Record<string, unknown>): boolean => typeof entry.remote_host === 'string' && entry.remote_host.length > 0 || typeof entry.remote_model === 'string' && entry.remote_model.length > 0;
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;

/**
 * What /api/tags says about the weights behind a name: the manifest digest and, for a cloud stub, where it
 * forwards. Any change (`ollama pull` of new weights, a cloud stub pulled under the same name) is another model.
 */
export interface OllamaListing { digest: string | null; remoteHost: string | null; remoteModel: string | null }

export function sameOllamaListing(a: OllamaListing | null, b: OllamaListing | null): boolean {
  if (a === null || b === null) return a === b;
  return a.digest === b.digest && a.remoteHost === b.remoteHost && a.remoteModel === b.remoteModel;
}

/** GET /api/tags (read-only) and `model`'s entry, null when it is not listed. */
export async function readOllamaListing(http: ProbeHttp, model: string): Promise<{ entry: Record<string, unknown> | null; listing: OllamaListing | null }> {
  const tagsReply = await http('GET', '/api/tags');
  if (tagsReply.status !== 200) throw new SystemOneError('transport', 'The Ollama server did not list its models.');
  const listed = isRecord(tagsReply.json) && Array.isArray(tagsReply.json.models) ? tagsReply.json.models.filter(isRecord) : [];
  const wanted = canonicalOllamaName(model);
  const entry = listed.find(item => item.name === model || item.model === model || item.name === wanted || item.model === wanted) ?? null;
  return { entry, listing: entry ? { digest: text(entry.digest), remoteHost: text(entry.remote_host), remoteModel: text(entry.remote_model) } : null };
}

/**
 * Probes `model` on the server behind `http`. A name that parses as cloud is never sent to /api/show (the
 * server would proxy that to ollama.com); everything else is read locally. The model counts as local only
 * when the name is not cloud, neither /api/tags nor /api/show reports remote_host, and the server is
 * ≥ 0.18.0 (below that, only when /api/status reports cloud disabled).
 */
export async function probeOllama(http: ProbeHttp, model: string): Promise<OllamaProbeResult> {
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\u0000-\u001f\u007f\s]/u.test(model)) throw new SystemOneError('invalid-request', 'Invalid Ollama model name.');
  const ref = parseOllamaModelRef(model);
  if (ref.source === 'local') throw new SystemOneError('invalid-request', 'Give the model name without :local; CanvasTTY adds the pin itself.');
  const cloudReasons: OllamaCloudReason[] = ref.source === 'cloud' ? ['name'] : [];

  const versionReply = await http('GET', '/api/version');
  if (versionReply.status !== 200) throw new SystemOneError(versionReply.status === 404 ? 'not-found' : 'transport', 'This address does not answer like an Ollama server.');
  const version = isRecord(versionReply.json) && typeof versionReply.json.version === 'string' && versionReply.json.version.length <= 64 ? versionReply.json.version : null;
  const logprobs = compareVersions(version, OLLAMA_MIN_LOGPROBS) >= 0;
  const localPin = compareVersions(version, OLLAMA_MIN_LOCAL_PIN) >= 0;

  const statusReply = await http('GET', '/api/status');
  const cloud = isRecord(statusReply.json) && isRecord(statusReply.json.cloud) ? statusReply.json.cloud : null;
  const cloudDisabled = statusReply.status === 200 && cloud && typeof cloud.disabled === 'boolean' ? cloud.disabled : null;

  const { entry, listing } = await readOllamaListing(http, model);
  if (entry && remoteHost(entry)) cloudReasons.push('tags-remote-host');
  const digest = entry && typeof entry.digest === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/u.test(entry.digest) ? entry.digest.replace(/^sha256:/u, '') : null;

  let capabilities: string[] | null = entry && Array.isArray(entry.capabilities) ? entry.capabilities.filter((item): item is string => typeof item === 'string') : null;
  let thinking: OllamaThinking | null = null;
  let contextLength: number | null = entry && isRecord(entry.details) ? positive(entry.details.context_length) : null;
  let modelfileNumCtx: number | null = null;
  if (ref.source !== 'cloud' && entry) {
    const showReply = await http('POST', '/api/show', { model: localPin ? `${model}:local` : model });
    if (showReply.status === 200 && isRecord(showReply.json)) {
      const show = showReply.json;
      if (remoteHost(show)) cloudReasons.push('show-remote-host');
      if (Array.isArray(show.capabilities)) capabilities = show.capabilities.filter((item): item is string => typeof item === 'string');
      if (isRecord(show.thinking) && Array.isArray(show.thinking.values)) thinking = { values: show.thinking.values.filter(item => typeof item === 'boolean' || typeof item === 'string') as (boolean | string)[], default: show.thinking.default };
      const info = isRecord(show.model_info) ? show.model_info : null;
      const arch = info && typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null;
      contextLength = (info && arch ? positive(info[`${arch}.context_length`]) : null) ?? contextLength;
      const numCtx = typeof show.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d{1,9})\s*(?:\n|$)/u.exec(show.parameters) : null;
      modelfileNumCtx = numCtx ? positive(Number(numCtx[1])) : null;
    } else if (localPin && (showReply.status === 404 || showReply.status === 400)) {
      // The ≥ 0.18.0 guard: a model with remote_host requested as `name:local` is refused.
      cloudReasons.push('local-pin-refused');
    } else if (showReply.status !== 200) {
      throw new SystemOneError(showReply.status === 0 ? 'transport' : 'server', 'The Ollama server did not describe the model.');
    }
  }
  if (!localPin && cloudDisabled !== true && !cloudReasons.length) cloudReasons.push('old-server');

  const locality = cloudReasons.length ? 'ollama-cloud' : 'local';
  const sendThinkFalse = !(thinking && thinking.values.length === 1 && thinking.values[0] === false);
  return {
    version, logprobs, localPin, cloudDisabled, locality, cloudReasons,
    // A cloud model is sent as named; a local one carries the pin whenever the server enforces it.
    requestName: locality === 'local' && localPin ? `${model}:local` : model,
    installed: !!entry, digest, listing, capabilities, thinking, sendThinkFalse, contextLength, modelfileNumCtx
  };
}
