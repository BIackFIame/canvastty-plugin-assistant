import { SystemOneError, flattenEntry, type S1Question, type S1State } from '../../shared/systemOne.ts';

/**
 * The SemIf letter prompt (§2.5), byte for byte. SemIf (TheoLeeCJ/SemIf-OpenJev, MIT, `direct-options-v1`)
 * defined the format and Eikos (caiovicentino/eikos, MIT, `letter-v1-semif`) was trained on it, so a model
 * trained on it answers as it was trained, and as its own server would, only when these bytes match.
 *
 * The user message is what Python's `json.dumps(payload, ensure_ascii=False)` produces for
 * `{"evidence": state, "criterion": instructions, "options": [{"letter": "A", "description": "<label>: <text>"}, …]}`:
 * key order as written, separators `", "` and `": "`, non-ASCII left as it is. The state comes first, so a
 * server's prompt-prefix cache reuses it across the questions of one request.
 */

export const SEMIF_SYSTEM = 'Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning.';
export const LETTERS: readonly string[] = Object.freeze(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)));

export type PromptProfileId = 'semif-v1' | 'eikos-v1';
export interface PromptProfile {
  id: PromptProfileId;
  /** Letters one pass may use: the profile's own cap (the runtime may lower it). */
  letters: number;
  /** The temperature before any fit: 1, or the model's calib.json (eikos-v1). */
  initialTemperature: number;
  /** The upstream format name. */
  promptVersion: string;
}
/** The two profiles differ in the letter cap and the initial temperature, not in the text. */
export const PROMPT_PROFILES: Readonly<Record<PromptProfileId, PromptProfile>> = Object.freeze({
  'semif-v1': Object.freeze({ id: 'semif-v1', letters: 16, initialTemperature: 1, promptVersion: 'direct-options-v1' }),
  'eikos-v1': Object.freeze({ id: 'eikos-v1', letters: 26, initialTemperature: 1, promptVersion: 'letter-v1-semif' })
});

// ---------------------------------------------------------------------------
// Python's json.dumps(value, ensure_ascii=False)
// ---------------------------------------------------------------------------

const PY_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' });

/** A JSON string as Python writes it with ensure_ascii=False. A lone surrogate (which no UTF-8 prompt can
 * carry) becomes U+FFFD, as it does when the JSON body reaches the server. */
function pyString(text: string): string {
  const wellFormed = text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, '�');
  return `"${wellFormed.replace(/["\\\u0000-\u001f]/gu, char => PY_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/**
 * Python's float repr: the shortest digits that round-trip (the same digits JavaScript picks), positional for
 * decimal exponents −4..15 with at least one fractional digit, otherwise `d.ddde±XX`.
 */
function pyFloat(value: number): string {
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/u.exec(value.toExponential());
  if (!match) throw new SystemOneError('invalid-request', 'Non-JSON number in a System One prompt.');
  const [, sign, lead, rest = '', exponentText] = match;
  const exponent = Number(exponentText);
  const digits = lead! + rest;
  if (exponent < -4 || exponent >= 16) {
    return `${sign}${lead}${rest ? `.${rest}` : ''}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || '0'}`;
}

/**
 * `json.dumps(json.loads(JSON.stringify(value)), ensure_ascii=False)`: what a Python server renders for the
 * JSON CanvasTTY sends it. A number JSON writes as an integer (`3`, `1e16` → `10000000000000000`) is a Python
 * int; any other (`0.5`, `1e-7`, `1e+21`) is a Python float, written with Python's repr.
 */
export function pyJsonDumps(value: unknown): string {
  const render = (item: unknown): string => {
    if (item === null) return 'null';
    if (item === true) return 'true';
    if (item === false) return 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new SystemOneError('invalid-request', 'Non-JSON number in a System One prompt.');
      const written = JSON.stringify(item);
      return /^-?\d+$/u.test(written) ? written : pyFloat(item);
    }
    if (typeof item === 'string') return pyString(item);
    if (Array.isArray(item)) return `[${item.map(render).join(', ')}]`;
    if (typeof item === 'object') return `{${Object.entries(item as Record<string, unknown>).map(([key, entry]) => `${pyString(key)}: ${render(entry)}`).join(', ')}}`;
    throw new SystemOneError('invalid-request', 'Non-JSON value in a System One prompt.');
  };
  // One JSON round trip first: exactly the value a server parses (undefined members dropped, toJSON applied).
  // A non-finite number is refused rather than silently written as null.
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('non-finite');
      return item;
    });
  } catch { text = undefined; }
  if (text === undefined) throw new SystemOneError('invalid-request', 'Non-JSON value in a System One prompt.');
  return render(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Options, user message, chat template
// ---------------------------------------------------------------------------

/** One option as a pass shows it: its label (CanvasTTY's answer key) and `"<label>: <description>"`. */
export interface SemifOption { label: string; description: string }

/**
 * The options of a question in CanvasTTY's label order: noul `true` (A) then `false` (B); score levels as
 * `"0".."n−1"`; choices in catalog order. An object description is flattened (§2.3) and a null one becomes
 * the label, so no Python repr can reach the model.
 */
export function semifOptions(question: S1Question): SemifOption[] {
  if (question.type === 'noul') return [{ label: 'true', description: `true: ${question.criteria.true}` }, { label: 'false', description: `false: ${question.criteria.false}` }];
  if (question.type === 'score') return question.criteria.map((level, index) => ({ label: String(index), description: `${index}: ${level}` }));
  return Object.entries(question.criteria).map(([label, description]) => ({ label, description: `${label}: ${flattenEntry(description, label)}` }));
}

/** The user message for one pass over `options` (a subset or a reordering for tournaments and symmetric passes). */
export function renderSemifUser(state: S1State, question: S1Question, options: readonly SemifOption[]): string {
  if (options.length < 2 || options.length > LETTERS.length) throw new SystemOneError('invalid-request', 'A letter pass needs 2..26 options.');
  return pyJsonDumps({
    evidence: state,
    criterion: flattenEntry(question.instructions),
    options: options.map((option, i) => ({ letter: LETTERS[i], description: option.description }))
  });
}

export interface ChatMessage { role: 'system' | 'user'; content: string }

/** The system message first, then the user message: the evidence is the shared prefix. */
export function semifMessages(state: S1State, question: S1Question, options: readonly SemifOption[]): ChatMessage[] {
  return [{ role: 'system', content: SEMIF_SYSTEM }, { role: 'user', content: renderSemifUser(state, question, options) }];
}

/**
 * The Qwen3.5 / Eikos chat template (`chat_template.jinja`) for a system and a user message, rendered with
 * add_generation_prompt=true and enable_thinking=false. With thinking on it ends `<think>\n` and the first
 * token is a thought, not a letter, so the readout never renders that. It renders any content byte for byte
 * (parity with Eikos); the backend never sends one that carries a control string (carriesTemplateControl).
 */
export function renderQwenChat(messages: readonly ChatMessage[]): string {
  const [system, user] = messages;
  if (messages.length !== 2 || system?.role !== 'system' || user?.role !== 'user') throw new SystemOneError('invalid-request', 'The letter template takes one system and one user message.');
  // The template trims each content; both are JSON or a fixed sentence, so trimming never changes them.
  if (system.content !== system.content.trim() || user.content !== user.content.trim()) throw new SystemOneError('invalid-request', 'Template content must not start or end with whitespace.');
  return `<|im_start|>system\n${system.content}<|im_end|>\n<|im_start|>user\n${user.content}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

// ---------------------------------------------------------------------------
// Chat-template control strings
// ---------------------------------------------------------------------------

/** Mistral's bracket markers. In JSON text they occur only inside strings (a structural `[` is never followed by a capital or `/`). */
const BRACKET_MARKER = /\[(\/?(?:INST|SYSTEM_PROMPT|TOOL_CALLS|AVAILABLE_TOOLS|TOOL_RESULTS))\]/gu;

/**
 * Strings a tokenizer turns into control tokens wherever they sit in the text: Ollama's runners (llama and
 * mlxrunner), llama-server (`parse_special`) and HF tokenizers all do, and a chat route's template inserts the
 * content as it is. In a prompt they would forge a turn (`<|im_end|>\n<|im_start|>system\n…`) or close the
 * empty thought early. Caught: any `<|name|>` (Qwen, Llama 3, Phi, gpt-oss; DeepSeek writes the bars
 * full-width), the thinking and tool tags, Gemma's turn markers and bos/eos, Llama 2's `<<SYS>>` and
 * Mistral's bracket markers. Python's json.dumps escapes none of them, so the SemIf bytes carry them as given.
 */
const TEMPLATE_CONTROL = new RegExp(
  `<[|\uff5c][^\\s<>|\uff5c]{1,64}[|\uff5c]>|<\\/?(?:think|tool_call|tool_response)>|<(?:start_of_turn|end_of_turn|bos|eos)>|<<\\/?SYS>>|${BRACKET_MARKER.source}`,
  'u'
);

/** Whether `text` carries a chat-template control string (§2.5: such a prompt never gets a letter pass). */
export function carriesTemplateControl(text: string): boolean { return TEMPLATE_CONTROL.test(text); }

/**
 * Whether any letter pass of `question` would carry a control string from the question itself: its criterion
 * or an option description (an agent's own option, for `decide`), as a pass writes them.
 */
export function questionCarriesTemplateControl(question: S1Question): boolean {
  return carriesTemplateControl(pyJsonDumps({ criterion: flattenEntry(question.instructions), options: semifOptions(question).map(option => option.description) }));
}

/**
 * JSON text with every control string made inert and the value unchanged: `<` and `>` as `\u003c`/`\u003e`
 * and a bracket marker's brackets as `\u005b`/`\u005d`. Both occur only inside strings in JSON text, so the
 * text still parses to the same value (the JSON mode's document, questions and schema).
 */
export function inertJson(json: string): string {
  return json.replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(BRACKET_MARKER, '\\u005b$1\\u005d');
}

/** One pass's prompt: the messages (chat routes) and the full templated text (raw routes). */
export interface SemifPrompt { messages: ChatMessage[]; text: string }
export function semifPrompt(state: S1State, question: S1Question, options: readonly SemifOption[]): SemifPrompt {
  const messages = semifMessages(state, question, options);
  return { messages, text: renderQwenChat(messages) };
}

/**
 * The temperature a model's `calib.json` sets (§2.5): `t_global`, else `exp(b)`; 1 without one. The
 * feature-conditioned T(x) is never applied (Eikos's own calib_fit.py found it worse out of distribution).
 */
export function calibTemperature(calib: unknown): number {
  if (!calib || typeof calib !== 'object' || Array.isArray(calib)) return 1;
  const record = calib as Record<string, unknown>;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.05 && value <= 20;
  if (valid(record.t_global)) return record.t_global;
  if (typeof record.b === 'number' && Number.isFinite(record.b)) {
    const t = Math.exp(record.b);
    if (valid(t)) return t;
  }
  return 1;
}
