import { SystemOneError } from '../../shared/systemOne.ts';
import { LETTERS, type ChatMessage } from './semifPrompt.ts';

/**
 * The letter readout (§2.5): one completion token, read from the first generated position's top logprobs.
 * Ollama's llama.cpp engine, its MLX runner and llama-server all return a log-softmax over the raw logits,
 * taken before sampling, so renormalizing the option letters gives exactly softmax(letter logits): what a
 * model trained on the SemIf format computes. That holds only with every option letter present, so a
 * missing letter fails closed; CanvasTTY never gives one a floor probability.
 */

/** The letter-mass floor: below it the model did not answer in the format (wrong template, thinking left on). */
export const MIN_LETTER_MASS = 0.5;

export interface TokenLogprob { token: string; logprob: number }

/** A token maps to letter L if it equals L after stripping whitespace and BPE markers (`Ġ`, `▁`). */
export function letterOfToken(token: string): string | null {
  if (typeof token !== 'string') return null;
  const bare = token.replace(/[\sĠ▁]/gu, '');
  return /^[A-Z]$/u.test(bare) ? bare : null;
}

const invalidOutput = (message: string): never => { throw new SystemOneError('invalid-output', message); };

/**
 * Reads `n` option letters (A.. in pass order) from one position's top logprobs. Variants of a letter (`A`,
 * ` A`, `ĠA`) are summed. `letterMass` is Σ exp(logprob) over the option letters before renormalizing.
 * Any option letter missing from the top-k, or a letter mass below 0.5, fails closed (`invalid-output`).
 */
export function readLetters(top: readonly TokenLogprob[], n: number): { probs: number[]; letterMass: number } {
  if (!Number.isSafeInteger(n) || n < 2 || n > LETTERS.length) throw new SystemOneError('invalid-request', 'A letter pass reads 2..26 letters.');
  const mass = new Array<number>(n).fill(0);
  const seen = new Array<boolean>(n).fill(false);
  for (const entry of top) {
    if (!entry || typeof entry.logprob !== 'number' || !Number.isFinite(entry.logprob) || entry.logprob > 1e-6) throw new SystemOneError('invalid-response', 'Invalid token logprob.');
    const letter = letterOfToken(entry.token);
    if (letter === null) continue;
    const index = letter.charCodeAt(0) - 65;
    if (index >= n) continue;
    mass[index]! += Math.exp(Math.min(0, entry.logprob));
    seen[index] = true;
  }
  const missing = seen.findIndex(item => !item);
  if (missing >= 0) invalidOutput(`Option letter ${LETTERS[missing]} is missing from the returned top tokens.`);
  const letterMass = mass.reduce((sum, value) => sum + value, 0);
  if (!(letterMass >= MIN_LETTER_MASS)) invalidOutput('The option letters carry less than half of the probability.');
  return { probs: mass.map(value => value / letterMass), letterMass: Math.min(1, letterMass) };
}

/** p ∝ p^(1/T): softmax(logit / T) restricted to the option letters. T = 1 changes nothing; the argmax never moves. */
export function applyTemperature(probs: readonly number[], temperature: number): number[] {
  if (!Number.isFinite(temperature) || temperature <= 0) throw new SystemOneError('invalid-request', 'Invalid temperature.');
  if (temperature === 1) return [...probs];
  const logs = probs.map(p => p > 0 ? Math.log(p) / temperature : -Infinity);
  const peak = Math.max(...logs);
  const weights = logs.map(value => Number.isFinite(value) ? Math.exp(value - peak) : 0);
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map(value => value / total);
}

// ---------------------------------------------------------------------------
// Per-runtime requests and responses (§2.5 table)
// ---------------------------------------------------------------------------

/**
 * One letter pass through Ollama:
 * - `ollama-chat`: `POST /api/chat` with the model's own template, `think:false` (the `semif-v1` profile);
 * - `ollama-generate`: `POST /api/generate` raw with the text CanvasTTY renders (the `eikos-v1` profile).
 * (The chain's llama-server, vLLM and OpenAI-compatible routes are not ported.)
 */
export type LetterRoute = 'ollama-generate' | 'ollama-chat';

export interface LetterPassInput {
  route: LetterRoute;
  /** The name the server gets (an Ollama name pinned as `name:local`). */
  model: string;
  messages: ChatMessage[];
  /** The full templated text (raw routes). */
  text: string;
  /** Top tokens to ask for. */
  topK: number;
  /** Ollama: the fixed context (changing it per call reloads the model). */
  numCtx?: number;
  keepAlive?: string;
  /** Ollama chat: `think:false`, or omitted (undefined) for a model that cannot think or refuses the field. */
  think?: false;
}

/** The path and JSON body of one letter pass. */
export function letterPassRequest(input: LetterPassInput): { path: string; body: Record<string, unknown> } {
  const ollamaOptions = { temperature: 0, num_predict: 1, ...(input.numCtx ? { num_ctx: input.numCtx } : {}) };
  switch (input.route) {
    case 'ollama-generate':
      // truncate defaults to true and silently cuts the front of a long prompt: always false.
      return { path: '/api/generate', body: { model: input.model, prompt: input.text, raw: true, stream: false, truncate: false, keep_alive: input.keepAlive ?? '10m', logprobs: true, top_logprobs: input.topK, options: ollamaOptions } };
    case 'ollama-chat':
      return {
        path: '/api/chat',
        body: {
          model: input.model, messages: input.messages, stream: false, ...(input.think === false ? { think: false } : {}),
          truncate: false, keep_alive: input.keepAlive ?? '10m', logprobs: true, top_logprobs: input.topK, options: ollamaOptions
        }
      };
  }
}

export interface LetterPassResponse {
  top: TokenLogprob[];
  reportedModel: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  /** Ollama answered through ollama.com (a cloud stub): never acceptable for a pass CanvasTTY sent as local. */
  remote: boolean;
  /** The model produced a thought first: Ollama `message.thinking` (chat) or `thinking` (generate). Its first
   * token is then not a letter (§2.5). */
  thought: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function said(value: unknown): boolean { return typeof value === 'string' && value.length > 0; }
const invalid = (message: string): never => { throw new SystemOneError('invalid-response', message); };

function tokenList(value: unknown): TokenLogprob[] {
  if (!Array.isArray(value)) return invalid('Missing top logprobs.');
  return value.map(item => {
    if (!isRecord(item) || typeof item.logprob !== 'number') return invalid('Invalid top logprob.');
    return { token: typeof item.token === 'string' ? item.token : '', logprob: item.logprob };
  });
}

/** Reads the first generated position's top logprobs. A server that returned none (Ollama < 0.12.11) is `invalid-output`. */
export function letterPassResponse(route: LetterRoute, json: unknown): LetterPassResponse {
  if (!isRecord(json)) return invalid('Invalid letter readout response.');
  if (typeof json.error === 'string' || isRecord(json.error)) throw new SystemOneError('server', 'The server reported an error.');
  const model = typeof json.model === 'string' && json.model.length <= 4096 ? json.model : null;
  if (route === 'ollama-generate' || route === 'ollama-chat') {
    const remote = typeof json.remote_host === 'string' || typeof json.remote_model === 'string';
    const message = isRecord(json.message) ? json.message : null;
    const thought = said(json.thinking) || !!message && said(message.thinking);
    const first = Array.isArray(json.logprobs) ? json.logprobs[0] : undefined;
    if (!isRecord(first) || !Array.isArray(first.top_logprobs)) invalidOutput('The server returned no logprobs.');
    return { top: tokenList((first as Record<string, unknown>).top_logprobs), reportedModel: model, promptTokens: count(json.prompt_eval_count), outputTokens: count(json.eval_count), remote, thought };
  }
  return invalid('Unknown letter route.');
}
