// A stand-in for a local Ollama server (v0.34.x behaviour, from the Ollama source read for the spec) on
// 127.0.0.1:0: /api/version, /api/status, /api/tags, /api/show, /api/generate (raw) and /api/chat with
// logprobs/top_logprobs, `format` and `think`. Nothing leaves this computer: "cloud" requests are only
// recorded. The "model" is a scripted brain over the SemIf prompt, so tests can make it right, biased,
// thinking, low on letter mass or missing a letter.
import { createServer } from 'node:http';

const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
export const FAKE_DIGEST = 'a1b2c3d4e5f6'.padEnd(64, '0');
const FILLERS = ['The', '\n', 'I', 'Option', ' The', 'Answer', '**', 'Based', 'Let', '1', 'It', '{"', 'Yes', 'No', '<', 'answer', 'Choice', 'This', 'We', 'In', 'To', 'Sure', 'Okay', 'Here', 'My', 'As', 'For', 'So', 'Given', 'None'];

/** Numeric compare of `a.b.c` versions. */
export function versionAtLeast(version, floor) {
  const parse = text => text.split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parse(version), b = parse(floor);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Ollama's name source parser (`:cloud`, `-cloud`, `:local`). */
function parseRef(raw) {
  const i = raw.lastIndexOf(':');
  if (i >= 0) {
    const suffixRaw = raw.slice(i + 1), suffix = suffixRaw.toLowerCase();
    if (suffix === 'cloud') return { base: raw.slice(0, i), source: 'cloud' };
    if (suffix === 'local') return { base: raw.slice(0, i), source: 'local' };
    if (!suffixRaw.includes('/') && suffix.endsWith('-cloud')) return { base: raw.slice(0, i + 1) + suffixRaw.slice(0, -6), source: 'cloud' };
  }
  return { base: raw, source: 'unspecified' };
}
const canonical = name => name.slice(name.lastIndexOf('/') + 1).includes(':') ? name : `${name}:latest`;

/** The SemIf payload inside a prompt: the raw ChatML text, or the chat user message. null when unreadable (a truncated prompt). */
export function parseSemifUser(text) {
  const start = text.indexOf('<|im_start|>user\n');
  const end = text.indexOf('<|im_end|>\n<|im_start|>assistant');
  const user = start >= 0 && end > start ? text.slice(start + '<|im_start|>user\n'.length, end) : text;
  try {
    const payload = JSON.parse(user);
    return payload && Array.isArray(payload.options) ? payload : null;
  } catch { return null; }
}

/**
 * The default brain: an option is preferred when its label (before `:`) is in `prefer`, else option A.
 * Returns one weight per option, in pass order (A, B, …).
 */
export function makeBrain({ prefer = [], strength = 0.8, positionBias = 0 } = {}) {
  return ({ options }) => {
    const labels = options.map(option => option.description.slice(0, option.description.indexOf(':')));
    let index = labels.findIndex(label => prefer.includes(label));
    if (index < 0) index = 0;
    const rest = (1 - strength) / (options.length - 1);
    const weights = options.map((_, i) => i === index ? strength : rest);
    // Letter-position bias: extra weight on A, whatever option sits there.
    weights[0] += positionBias;
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / total);
  };
}

/** The top-k list for one position: the letters at `probs × letterMass`, fillers sharing the rest, highest first. */
export function topTokens(probs, { k = 20, letterMass = 0.97, spaceVariants = false, bpe = null, dropLetter = null } = {}) {
  const entries = [];
  probs.forEach((p, i) => {
    const letter = LETTERS[i];
    const mass = letter === dropLetter ? 1e-12 : p * letterMass;
    const prefix = bpe === 'gpt2' ? 'Ġ' : bpe === 'sentencepiece' ? '▁' : '';
    if (spaceVariants) { entries.push({ token: `${prefix}${letter}`, p: mass * 0.7 }); entries.push({ token: ` ${letter}`, p: mass * 0.3 }); }
    else entries.push({ token: `${prefix}${letter}`, p: mass });
  });
  const fillerMass = Math.max(0, 1 - letterMass);
  FILLERS.forEach((token, i) => entries.push({ token, p: fillerMass * (FILLERS.length - i) / (FILLERS.length * (FILLERS.length + 1) / 2) }));
  return entries.filter(entry => entry.p > 0).sort((a, b) => b.p - a.p).slice(0, k).map(entry => ({ token: entry.token, logprob: Math.log(entry.p), bytes: [...Buffer.from(entry.token)] }));
}

/** A thinking model's first token: a thought, with almost no mass on letters. */
function thoughtTokens(k) {
  return ['<think>', 'Okay', 'Let', 'Hmm', 'The', 'First', 'We', 'I', 'A', 'B'].slice(0, k).map((token, i) => ({ token, logprob: Math.log(i < 8 ? 0.12 - i * 0.01 : 0.001) }));
}

/** The JSON-mode questions block of a CanvasTTY prompt. */
function parseJsonModeQuestions(text) {
  const start = text.indexOf('Questions (answer each one independently about the document):\n');
  const end = text.indexOf('\n\nReturn one JSON object');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(text.slice(start + 'Questions (answer each one independently about the document):\n'.length, end)); } catch { return null; }
}

const DEFAULT_MODELS = [
  { name: 'qwen3.5:9b', family: 'qwen35', capabilities: ['completion', 'tools', 'thinking'], contextLength: 262144, thinking: { values: [true, false], default: true }, thinks: true },
  { name: 'gemma3:12b', family: 'gemma3', capabilities: ['completion', 'vision'], contextLength: 131072, thinking: { values: [false], default: false }, thinks: false },
  { name: 'nomic-embed-text:latest', family: 'nomic-bert', capabilities: ['embedding'], contextLength: 2048, thinking: null, thinks: false },
  // A pulled cloud stub under a plain name: only remote_host marks it.
  { name: 'gemini-3-flash-preview:latest', family: 'gemini', capabilities: ['completion', 'vision', 'tools', 'thinking'], contextLength: 1048576, thinking: null, thinks: false, remoteHost: 'https://ollama.com:443', remoteModel: 'gemini-3-flash-preview' }
];

export async function startFakeOllama(options = {}) {
  const state = {
    version: options.version ?? '0.34.4',
    cloudDisabled: options.cloudDisabled ?? false,
    models: (options.models ?? DEFAULT_MODELS).map(model => ({ digest: FAKE_DIGEST, thinking: null, thinks: false, ...model })),
    brain: options.brain ?? makeBrain(options),
    letterMass: options.letterMass ?? 0.97,
    spaceVariants: options.spaceVariants ?? false,
    bpe: options.bpe ?? null,
    dropLetter: options.dropLetter ?? null,
    /** Any request carrying a `think` field gets 400 "does not support thinking" (an older server). */
    rejectThinkField: options.rejectThinkField ?? false,
    /** 200 with an `{"error": …}` body (a failure after the response started). */
    errorLine: options.errorLine ?? false,
    /** JSON-mode answers: (questions) → {qid: {label: p}}; default: the first label 0.7. */
    jsonBrain: options.jsonBrain ?? null,
    /** Reply to every chat/generate with this model name (a server answering under another name). */
    replyModel: options.replyModel ?? null,
    /** Mark every reply as answered through ollama.com (remote_host), whatever was asked. */
    replyRemote: options.replyRemote ?? false,
    /** Tokens per character of the fake tokenizer (more than CanvasTTY's chars/3.5 estimate). */
    charsPerToken: options.charsPerToken ?? 3,
    defaultNumCtx: options.defaultNumCtx ?? 4096,
    requests: [],
    /** What would have gone to ollama.com (recorded, never sent). */
    cloudRequests: [],
    // L22: models already loaded (GET /api/ps lists them with the server's context).
    loaded: new Set(options.loaded ?? []),
    unloads: []
  };
  const statusRoute = () => versionAtLeast(state.version, '0.16.2');
  const pinEnforced = () => versionAtLeast(state.version, '0.18.0');
  const logprobsSupported = () => versionAtLeast(state.version, '0.12.11');
  const find = name => state.models.find(model => model.name === name || model.name === canonical(name));

  /** Resolves a request name to {model, cloud} or an error {status, error}. */
  function resolve(raw) {
    const ref = parseRef(raw);
    if (ref.source === 'cloud') return { model: { name: raw, family: 'cloud', capabilities: ['completion', 'tools'], contextLength: 131072, thinking: null, thinks: false, remoteHost: 'https://ollama.com:443', remoteModel: ref.base }, cloud: true };
    const model = find(ref.base);
    if (!model) return { status: 404, error: `model '${raw}' not found, try pulling it first` };
    if (model.remoteHost) {
      // v0.18.0+: `name:local` for a model with remote_host is refused; below that the stub is forwarded.
      if (ref.source === 'local' && pinEnforced()) return { status: 404, error: `model '${raw}' not found` };
      return { model, cloud: true };
    }
    return { model, cloud: false };
  }

  function tagEntry(model) {
    return {
      name: model.name, model: model.name, modified_at: '2026-09-20T10:00:00Z', size: model.remoteHost ? 384 : 6_600_000_000, digest: model.digest,
      ...(model.remoteHost ? { remote_host: model.remoteHost, remote_model: model.remoteModel } : {}),
      details: { parent_model: '', format: 'gguf', family: model.family, families: [model.family], parameter_size: '9.7B', quantization_level: 'Q4_K_M', context_length: model.contextLength },
      capabilities: model.capabilities
    };
  }

  function showBody(model) {
    return {
      ...(model.thinking ? { thinking: model.thinking } : {}),
      license: 'Apache 2.0', template: '{{ .Prompt }}', details: { format: 'gguf', family: model.family },
      ...(model.numCtx ? { parameters: `stop "<|im_end|>"\nnum_ctx ${model.numCtx}\ntemperature 0.6` } : {}),
      model_info: { 'general.architecture': model.family, [`${model.family}.context_length`]: model.contextLength },
      capabilities: model.capabilities, modified_at: '2026-09-20T10:00:00Z',
      ...(model.remoteHost ? { remote_host: model.remoteHost, remote_model: model.remoteModel } : {})
    };
  }

  /** The model's own chat template (Qwen-style ChatML), with thinking when the model thinks. */
  function renderChat(messages, thinking) {
    return messages.map(message => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`).join('') + `<|im_start|>assistant\n${thinking ? '<think>\n' : '<think>\n\n</think>\n\n'}`;
  }

  function inference(path, body) {
    if (typeof body.model !== 'string') return [400, { error: 'model is required' }];
    const resolved = resolve(body.model);
    if (resolved.error) return [resolved.status, { error: resolved.error }];
    const { model, cloud } = resolved;
    // Unload: no prompt/messages and keep_alive 0.
    if (body.keep_alive === 0 && body.prompt === undefined && body.messages === undefined) {
      state.unloads.push(body.model); state.loaded.delete(model.name);
      return [200, { model: body.model, created_at: new Date().toISOString(), response: '', done: true, done_reason: 'unload' }];
    }
    if (cloud) {
      if (state.cloudDisabled) return [403, { error: 'ollama cloud is disabled: remote inference is unavailable' }];
      state.cloudRequests.push({ path, body });
    }
    if (body.top_logprobs !== undefined && (!Number.isInteger(body.top_logprobs) || body.top_logprobs < 0 || body.top_logprobs > 20)) return [400, { error: 'top_logprobs must be between 0 and 20' }];
    if (state.rejectThinkField && 'think' in body) return [400, { error: `"${body.model}" does not support thinking` }];
    if (body.think === true && !model.capabilities.includes('thinking')) return [400, { error: `"${body.model}" does not support thinking` }];
    if (state.errorLine) return [200, { error: 'an error was encountered while running the model' }];
    state.loaded.add(model.name);
    // Thinking: an explicit value wins; without one, metadata's default; a thinking model with no metadata thinks.
    const thinking = path === '/api/chat' && model.thinks && (body.think === undefined ? (model.thinking ? model.thinking.default === true : true) : body.think !== false);
    let text = path === '/api/generate' ? (body.raw === true ? body.prompt : renderChat([{ role: 'user', content: String(body.prompt ?? '') }], false)) : renderChat(body.messages ?? [], thinking);
    const numCtx = body.options?.num_ctx ?? state.defaultNumCtx;
    const tokens = Math.ceil(text.length / state.charsPerToken);
    if (tokens > numCtx) {
      if (body.truncate === false) return [400, { error: 'the input length exceeds the context length' }];
      // truncate defaults to true: the front of the prompt is cut silently.
      text = text.slice(text.length - numCtx * state.charsPerToken);
    }
    const reply = { model: state.replyModel ?? body.model, created_at: new Date().toISOString(), done: true, done_reason: 'length', prompt_eval_count: Math.min(tokens, numCtx), eval_count: 1, ...(cloud || state.replyRemote ? { remote_host: model.remoteHost ?? 'https://ollama.com:443', remote_model: model.remoteModel ?? model.name } : {}) };
    // JSON mode (a `format` schema, or a cloud model asked in the prompt).
    const jsonQuestions = parseJsonModeQuestions(text);
    if (jsonQuestions) {
      const answers = state.jsonBrain ? state.jsonBrain(jsonQuestions) : Object.fromEntries(Object.entries(jsonQuestions).map(([id, question]) => {
        const labels = Object.keys(question.labels);
        return [id, Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 0.7 : Number((0.3 / (labels.length - 1)).toFixed(4))]))];
      }));
      const content = typeof answers === 'string' ? answers : JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).map(([id, probabilities]) => [id, { probabilities }])) });
      return [200, { ...reply, message: { role: 'assistant', content }, eval_count: 40 }];
    }
    const payload = parseSemifUser(text);
    const k = body.top_logprobs ?? 0;
    let top;
    if (thinking) top = thoughtTokens(k);
    else if (!payload) top = topTokens([1, 0], { k, letterMass: 0.01 });
    else top = topTokens(state.brain(payload), { k, letterMass: state.letterMass, spaceVariants: state.spaceVariants, bpe: state.bpe, dropLetter: state.dropLetter });
    const first = top[0] ?? { token: 'A', logprob: 0 };
    const logprobs = body.logprobs && logprobsSupported() ? { logprobs: [{ token: first.token, logprob: first.logprob, top_logprobs: top }] } : {};
    if (path === '/api/generate') return [200, { ...reply, response: first.token, ...logprobs }];
    return [200, { ...reply, message: { role: 'assistant', content: first.token, ...(thinking ? { thinking: 'Let me think about the options.' } : {}) }, ...logprobs }];
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    state.requests.push({ method: req.method, path, headers: req.headers, raw, json });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && path === '/api/version') return send(200, { version: state.version });
    if (req.method === 'GET' && path === '/api/status') return statusRoute() ? send(200, { cloud: { disabled: state.cloudDisabled, source: state.cloudDisabled ? 'config' : 'none' } }) : send(404, { error: 'not found' });
    if (req.method === 'GET' && path === '/api/tags') return send(200, { models: state.models.map(tagEntry) });
    if (req.method === 'GET' && path === '/api/ps') return send(200, { models: state.models.filter(model => state.loaded.has(model.name)).map(model => ({ name: model.name, model: model.name, size: 6_600_000_000, size_vram: 6_600_000_000, digest: model.digest, details: { family: model.family }, expires_at: '2026-09-25T12:00:00Z', context_length: model.numCtx ?? state.defaultNumCtx })) });
    if (req.method === 'POST' && path === '/api/show') {
      if (!json || typeof json.model !== 'string') return send(400, { error: 'model is required' });
      const resolved = resolve(json.model);
      if (resolved.error) return send(resolved.status, { error: resolved.error });
      if (resolved.cloud && parseRef(json.model).source === 'cloud') state.cloudRequests.push({ path, body: json });
      return send(200, showBody(resolved.model));
    }
    if (req.method === 'POST' && (path === '/api/generate' || path === '/api/chat')) {
      if (!json) return send(400, { error: 'invalid JSON' });
      const [status, body] = inference(path, json);
      return send(status, body);
    }
    return send(404, { error: '404 page not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    get requests() { return state.requests; },
    inferences() { return state.requests.filter(item => item.path === '/api/generate' || item.path === '/api/chat'); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
