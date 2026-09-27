// A faithful stand-in for eikos/serve.py (commit f9dff40) on 127.0.0.1:0: its routes, answer shapes,
// validation, errors (with exception text), tournament, --sym and sessions. The "model" is a scripted
// brain, so tests can make it right, confidently wrong, noisy, position-biased or drifted.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/** serve.py reports its --model argument: a filesystem path, here with a space and a user name. */
export const EIKOS_MODEL_PATH = '/Users/Test User/models/Eikos-4B-MLX-8bit';
const SYSTEM = 'Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning.';
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

class PyError extends Error {
  constructor(type, message) { super(message); this.pyType = type; }
}
const valueError = message => new PyError('ValueError', message);
const isDict = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Python's json.dumps(value, ensure_ascii=False): separators ", " and ": ". */
export function pyJsonDumps(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJsonDumps(item)}`).join(', ')}}`;
}

/** Python's str(value): what serve.py shows a model for a non-string criterion. */
function pyStr(value) {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(', ')}}`;
}

/** decision_core.options_of */
function optionsOf(question) {
  if (!isDict(question)) throw new PyError('AttributeError', `'${question === null ? 'NoneType' : Array.isArray(question) ? 'list' : typeof question}' object has no attribute 'get'`);
  const type = question.type, criteria = question.criteria;
  if (type === 'noul' || type === 'boolean') {
    const c = criteria || {};
    return [['yes', Object.hasOwn(c, 'true') ? pyStr(c.true) : 'yes'], ['no', Object.hasOwn(c, 'false') ? pyStr(c.false) : 'no']];
  }
  if (type === 'score') {
    if (isDict(criteria)) return Object.keys(criteria).map(key => [key, pyStr(criteria[key])]);
    return (criteria || []).map((level, index) => [String(index), pyStr(level)]);
  }
  if (isDict(criteria)) return Object.keys(criteria).map(key => [key, pyStr(criteria[key])]);
  return (question.options || criteria || []).map(item => { const key = pyStr(item); return [key, key]; });
}

/** decision_core.render_user (semif) */
function renderUser(state, question, opts) {
  const noul = question.type === 'noul' || question.type === 'boolean';
  const shown = label => noul ? ({ yes: 'true', no: 'false' }[label] ?? label) : label;
  return pyJsonDumps({ evidence: state, criterion: question.instructions ?? '', options: opts.map(([label, description], i) => ({ letter: LETTERS[i], description: `${shown(label)}: ${description}` })) });
}

// ---------------------------------------------------------------------------
// The scripted "model"
// ---------------------------------------------------------------------------

const BATTERY = {
  noul: 'Did every test in `tests` pass?',
  choice: 'Which area of the code do `changed_files` belong to?',
  score: 'How risky is merging a change to `changed_files`?'
};
const LEVELS = ['Harmless: documentation only', 'Code that needs a quick review', 'Code that could break production'];
const TABLES = {
  known: { noul: 0.93, choice: { none_of_these: 0.86, billing: 0.07, database: 0.07 }, score: [0.88, 0.1, 0.02] },
  wrong: { noul: 0.04, choice: { billing: 0.9, database: 0.05, none_of_these: 0.05 }, score: [0.03, 0.07, 0.9] },
  unsure: { noul: 0.4, choice: { billing: 0.45, none_of_these: 0.35, database: 0.2 }, score: [0.3, 0.6, 0.1] }
};

function instructionText(question) {
  const value = question.instructions;
  return typeof value === 'string' ? value : isDict(value) && typeof value.question === 'string' ? value.question : '';
}

function hashUnit(text) { return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16) / 0xffffffff; }

/**
 * The model: (state, question, labels) → probabilities aligned with `labels`. Noul labels are yes/no (or true/false).
 * behaviour: 'known' | 'wrong' | 'unsure'; biasStrength mixes in a one-hot on the first presented option;
 * noise perturbs every call; fingerprintShift moves mass from the top option to the second.
 */
export function makeBrain({ behaviour = 'known', biasStrength = 0, noise = 0, fingerprintShift = 0, random = Math.random } = {}) {
  const table = TABLES[behaviour] ?? TABLES.known;
  return function brain(state, question, labels) {
    const text = instructionText(question);
    let vector;
    if (text.includes(BATTERY.noul)) vector = labels.map(label => ['yes', 'true'].includes(label) ? table.noul : 1 - table.noul);
    else if (text.includes(BATTERY.choice)) vector = labels.map(label => table.choice[label] ?? 0.01);
    else if (text.includes(BATTERY.score) && Array.isArray(question.criteria)) vector = question.criteria.map(level => table.score[LEVELS.indexOf(level)] ?? 0.01);
    else if (text.includes(BATTERY.score) && isDict(question.criteria)) vector = labels.map(label => table.score[LEVELS.indexOf(question.criteria[label])] ?? 0.01);
    else {
      const weights = labels.map(label => 0.2 + hashUnit(`${label}\u0000${text}\u0000${typeof state === 'string' ? state : JSON.stringify(state)}`));
      vector = weights;
    }
    let sum = vector.reduce((a, b) => a + b, 0);
    vector = vector.map(p => p / sum);
    if (biasStrength) vector = vector.map((p, i) => (1 - biasStrength) * p + (i === 0 ? biasStrength : 0));
    if (noise) vector = vector.map(p => Math.max(0.001, p + (random() * 2 - 1) * noise));
    sum = vector.reduce((a, b) => a + b, 0);
    vector = vector.map(p => p / sum);
    if (fingerprintShift) {
      const order = vector.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
      const moved = Math.min(fingerprintShift, order[0][0]);
      vector[order[0][1]] -= moved; vector[order[1][1]] += moved;
    }
    return vector;
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} [options.model] the --model path it reports
 * @param {(state, question, labels) => number[]} [options.brain]
 * @param {number} [options.maxTokens] --max-tokens (PyTorch path: 422 above it)
 * @param {boolean} [options.vllm] behind vLLM: an over-long prompt comes back as a 500
 * @param {boolean} [options.sym] --sym: average both option orders, double input_tokens
 * @param {number} [options.statelessDelayMs] [options.sessionDelayMs] simulated inference time
 */
export async function startFakeEikos(options = {}) {
  const state = {
    model: options.model ?? EIKOS_MODEL_PATH,
    brain: options.brain ?? makeBrain(options),
    maxTokens: options.maxTokens ?? 16000,
    vllm: options.vllm ?? false,
    sym: options.sym ?? false,
    statelessDelayMs: options.statelessDelayMs ?? 0,
    sessionDelayMs: options.sessionDelayMs ?? 0,
    sessions: new Map(),
    /** When set, the reported model rotates through these on every POST (an unstable model id). */
    rotateModels: options.rotateModels ?? null,
    posts: 0,
    failures: [],
    requests: []
  };

  const tokens = text => Math.ceil(text.length / 4);

  function distribution(evidence, question, opts) {
    const user = renderUser(evidence, question, opts);
    const n = tokens(SYSTEM) + tokens(user);
    if (n > state.maxTokens) {
      if (state.vllm) throw new PyError('HTTPError', 'HTTP Error 400: Bad Request');
      throw valueError(`prompt with ${n} tokens > max ${state.maxTokens}`);
    }
    const probs = state.brain(evidence, question, opts.map(([label]) => label));
    return [Object.fromEntries(opts.map(([label], i) => [label, probs[i]])), n];
  }

  /** decision_core.tournament */
  function tournament(evidence, question, opts) {
    if (opts.length <= 26) return distribution(evidence, question, opts);
    let finalists = [], total = 0;
    for (let i = 0; i < opts.length; i += 20) {
      const block = opts.slice(i, i + 20);
      const [p, n] = distribution(evidence, question, block);
      total += n;
      finalists = finalists.concat([...block].sort((a, b) => p[b[0]] - p[a[0]]).slice(0, 2));
    }
    const [final, n] = distribution(evidence, question, finalists.slice(0, 26));
    const probs = Object.fromEntries(opts.map(([label]) => [label, 1e-4]));
    Object.assign(probs, final);
    const z = Object.values(probs).reduce((a, b) => a + b, 0);
    return [Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, v / z])), total + n];
  }

  /** serve.py Decider._format */
  function format(question, probs) {
    const type = question.type;
    const top = Object.keys(probs).reduce((best, key) => probs[key] > probs[best] ? key : best);
    if (type === 'noul' || type === 'boolean') return { type, noul: probs.yes, probability: probs.yes, value: probs.yes >= 0.5, confidence: Math.max(...Object.values(probs)) };
    if (type === 'score') {
      if (!/^-?\d+$/u.test(top)) throw valueError(`invalid literal for int() with base 10: '${top}'`);
      let expected = 0;
      for (const [key, value] of Object.entries(probs)) {
        if (!/^[-+]?\d+(?:\.\d+)?$/u.test(key)) throw valueError(`could not convert string to float: '${key}'`);
        expected += Number(key) * value;
      }
      return { type: 'score', probabilities: probs, score: Number(top), expected, confidence: probs[top] };
    }
    return { type: 'choice', choice: top, probabilities: probs, confidence: probs[top] };
  }

  /** serve.py Decider.decide_all (the verify path is off: --verify-budget 0 ignores "mode") */
  function decideAll(evidence, questions) {
    if (Array.isArray(questions)) {
      if (questions.length && typeof questions[0] === 'string') throw new PyError('TypeError', 'list indices must be integers or slices, not str');
    } else if (!isDict(questions)) throw new PyError('AttributeError', `'${typeof questions}' object has no attribute 'items'`);
    const out = {};
    for (const name of Object.keys(questions)) {
      const question = questions[name];
      const opts = optionsOf(question);
      if (opts.length < 2) throw valueError(`${name}: at least 2 options are required`);
      let [probs, n] = tournament(evidence, question, opts);
      if (state.sym) {
        const [reverse, n2] = tournament(evidence, question, [...opts].reverse());
        probs = Object.fromEntries(Object.keys(probs).map(key => [key, 0.5 * (probs[key] + reverse[key])]));
        n += n2;
      }
      out[name] = [format(question, probs), n];
    }
    return out;
  }

  const send = (res, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
  };
  const pyError = error => error instanceof PyError ? `${error.pyType}: ${error.message}` : `${error?.name ?? 'Exception'}: ${error?.message ?? error}`;
  const parseBody = raw => {
    try { return raw.length ? JSON.parse(raw) : {}; }
    catch { throw valueError('Expecting value: line 1 column 1 (char 0)'); }
  };
  const envelope = (res, t0) => ({ answers: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v[0]])), usage: { input_tokens: Object.values(res).reduce((sum, v) => sum + v[1], 0), output_tokens: 0 }, latency_s: (performance.now() - t0) / 1000 });
  const wait = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : undefined;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* recorded raw */ }
    state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, raw, json });
    const failure = req.method === 'POST' ? state.failures.shift() : undefined;
    if (req.method === 'POST' && state.rotateModels) state.model = state.rotateModels[state.posts++ % state.rotateModels.length];
    if (failure) { await wait(failure.delayMs); return send(res, failure.status, failure.body ?? {}); }
    const path = req.url ?? '/';
    const parts = path.replace(/^\/+|\/+$/gu, '').split('/');
    const t0 = performance.now();
    if (req.method === 'GET') {
      if (path === '/health' || path === '/v1/health') return send(res, 200, { ok: true, model: state.model });
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
        const ok = state.sessions.delete(parts[2]);
        return send(res, ok ? 200 : 404, { ok });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (parts[0] === 'v1' && parts[1] === 'sessions') {
      try {
        const body = parseBody(raw);
        if (!isDict(body)) throw new PyError('AttributeError', `'${Array.isArray(body) ? 'list' : typeof body}' object has no attribute 'get'`);
        if (parts.length === 2) {
          let initial = Object.hasOwn(body, 'state') ? body.state : '';
          if (typeof initial !== 'string') initial = pyJsonDumps(initial);
          const id = randomBytes(8).toString('hex');
          state.sessions.set(id, { state: initial, t: Date.now() });
          return send(res, 200, { session_id: id, chars: initial.length });
        }
        const session = state.sessions.get(parts[2]);
        if (!session) return send(res, 404, { error: 'unknown session' });
        if (parts.length === 4 && parts[3] === 'append') {
          const text = Object.hasOwn(body, 'text') ? body.text : '';
          session.state += typeof text === 'string' ? text : pyJsonDumps(text);
          session.t = Date.now();
          return send(res, 200, { ok: true, chars: session.state.length });
        }
        if (parts.length === 4 && (parts[3] === 'systemone' || parts[3] === 'evaluate')) {
          await wait(state.sessionDelayMs);
          const out = decideAll(session.state, body.questions || {});
          session.t = Date.now();
          return send(res, 200, { model: state.model, session_id: parts[2], ...envelope(out, t0) });
        }
        return send(res, 404, { error: 'not found' });
      } catch (error) {
        return error instanceof PyError && error.pyType === 'ValueError' ? send(res, 422, { error: error.message }) : send(res, 500, { error: pyError(error) });
      }
    }
    if (path !== '/v1/systemone' && path !== '/v1/evaluate') return send(res, 404, { error: 'not found' });
    try {
      const body = parseBody(raw);
      if (!isDict(body)) throw new PyError('AttributeError', `'${Array.isArray(body) ? 'list' : typeof body}' object has no attribute 'get'`);
      await wait(state.statelessDelayMs);
      const out = decideAll(Object.hasOwn(body, 'state') ? body.state : '', body.questions || {});
      return send(res, 200, { model: state.model, ...envelope(out, t0) });
    } catch (error) {
      return error instanceof PyError && error.pyType === 'ValueError' ? send(res, 422, { error: error.message }) : send(res, 500, { error: pyError(error) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get model() { return state.model; },
    requests: state.requests,
    /** Scripted replies for the next POSTs: { status, body, delayMs }. */
    failNext(...items) { state.failures.push(...items); },
    setBrain(brain) { state.brain = brain; },
    set(options) { Object.assign(state, options); },
    liveSessions() { return [...state.sessions.keys()]; },
    sessionState(id) { return state.sessions.get(id)?.state; },
    /** The server restarted: every session is gone. */
    restart() { state.sessions.clear(); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
