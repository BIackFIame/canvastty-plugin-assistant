// A System One server on 127.0.0.1:0 that answers like TypeSafe direct, OpenRouter, Vercel's /typesafe route or
// laya-serve (mode 'eikos' delegates to fake-eikos.mjs): their validation, real error bodies, model ids,
// rounding, extras and headers. Failures are scripted; every received request is recorded.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { makeBrain, startFakeEikos } from './fake-eikos.mjs';

export { makeBrain } from './fake-eikos.mjs';

const ROUTES = {
  typesafe: ['/v1/systemone'],
  openrouter: ['/api/v1/systemone', '/api/alpha/decisions'],
  vercel: ['/typesafe/v1/systemone'],
  laya: ['/v1/systemone']
};
const isDict = value => !!value && typeof value === 'object' && !Array.isArray(value);
const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const spread = (n, top) => n < 2 ? 1 : Math.min(1, Math.max(0, (n * top - 1) / (n - 1)));
const entropyConf = vector => { const n = vector.length; const h = -vector.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0); return n < 2 ? 1 : 1 - h / Math.log(n); };
export const stateHash = state => createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);

function authFailure(mode, header, keys) {
  if (mode === 'laya') {
    if (!keys.length) return null;
    return keys.some(key => header === `Bearer ${key}`) ? null : [401, { detail: 'invalid or missing bearer token' }];
  }
  if (!header) {
    if (mode === 'typesafe') return [403, { detail: { error_type: 'authentication_error', message: 'Must supply an API key! Check your request and try again.' } }];
    if (mode === 'openrouter') return [401, { error: { code: 401, message: 'Missing Authentication header' } }];
    return [401, { message: 'Authentication failed', error_type: 'authentication_error' }];
  }
  if (keys.some(key => header === `Bearer ${key}`)) return null;
  if (mode === 'typesafe') return [401, { detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server. Please check your API key and try again.' } }];
  if (mode === 'openrouter') return [401, { error: { code: 401, message: 'Missing Authentication header' } }];
  return [401, { message: 'Authentication failed', error_type: 'authentication_error' }];
}

/** The OpenAPI's request rules, answered with each route's own error body. */
function validationFailure(mode, body) {
  const unprocessable = (loc, msg, type, input) => mode === 'typesafe'
    ? [422, { detail: [{ loc, msg, type, input }] }]
    : mode === 'openrouter' ? [400, { error: { code: 400, message: `${loc.slice(1).join('.')}: ${msg}` } }]
      : mode === 'vercel' ? [400, { message: `${loc.slice(1).join('.')}: ${msg}`, error_type: 'invalid_request' }]
        : [422, { detail: `${loc.slice(1).join('.')}: ${msg}` }];
  if (!isDict(body)) return mode === 'laya' ? [400, { detail: "request body must be an object with a 'questions' field" }] : unprocessable(['body'], 'Input should be a valid dictionary', 'dict_type', body);
  if (mode === 'laya') {
    if (!isDict(body.questions)) return [400, { detail: "'questions' must be an object" }];
    if (Object.keys(body.questions).length > 64) return [413, { detail: `too many questions (${Object.keys(body.questions).length} > 64)` }];
    const text = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
    if ((text ?? '').length > 50000) return [413, { detail: `state too large (${text.length} > 50000 chars)` }];
  } else {
    if (typeof body.model !== 'string') return mode === 'vercel' ? [400, { message: 'model: Required', error_type: 'invalid_request' }] : unprocessable(['body', 'model'], 'Field required', 'missing', body);
    const state = body.state;
    if (!(typeof state === 'string' || Array.isArray(state) || isDict(state))) return unprocessable(['body', 'state'], 'Input should be a valid string', 'string_type', state);
    if (!isDict(body.questions) || !Object.keys(body.questions).length) return unprocessable(['body', 'questions'], 'Dictionary should have at least 1 item after validation', 'too_short', body.questions);
  }
  for (const [id, question] of Object.entries(body.questions)) {
    if (!isDict(question) || !['noul', 'choice', 'score'].includes(question.type)) return unprocessable(['body', 'questions', id], "Input tag does not match any of the expected tags: 'noul', 'choice', 'score'", 'union_tag_invalid', question);
    if (mode === 'openrouter' && question.instructions == null) return [400, { error: { code: 400, message: `questions.${id}.instructions: Required` } }];
    if (question.type === 'noul' && question.criteria != null && mode === 'openrouter' && (question.criteria.true == null || question.criteria.false == null)) return [400, { error: { code: 400, message: 'DecisionsNoulQuestion requires both keys when criteria are supplied' } }];
    if (question.type === 'choice') {
      if (!isDict(question.criteria) || Object.keys(question.criteria).length < 1) return unprocessable(['body', 'questions', id, 'choice', 'criteria'], 'Input should be a valid dictionary', 'dict_type', question.criteria);
      if (Object.keys(question.criteria).length > 255) return unprocessable(['body', 'questions', id, 'choice', 'criteria'], 'Choice questions support at most 255 options', 'too_long', question.criteria);
      for (const [label, description] of Object.entries(question.criteria)) {
        if (!(description === null || typeof description === 'string' || typeof description === 'object')) return unprocessable(['body', 'questions', id, 'choice', 'criteria', label], 'Input should be a valid string', 'string_type', description);
      }
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 1) return unprocessable(['body', 'questions', id, 'score', 'criteria'], 'Input should be a valid list', 'list_type', question.criteria);
      const bad = question.criteria.findIndex(level => level === null);
      if (bad >= 0) return unprocessable(['body', 'questions', id, 'score', 'criteria', bad], 'Input should be a valid string', 'string_type', null);
      if (mode === 'vercel' && question.criteria.length > 10) return [400, { message: `questions.${id}.criteria: at most 10 levels`, error_type: 'invalid_request' }];
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {'typesafe'|'openrouter'|'vercel'|'laya'|'eikos'} [options.mode]
 * @param {string[]} [options.keys] accepted keys (laya: none = no auth)
 * @param {string} [options.latest] what jev-latest resolves to
 * @param {(state, question, labels) => number[]} [options.brain]
 */
export async function startFakeSystemOne(options = {}) {
  const mode = options.mode ?? 'typesafe';
  if (mode === 'eikos') return startFakeEikos(options);
  const state = {
    keys: options.keys ?? (mode === 'laya' ? [] : ['k-good']),
    latest: options.latest ?? 'jev-1.13.0',
    brain: options.brain ?? makeBrain(options),
    decimals: options.decimals ?? (mode === 'laya' ? 4 : 2),
    delayMs: options.delayMs ?? 0,
    failures: [],
    requests: [],
    /** Per question id: a vector in label order, or { label: p }. */
    answers: {},
    /** Per stateHash(state): { questionId: vector }. */
    byState: {},
    /** Per question id: added to the top probability after rounding (±0.01 makes a 1.01 / 0.99 sum). */
    skew: {},
    omitProbabilities: false,
    /** 422 for any score question (a server without score support). */
    rejectScore: false,
    /** 413 above this many questions. */
    maxQuestions: Infinity,
    /** Served at GET /v1/limits when set. */
    limits: null,
    omitType: false,
    omitConfidence: false,
    extraAnswerFields: {}
  };
  const decimals = () => state.decimals;

  function resolveModel(model) {
    if (mode === 'typesafe') {
      if (model === 'jev-latest' || model === 'jev-preview') return state.latest;
      if (model === 'jev-1.13') return state.latest.startsWith('jev-1.13.') ? state.latest : 'jev-1.13.0';
      if (model === 'jev-1.13.0' || model === state.latest) return model;
      return null;
    }
    if (mode === 'openrouter') return ['typesafe/jev-1.13', '~typesafe/jev-latest', 'jev-1.13', 'jev-latest'].includes(model) ? 'typesafe/jev-1.13-20260917' : null;
    if (mode === 'vercel') return model === 'typesafe-ai/jev' ? model : null;
    return 'laya-rl-agent';
  }

  function unknownModel(model) {
    if (mode === 'typesafe') return [400, { detail: { error_type: 'api_usage_error', message: `Unknown model: ${model}` } }];
    if (mode === 'openrouter') return [400, { error: { code: 400, message: `${model} is not a valid model ID` } }];
    return [400, { message: `Unknown model: ${model}`, error_type: 'invalid_request' }];
  }

  function vectorFor(id, question, labels, body) {
    const scripted = state.byState[stateHash(body.state)]?.[id] ?? state.answers[id];
    let vector = scripted === undefined ? state.brain(body.state, question, labels) : Array.isArray(scripted) ? scripted : labels.map(label => scripted[label] ?? 0);
    const sum = vector.reduce((a, b) => a + b, 0);
    if (scripted === undefined) vector = vector.map(p => p / sum);
    return vector;
  }

  function answer(id, question, body) {
    const labels = question.type === 'noul' ? ['true', 'false'] : question.type === 'score' ? question.criteria.map((_l, i) => String(i)) : Object.keys(question.criteria);
    const vector = vectorFor(id, question, labels, body);
    const d = decimals();
    const top = Math.max(...vector);
    let rounded = vector.map(p => round(p, d));
    if (state.skew[id]) { const at = vector.indexOf(top); rounded = rounded.map((p, i) => i === at ? round(p + state.skew[id], d) : p); }
    const extras = state.extraAnswerFields[id] ?? {};
    const laya = mode === 'laya';
    const confidence = laya ? round(question.type === 'noul' ? top : entropyConf(vector), 4) : round(spread(vector.length, top), 2);
    const layaExtras = laya ? { answer_confidence: round(top, 4), action: { act_probability: 0.91 } } : {};
    let result;
    if (question.type === 'noul') {
      result = { type: 'noul', noul: rounded[0], ...(laya ? { confidence } : {}), ...layaExtras };
    } else if (question.type === 'choice') {
      const choice = labels[vector.indexOf(top)];
      result = { type: 'choice', choice, ...(state.omitProbabilities ? {} : { probabilities: Object.fromEntries(labels.map((label, i) => [label, rounded[i]])) }), ...(state.omitConfidence ? {} : { confidence }), ...layaExtras };
    } else {
      result = {
        type: 'score', score: round(vector.reduce((s, p, i) => s + i * p, 0), d),
        legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])),
        probabilities: Object.fromEntries(labels.map((label, i) => [label, rounded[i]])), ...(state.omitConfidence ? {} : { confidence }), ...layaExtras
      };
    }
    if (state.omitType) delete result.type;
    return { ...result, ...extras };
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* kept raw */ }
    state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, raw, json });
    const send = (status, body, headers = {}) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
      res.end(text);
    };
    const path = req.url ?? '/';
    if (req.method === 'GET') {
      if (state.limits && path === '/v1/limits') return send(200, state.limits);
      if (mode === 'laya' && path === '/health') return send(200, { status: 'ok', loaded: ['english'], device: 'cpu' });
      if (mode === 'typesafe' && path === '/v1/models' || mode === 'vercel' && path === '/typesafe/v1/models') return send(200, { models: [{ name: 'jev-latest', description: 'Latest Jev', release_date: '2026-09-17' }, { name: 'jev-preview', description: 'Preview', release_date: '2026-09-17' }] });
      return send(404, mode === 'openrouter' ? { error: { code: 404, message: 'Not Found' } } : { detail: 'Not Found' });
    }
    if (req.method !== 'POST' || !ROUTES[mode].includes(path)) return send(404, mode === 'openrouter' ? { error: { code: 404, message: 'Not Found' } } : { detail: 'Not Found' });
    const failure = state.failures.shift();
    if (failure) {
      if (failure.delayMs) await new Promise(resolve => setTimeout(resolve, failure.delayMs));
      if (failure.stall) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(failure.stall);
        return; // never ends: a mid-body stall
      }
      if (failure.raw !== undefined) return send(failure.status ?? 200, failure.raw, failure.headers);
      if (failure.status) return send(failure.status, failure.body ?? {}, failure.headers);
    }
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    const auth = authFailure(mode, req.headers.authorization, state.keys);
    // Vercel checks the body before the key (probed); the others authenticate first.
    const invalid = json === null && raw ? (mode === 'laya' ? [400, { detail: 'request body must be valid JSON' }] : [422, { detail: [{ loc: ['body'], msg: 'JSON decode error', type: 'json_invalid', input: raw.slice(0, 64) }] }]) : validationFailure(mode, json);
    let scripted = null;
    if (!invalid && isDict(json?.questions)) {
      if (Object.keys(json.questions).length > state.maxQuestions) scripted = [413, mode === 'openrouter' ? { error: { code: 413, message: 'Payload too large' } } : { detail: 'too many questions' }];
      const score = Object.entries(json.questions).find(([, question]) => question?.type === 'score');
      if (state.rejectScore && score) scripted = [422, { detail: [{ loc: ['body', 'questions', score[0], 'score'], msg: 'Score questions are not supported', type: 'value_error', input: score[1] }] }];
    }
    const first = mode === 'vercel' ? invalid ?? auth ?? scripted : auth ?? invalid ?? scripted;
    if (first) return send(first[0], first[1]);
    const reported = resolveModel(json.model);
    if (!reported) { const [status, body] = unknownModel(json.model); return send(status, body); }
    const answers = Object.fromEntries(Object.entries(json.questions).map(([id, question]) => [id, answer(id, question, json)]));
    const input = Math.ceil(raw.length / 4);
    const envelope = { model: reported, answers, usage: { input_tokens: input, output_tokens: mode === 'laya' ? 0 : 3 * Object.keys(answers).length } };
    const headers = {};
    if (mode === 'typesafe') headers['x-typesafe-request-id'] = `req_${randomBytes(16).toString('hex')}`;
    if (mode === 'openrouter') Object.assign(envelope, { id: `gen-dec-${randomBytes(6).toString('hex')}`, provider: 'TypeSafe' }), envelope.usage.cost = input * 0.042 / 1e6;
    if (mode === 'vercel') envelope.provider_metadata = { gateway: { routing: { provider: 'typesafe' }, cost: '0.00001155', marketCost: '0.00001155', generationId: `gen_${randomBytes(6).toString('hex')}` } };
    if (mode === 'laya') {
      const checkpoint = ['english', 'multilingual', 'typed-decisions'].includes(json.model) ? json.model : 'english';
      envelope.routing = { model: checkpoint, reason: checkpoint === json.model ? 'explicit' : 'script' };
      Object.assign(headers, { 'Server-Timing': 'inference;dur=12.00', 'X-Inference-Time-Ms': '12.00' });
    }
    return send(200, envelope, headers);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    mode, url, port,
    requests: state.requests,
    script: state,
    /** Scripted replies for the next POSTs: { status, body, headers, delayMs } | { raw, status? } | { stall: 'partial body' }. */
    failNext(...items) { state.failures.push(...items); },
    setLatest(version) { state.latest = version; },
    /** A fetch that sends a preset's fixed cloud URL to this server instead (same path, same init). */
    transport() {
      return (target, init) => fetch(`${url}${new URL(String(target)).pathname}`, init);
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
