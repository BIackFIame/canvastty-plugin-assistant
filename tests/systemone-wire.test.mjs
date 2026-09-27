import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemOneError, classifyStatus, parseBoundedJson, planS1Batches, s1ResponseCaps, sumTolerance, validateS1Request } from '../src/shared/systemOne.ts';
import { SystemOneHttpBackend } from '../src/engine/backends/SystemOneHttpBackend.ts';
import { CircuitBreaker } from '../src/engine/backends/CircuitBreaker.ts';
import { backoffMs, retriesFor, retryAfterMs, retryDelayMs } from '../src/engine/backends/retry.ts';
import { S1_PRESETS } from '../src/engine/backends/systemOneRoutes.ts';
import { startFakeSystemOne } from './helpers/fake-systemone.mjs';

// The VALIDATOR-GAPS cases (jev-design/api/verify/gaps.test.mjs), with the expectations the spec sets:
// the real routes pass, the rounding tolerance is fixed, and what the portable subset refuses is refused locally.

const choiceReq = (model = 'jev-latest', criteria = { billing: 'Payments', technical: 'Bugs', sales: 'Pricing' }) => ({
  model, state: 'Help! My payouts have been failing for 3 days.',
  questions: { department: { type: 'choice', instructions: 'Which team should handle this?', criteria } }
});
const noulReq = (extra = {}) => ({ model: 'jev-latest', state: 'x', questions: { q: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'Urgent', false: 'Not urgent' }, ...extra } } });
const refused = (fn, errorClass = 'invalid-request') => assert.throws(fn, error => error instanceof SystemOneError && error.errorClass === errorClass);
const options = (extra = {}) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 3000, credential: 'k-good', ...extra });

function stub(preset, body, init = {}) {
  const calls = [];
  const backend = new SystemOneHttpBackend({
    id: 'wire', preset, url: ['laya', 'eikos', 'custom'].includes(preset) ? 'http://127.0.0.1:9' : undefined, model: init.model,
    transport: async (url, request) => { calls.push({ url, request }); return new Response(typeof body === 'string' ? body : JSON.stringify(typeof body === 'function' ? body(calls.length) : body), { status: init.status ?? 200, headers: init.headers ?? {} }); }
  });
  return { backend, calls };
}
async function rejectsWith(promise, errorClass) {
  await assert.rejects(promise, error => { assert.equal(error.errorClass, errorClass, error.message); return true; });
}

// ---------------- request side ----------------

test('R1–R4, R7–R9: documented request shapes now pass the portable validator', () => {
  validateS1Request({ model: 'jev-latest', state: 'x', questions: { s: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] } } });
  validateS1Request(noulReq({ instructions: { question: 'Is `a` urgent?', a: 'x' } }));
  validateS1Request(choiceReq('jev-latest', Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, null]))));
  refused(() => validateS1Request(choiceReq('jev-latest', Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])))));
  validateS1Request(choiceReq('jev-latest', { 'Beaver Dam Logistics': null, 'Dam Logistics': null }));
  validateS1Request({ model: 'jev-latest', state: 'x', questions: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`q${i}`, noulReq().questions.q])) });
  refused(() => validateS1Request({ model: 'jev-latest', state: 'x', questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, noulReq().questions.q])) }));
  validateS1Request({ ...noulReq(), state: 'word '.repeat(14_000) });
  validateS1Request({ ...noulReq(), state: Array.from({ length: 5000 }, (_, i) => i) });
});

test('R5, R6, R10–R13: what upstream would 422 (or OpenRouter would refuse) is refused before egress', () => {
  refused(() => validateS1Request(noulReq({ criteria: null })));
  refused(() => validateS1Request(noulReq({ criteria: { true: { what: 'asks for a password' }, false: 'no' } })));
  refused(() => validateS1Request(choiceReq('jev-latest', { a: 123, b: true })));
  refused(() => validateS1Request({ ...noulReq(), state: 42 }));
  refused(() => validateS1Request({ ...noulReq(), state: null }));
  refused(() => validateS1Request(noulReq({ criteria: undefined })));
  refused(() => validateS1Request(noulReq({ criteria: { true: 'yes' } })));
  refused(() => validateS1Request({ model: 'jev-latest', state: 'x', questions: { s: { type: 'score', instructions: 'x', criteria: ['only one'] } } }));
  refused(() => validateS1Request({ model: 'jev-latest', state: 'x', questions: { s: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } }));
  refused(() => validateS1Request({ ...noulReq(), provider: { zdr: true } }));
  refused(() => validateS1Request(noulReq({ instructions: '' })));
  refused(() => validateS1Request(noulReq({ instructions: { a: 'no question field' } })));
});

// ---------------- response side ----------------

const docsChoice = () => ({ model: 'jev-1.13.0', answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 }, confidence: 0.81 } }, usage: { input_tokens: 318, output_tokens: 34 } });

test('S1, S8: the TypeSafe docs response is read, and confidence is CanvasTTY’s own (never pMax, never the vendor’s)', async () => {
  const result = await stub('typesafe', docsChoice()).backend.evaluate(choiceReq(), options());
  const answer = result.answers.department;
  assert.equal(answer.choice, 'billing');
  assert.ok(Math.abs(answer.conf - 0.82) < 1e-9, `conf ${answer.conf}`);
  assert.equal(result.vendorConfidence.department, 0.81);
  const { confidence: _dropped, ...withoutConfidence } = docsChoice().answers.department;
  const missing = await stub('typesafe', { ...docsChoice(), answers: { department: withoutConfidence } }).backend.evaluate(choiceReq(), options());
  assert.ok(Math.abs(missing.answers.department.conf - 0.82) < 1e-9);
  assert.deepEqual(missing.vendorConfidence, {});
});

test('S2, S7: pinned jev-1.13 → jev-1.13.0 and jev-preview → jev-1.13.0 are accepted with the resolved version', async () => {
  assert.equal((await stub('typesafe', docsChoice()).backend.evaluate(choiceReq('jev-1.13'), options())).resolvedVersion, 'jev-1.13.0');
  assert.equal((await stub('typesafe', docsChoice()).backend.evaluate(choiceReq('jev-preview'), options())).resolvedVersion, 'jev-1.13.0');
  assert.equal((await stub('typesafe', docsChoice()).backend.evaluate(choiceReq('jev-1.13.0'), options())).resolvedVersion, 'jev-1.13.0');
});

test('S3, S4, S5: OpenRouter, Vercel and laya-serve responses pass; each reports its version its own way', async () => {
  const openrouter = await stub('openrouter', { ...docsChoice(), id: 'gen-dec-1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 } }).backend.evaluate(choiceReq('typesafe/jev-1.13'), options());
  assert.equal(openrouter.resolvedVersion, 'typesafe/jev-1.13-20260917');
  assert.deepEqual([openrouter.usage.costUsd, openrouter.usage.costSource, openrouter.requestId], [0.000019992, 'reported', 'gen-dec-1']);
  const vercel = await stub('vercel', { ...docsChoice(), model: 'typesafe-ai/jev', provider_metadata: { gateway: { cost: '0.00001155', generationId: 'gen_abc' } } }).backend.evaluate(choiceReq('typesafe-ai/jev'), options());
  assert.equal(vercel.resolvedVersion, null);
  assert.deepEqual([vercel.usage.costUsd, vercel.usage.costSource, vercel.requestId], [0.00001155, 'reported', 'gen_abc']);
  const laya = { model: 'laya-rl-agent', answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7311, technical: 0.1345, sales: 0.1344 }, confidence: 0.2548, answer_confidence: 0.7311, action: { act_probability: 0.91 } } }, usage: { input_tokens: 57, output_tokens: 0 }, routing: { model: 'english', reason: 'explicit' } };
  const read = await stub('laya', laya, { model: 'english' }).backend.evaluate(choiceReq('english'), options({ credential: null }));
  assert.equal(read.resolvedVersion, 'english');
  assert.equal(read.vendorConfidence.department, 0.2548);
  assert.ok(Math.abs(read.answers.department.conf - (3 * 0.7311 - 1) / 2) < 1e-3);
  assert.deepEqual([read.usage.costUsd, read.usage.costSource], [0, 'none']);
});

test('S6: two-decimal rounding tolerance scales with the option count; sums of 0.99 and 1.01 pass and are renormalized', async () => {
  assert.ok(sumTolerance(2, 2) > 0.01 && sumTolerance(2, 2) < 0.0101);
  assert.ok(Math.abs(sumTolerance(10, 2) - 0.05) < 1e-6);
  assert.ok(Math.abs(sumTolerance(3, 4) - 0.01) < 1e-6);
  assert.ok(sumTolerance(2, 1) < 0.0101, 'no route rounds coarser than 2 decimals');
  const low = { model: 'jev-1.13.0', answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.3, sales: 0.19 }, confidence: 0.25 } }, usage: { input_tokens: 1, output_tokens: 0 } };
  const result = await stub('typesafe', low).backend.evaluate(choiceReq(), options());
  assert.ok(Math.abs(result.answers.department.probabilities.billing - 0.5 / 0.99) < 1e-12);
  assert.equal(result.decimals, 2);
  const high = structuredClone(low); high.answers.department.probabilities = { billing: 0.51, technical: 0.31, sales: 0.19 };
  assert.ok((await stub('typesafe', high).backend.evaluate(choiceReq(), options())).answers.department);
  const broken = structuredClone(low); broken.answers.department.probabilities = { billing: 0.5, technical: 0.3, sales: 0.1 };
  await rejectsWith(stub('typesafe', broken).backend.evaluate(choiceReq(), options()), 'invalid-response');
});

test('S6 against the fake: 2-decimal vectors summing to 1.01 and 0.99 are accepted and renormalized', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    for (const skew of [0.01, -0.01]) {
      fake.script.skew = { department: skew };
      fake.requests.length = 0;
      const result = await backend.evaluate(choiceReq('jev-1.13.0'), options());
      assert.equal(fake.requests.length, 1, 'accepted on the first attempt');
      const total = Object.values(result.answers.department.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 1e-12);
      assert.equal(result.decimals, 2);
    }
    fake.script.skew = { department: 0.05 };
    await rejectsWith(backend.evaluate(choiceReq('jev-1.13.0'), options()), 'invalid-response');
  } finally { await fake.close(); }
});

test('S9, S10: camelCase usage is read; an evaluate-route boolean answer is not a System One answer', async () => {
  const camel = await stub('typesafe', { ...docsChoice(), usage: { inputTokens: 5, outputTokens: 1 } }).backend.evaluate(choiceReq(), options());
  assert.deepEqual([camel.usage.inputTokens, camel.usage.outputTokens, camel.usage.costSource], [5, 1, 'price-table']);
  assert.ok(Math.abs(camel.usage.costUsd - 5 * 0.042 / 1e6) < 1e-15);
  await rejectsWith(stub('vercel', { model: 'typesafe-ai/jev', answers: { q: { type: 'boolean', probability: 0.9 } }, usage: {} }).backend.evaluate({ ...noulReq(), model: 'typesafe-ai/jev' }, options()), 'invalid-response');
});

test('S11: real 403/401/402/429/529 bodies become error classes; the body is never carried', async () => {
  const missing = { detail: { error_type: 'authentication_error', message: 'Must supply an API key! Check your request and try again.' } };
  await rejectsWith(stub('typesafe', missing, { status: 403 }).backend.evaluate(choiceReq(), options()), 'auth');
  await rejectsWith(stub('typesafe', { detail: { error_type: 'authentication_error', message: 'Cannot authenticate' } }, { status: 401 }).backend.evaluate(choiceReq(), options()), 'auth');
  await rejectsWith(stub('openrouter', { error: { code: 402, message: 'Insufficient credits' } }, { status: 402 }).backend.evaluate(choiceReq('typesafe/jev-1.13'), options()), 'quota');
  const unknown = stub('typesafe', { detail: { error_type: 'api_usage_error', message: 'Unknown model: jev-9.9.9' } }, { status: 400 });
  await rejectsWith(unknown.backend.evaluate(choiceReq('jev-9.9.9'), options()), 'unknown-model');
  const rate = stub('typesafe', '', { status: 429, headers: { 'retry-after': '0' } });
  await rejectsWith(rate.backend.evaluate(choiceReq(), options()), 'rate');
  assert.equal(rate.calls.length, 3, 'two retries at most');
  try { await stub('typesafe', missing, { status: 403 }).backend.evaluate(choiceReq(), options()); } catch (error) {
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes('Must supply'), false);
  }
});

test('error classes cover every status of the §2.3 table', () => {
  const cases = [[401, 'auth'], [403, 'auth'], [402, 'quota'], [429, 'rate'], [529, 'overloaded'], [503, 'overloaded'], [500, 'server'], [502, 'server'], [504, 'server'], [524, 'server'], [400, 'bad-request'], [413, 'bad-request'], [422, 'bad-request'], [404, 'not-found'], [408, 'timeout']];
  for (const [status, errorClass] of cases) assert.equal(classifyStatus(status), errorClass, String(status));
  assert.equal(classifyStatus(400, { unknownModel: true }), 'unknown-model');
  assert.equal(classifyStatus(409, { quota409: true }), 'quota');
  assert.equal(classifyStatus(409), 'bad-request');
});

test('a TypeSafe 422 keeps the schema path only, never the echoed input', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    fake.script.rejectScore = true;
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    const request = { model: 'jev-1.13.0', state: 'SECRET_STATE_MARKER', questions: { risk: { type: 'score', instructions: 'SECRET_INSTRUCTION_MARKER', criteria: ['low', 'high'] } } };
    const error = await backend.evaluate(request, options()).catch(caught => caught);
    assert.equal(error.errorClass, 'bad-request');
    assert.deepEqual(error.loc, ['body', 'questions', 'risk', 'score']);
    assert.equal(fake.requests.length, 1, 'no retry on 422');
    const carried = JSON.stringify({ ...error, message: error.message });
    assert.equal(carried.includes('SECRET'), false);
  } finally { await fake.close(); }
});

// ---------------- retries ----------------

test('retry-after parsing: ms first, then seconds or an HTTP date, capped at 60 s; backoff 500 ms × 2^n capped at 5 s ±25%', () => {
  const headers = entries => new Headers(entries);
  assert.equal(retryAfterMs(headers({ 'retry-after-ms': '120', 'retry-after': '9' })), 120);
  assert.equal(retryAfterMs(headers({ 'retry-after': '2' })), 2000);
  const now = Date.parse('2026-09-25T10:00:00Z');
  assert.equal(retryAfterMs(headers({ 'retry-after': 'Fri, 25 Sep 2026 10:00:03 GMT' }), now), 3000);
  assert.equal(retryAfterMs(headers({ 'retry-after': '120' })), 60_000);
  assert.equal(retryAfterMs(headers({ 'retry-after': 'soon' })), null);
  assert.equal(backoffMs(0, () => 0), 375);
  assert.equal(backoffMs(0, () => 1), 625);
  assert.equal(backoffMs(4, () => 0.5), 5000);
  assert.equal(retryDelayMs(0, headers({ 'retry-after-ms': '100' }), { now: 0, deadlineAt: 1000, expectedLatencyMs: 300 }), 100);
  assert.equal(retryDelayMs(0, headers({ 'retry-after': '1' }), { now: 0, deadlineAt: 1000, expectedLatencyMs: 300 }), null);
  assert.equal(retriesFor('server', 500), 1);
  assert.equal(retriesFor('rate', 429), 2);
  assert.equal(retriesFor('overloaded', 529), 2);
  for (const [errorClass, status] of [['bad-request', 400], ['auth', 401], ['quota', 402], ['auth', 403], ['bad-request', 413], ['bad-request', 422], ['transport', null]]) assert.equal(retriesFor(errorClass, status), 0);
});

test('retries happen only when they fit the deadline, with X-TypeSafe-Retry-Count on TypeSafe', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const backend = () => new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    fake.failNext({ status: 429, headers: { 'retry-after-ms': '30' }, body: {} });
    const fits = await backend().evaluate(noulReq(), options());
    assert.equal(fits.attempts, 2);
    assert.equal(fake.requests[0].headers['x-typesafe-retry-count'], undefined);
    assert.equal(fake.requests[1].headers['x-typesafe-retry-count'], '1');
    fake.requests.length = 0;
    fake.failNext({ status: 429, headers: { 'retry-after': '5' }, body: {} });
    await rejectsWith(backend().evaluate(noulReq(), options()), 'rate');
    assert.equal(fake.requests.length, 1, 'a 5 s Retry-After does not fit a 3 s deadline');
    fake.requests.length = 0;
    fake.failNext(...Array.from({ length: 3 }, () => ({ status: 529, headers: { 'retry-after-ms': '1' }, body: { detail: { error_type: 'overloaded_error', message: 'TypeSafe is temporarily overloaded' } } })));
    await rejectsWith(backend().evaluate(noulReq(), options()), 'overloaded');
    assert.equal(fake.requests.length, 3);
    fake.requests.length = 0;
    fake.failNext({ status: 500, headers: { 'retry-after-ms': '1' } }, { status: 500, headers: { 'retry-after-ms': '1' } });
    await rejectsWith(backend().evaluate(noulReq(), options()), 'server');
    assert.equal(fake.requests.length, 2, 'a server error is retried once');
    fake.requests.length = 0;
    fake.failNext({ status: 401, body: { detail: { error_type: 'authentication_error', message: 'x' } } });
    await rejectsWith(backend().evaluate(noulReq(), options()), 'auth');
    assert.equal(fake.requests.length, 1);
  } finally { await fake.close(); }
});

test('a hanging server is cut at the attempt timeout; a mid-body stall and a late abort end the call', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    fake.failNext({ stall: '{"model":"jev-1.13.0","answers":' });
    const started = Date.now();
    await rejectsWith(backend.evaluate(noulReq(), options({ deadlineAt: Date.now() + 300 })), 'timeout');
    assert.ok(Date.now() - started < 2000);
    const controller = new AbortController();
    fake.failNext({ stall: '{"model":' });
    const pending = backend.evaluate(noulReq(), options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await rejectsWith(pending, 'aborted');
  } finally { await fake.close(); }
});

// ---------------- pin rule ----------------

test('pin rule per preset', () => {
  const context = { modelHash: null, fingerprint: null, routingModel: null, unstable: false };
  const accept = (preset, requested, reported, extra = {}) => S1_PRESETS[preset].acceptModel(requested, reported, { ...context, ...extra });
  const mismatch = fn => assert.throws(fn, error => error.errorClass === 'version-mismatch');
  assert.equal(accept('typesafe', 'jev-1.13.0', 'jev-1.13.0'), 'jev-1.13.0');
  mismatch(() => accept('typesafe', 'jev-1.13.0', 'jev-1.14.0'));
  mismatch(() => accept('typesafe', 'jev-1.13', 'jev-2.0.0'));
  assert.equal(accept('typesafe', 'jev-latest', 'jev-1.14.0'), 'jev-1.14.0');
  // An alias reports its versioned id (CONTRACT §6); one echoed back unchanged names no version at all.
  mismatch(() => accept('typesafe', 'jev-latest', 'jev-latest'));
  mismatch(() => accept('typesafe', 'jev-preview', 'jev-preview'));
  mismatch(() => accept('typesafe', 'jev-latest', 'typesafe/jev-1.13-20260917'));
  mismatch(() => accept('typesafe', 'jev-latest', 'laya-rl-agent'));
  assert.equal(accept('openrouter', 'typesafe/jev-1.13', 'typesafe/jev-1.13-20260917'), 'typesafe/jev-1.13-20260917');
  mismatch(() => accept('openrouter', 'typesafe/jev-1.13', 'typesafe/jev-1.14-20261001'));
  assert.equal(accept('openrouter', '~typesafe/jev-latest', 'typesafe/jev-1.14-20261001'), 'typesafe/jev-1.14-20261001');
  assert.equal(accept('vercel', 'typesafe-ai/jev', 'typesafe-ai/jev'), null);
  assert.equal(S1_PRESETS.vercel.pinnable, false);
  mismatch(() => accept('vercel', 'typesafe-ai/jev', 'jev-1.13.0'));
  assert.equal(accept('laya', 'english', 'laya-rl-agent', { routingModel: 'english' }), 'english');
  mismatch(() => accept('laya', 'english', 'laya-rl-agent', { routingModel: 'multilingual' }));
  mismatch(() => accept('laya', 'english', 'jev-1.13.0'));
  const path = '/opt/models/Eikos-4B';
  assert.equal(accept('eikos', 'eikos', path), null, 'no fingerprint before the battery');
  assert.match(accept('eikos', 'eikos', path, { fingerprint: 'ab'.repeat(32) }), /^eikos:Eikos-4B@abababababab$/u);
});

// ---------------- caps derived from the request ----------------

test('response byte, node and depth caps come from the request', async () => {
  assert.deepEqual(s1ResponseCaps(noulReq()), { maxBytes: 8192 + 1024 + 128, maxNodes: 4 * 2 + 256, maxDepth: 16 });
  const wide = { questions: Object.fromEntries(Array.from({ length: 16 }, (_, q) => [`q${q}`, { type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, null])) }])) };
  const caps = s1ResponseCaps(wide);
  // Labels come back as keys (and one as `choice`): their bytes are added, with room for escapes.
  const labelBytes = Buffer.byteLength(JSON.stringify(Object.keys(wide.questions.q0.criteria)));
  assert.equal(caps.maxBytes, 8192 + 16 * (1024 + 255 * 64 + 6 * labelBytes));
  assert.equal(caps.maxNodes, 4 * 16 * 255 + 256);
  assert.equal(s1ResponseCaps({ questions: Object.fromEntries(Array.from({ length: 64 }, (_, q) => [`q${q}`, wide.questions.q0])) }).maxBytes, 1024 * 1024);
  const good = { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 1, output_tokens: 0 } };
  await rejectsWith(stub('typesafe', { ...good, padding: 'x'.repeat(10_000) }).backend.evaluate(noulReq(), options()), 'invalid-response');
  await rejectsWith(stub('typesafe', { ...good, extra: Array.from({ length: 300 }, (_, i) => i) }).backend.evaluate(noulReq(), options()), 'invalid-response');
  let deep = 0; for (let i = 0; i < 17; i++) deep = [deep];
  await rejectsWith(stub('typesafe', { ...good, deep }).backend.evaluate(noulReq(), options()), 'invalid-response');
  await rejectsWith(stub('typesafe', good, { headers: { 'content-length': '999999' } }).backend.evaluate(noulReq(), options()), 'invalid-response');
  await rejectsWith(stub('typesafe', '{"model":"a","model":"b","answers":{}}').backend.evaluate(noulReq(), options()), 'invalid-response');
  assert.throws(() => parseBoundedJson('{"__proto__":{"x":1}}', { maxBytes: 100, maxNodes: 10, maxDepth: 4 }), /forbidden/u);
  assert.equal((await stub('typesafe', good).backend.evaluate(noulReq(), options())).answers.q.p, 0.4);
});

test('score legends echo every level: their text counts toward the response cap (ASCII and Cyrillic)', async () => {
  for (const unit of ['a', 'я']) {
    const fake = await startFakeSystemOne({ mode: 'typesafe' });
    try {
      // 8 score questions × 10 levels of 253 characters: the legends alone outgrow 8 KiB + Σ(1 KiB + options × 64 B).
      const questions = Object.fromEntries(Array.from({ length: 8 }, (_, q) => [`s${q}`, { type: 'score', instructions: `How risky is change ${q}?`, criteria: Array.from({ length: 10 }, (_, i) => `L${i} ${unit.repeat(250)}`) }]));
      const result = await new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() }).evaluate({ model: 'jev-1.13.0', state: 'x', questions }, options());
      assert.equal(Object.keys(result.answers).length, 8, unit);
      assert.equal(fake.requests.length, 1);
    } finally { await fake.close(); }
  }
  const score = level => ({ questions: { s: { type: 'score', instructions: 'x', criteria: Array.from({ length: 10 }, () => level) } } });
  const base = 8192 + 1024 + 10 * 64;
  assert.equal(s1ResponseCaps(score('a'.repeat(253))).maxBytes, base + 6 * Buffer.byteLength(JSON.stringify(Array.from({ length: 10 }, () => 'a'.repeat(253)))));
  assert.ok(s1ResponseCaps(score('я'.repeat(253))).maxBytes > s1ResponseCaps(score('a'.repeat(253))).maxBytes, 'UTF-8 bytes, not characters');
  assert.equal(s1ResponseCaps({ questions: Object.fromEntries(Array.from({ length: 64 }, (_, q) => [`q${q}`, score('я'.repeat(2000)).questions.s])) }).maxBytes, 1024 * 1024, 'the 1 MiB ceiling holds');
});

test('a score expectation is always recomputed; Jev’s own score field is never read', async () => {
  const request = { model: 'jev-1.13.0', state: 'x', questions: { size: { type: 'score', instructions: 'How big?', criteria: ['small', 'medium', 'large'] } } };
  const body = { model: 'jev-1.13.0', answers: { size: { type: 'score', score: 0.2, legend: { 0: 'small', 1: 'medium', 2: 'large' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.55 } }, usage: { input_tokens: 1, output_tokens: 0 } };
  const answer = (await stub('typesafe', body).backend.evaluate(request, options())).answers.size;
  assert.equal(answer.level, 2);
  assert.ok(Math.abs(answer.expectation - 1.6) < 1e-12);
  assert.ok(Math.abs(answer.adjacentMass - 0.9) < 1e-12);
  assert.ok(Math.abs(answer.conf - (3 * 0.7 - 1) / 2) < 1e-12);
  const missing = structuredClone(body); delete missing.answers.size.probabilities;
  await rejectsWith(stub('typesafe', missing).backend.evaluate(request, options()), 'incomplete-answer');
  const partial = structuredClone(body); delete partial.answers.size.probabilities[2];
  await rejectsWith(stub('typesafe', partial).backend.evaluate(request, options()), 'incomplete-answer');
});

test('OpenRouter’s optional probabilities make an incomplete answer, never a guessed one', async () => {
  const fake = await startFakeSystemOne({ mode: 'openrouter' });
  try {
    fake.script.omitProbabilities = true;
    const backend = new SystemOneHttpBackend({ id: 'o', preset: 'openrouter', transport: fake.transport() });
    await rejectsWith(backend.evaluate(choiceReq('typesafe/jev-1.13'), options()), 'incomplete-answer');
  } finally { await fake.close(); }
});

test('batches share the state and never truncate: too many questions split, an oversized question is skipped', () => {
  const questions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, noulReq().questions.q]));
  const plan = planS1Batches({ model: 'm', state: 'x', questions }, { maxQuestions: 16, maxOptions: 255, contextTokens: null, maxStateTokensPerQuestion: 1000 });
  assert.deepEqual(plan.batches.map(batch => batch.length), [16, 4]);
  const big = { model: 'm', state: 'y'.repeat(3500), questions: { a: noulReq().questions.q } };
  assert.deepEqual(planS1Batches(big, { maxQuestions: 16, maxOptions: 255, contextTokens: null, maxStateTokensPerQuestion: 1000 }), { batches: [], skipped: { a: 'context' } });
  // More options than the backend takes: skipped on the count alone, however short the text.
  const five = { type: 'choice', instructions: 'x', criteria: { a: null, b: null, c: null, d: null, e: null } };
  assert.deepEqual(planS1Batches({ model: 'm', state: 'x', questions: { five, q: noulReq().questions.q } }, { maxQuestions: 16, maxOptions: 4, contextTokens: null, maxStateTokensPerQuestion: 1000 }), { batches: [['q']], skipped: { five: 'context' } });
  // Options (label: description, flattened) that overflow an option head are skipped, never trimmed.
  const described = { type: 'choice', instructions: 'x', criteria: { a: 'y'.repeat(350), b: { what: 'z'.repeat(350), examples: ['w'] }, c: null } };
  const limits = { maxQuestions: 16, maxOptions: 255, contextTokens: null, maxStateTokensPerQuestion: 10_000 };
  assert.deepEqual(planS1Batches({ model: 'm', state: 'x', questions: { described } }, { ...limits, optionHeadTokens: 192 }).skipped, { described: 'context' });
  assert.deepEqual(planS1Batches({ model: 'm', state: 'x', questions: { described } }, { ...limits, optionHeadTokens: 256 }).skipped, {});
  assert.deepEqual(planS1Batches({ model: 'm', state: 'x', questions: { described } }, limits).skipped, {}, 'no head, no head limit');
});

// ---------------- circuit breaker ----------------

test('breaker: five failures open it for 30 s doubling to 10 min; the next real call is the single half-open probe', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ now: () => now });
  for (let i = 0; i < 4; i++) { breaker.acquire(); breaker.failure('server'); }
  assert.equal(breaker.snapshot().state, 'closed');
  breaker.acquire(); breaker.failure('timeout');
  assert.deepEqual(breaker.snapshot(), { state: 'open', reason: 'timeout', consecutiveFailures: 5, retryAt: 30_000, hold: 'timed' });
  assert.throws(() => breaker.acquire(), error => error.errorClass === 'breaker-open');
  now = 30_000;
  assert.deepEqual(breaker.acquire(), { probe: true });
  assert.throws(() => breaker.acquire(), error => error.errorClass === 'breaker-open', 'one probe at a time');
  breaker.failure('transport');
  assert.equal(breaker.snapshot().retryAt, 30_000 + 60_000);
  now = 90_000; breaker.acquire(); breaker.success();
  assert.equal(breaker.snapshot().state, 'closed');
  for (let round = 0; round < 8; round++) { for (let i = 0; i < 5; i++) { try { breaker.acquire(); } catch { now += 600_000; breaker.acquire(); } breaker.failure('server'); } }
  assert.ok(breaker.snapshot().retryAt - now <= 600_000, 'capped at 10 minutes');
  const rate = new CircuitBreaker();
  for (let i = 0; i < 10; i++) rate.failure('rate');
  for (let i = 0; i < 10; i++) rate.failure('context');
  assert.equal(rate.snapshot().state, 'closed', 'rate limits and local refusals never trip it');
});

test('breaker: auth waits for a new key; quota, unknown model and a wrong address wait for «Проверить снова»', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ now: () => now });
  breaker.acquire(7); breaker.failure('auth', 7);
  now = 3_600_000;
  assert.throws(() => breaker.acquire(7));
  breaker.recheck();
  assert.throws(() => breaker.acquire(7), undefined, '«Проверить снова» does not lift an auth hold');
  assert.deepEqual(breaker.acquire(8), { probe: true });
  breaker.success();
  for (const reason of ['quota', 'unknown-model', 'not-found']) {
    breaker.acquire(); breaker.failure(reason);
    now += 86_400_000;
    assert.throws(() => breaker.acquire());
    assert.equal(breaker.snapshot().hold, 'recheck');
    breaker.recheck();
    assert.deepEqual(breaker.acquire(), { probe: true });
    breaker.success();
  }
});

test('breaker: a call that never leaves the machine, or that the caller cancels, leaves it as it was', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    let clock = 0;
    const breaker = new CircuitBreaker({ now: () => clock });
    for (let i = 0; i < 5; i++) { breaker.acquire(); breaker.failure('server'); }
    clock = 30_000;
    const due = breaker.snapshot();
    assert.deepEqual(due, { state: 'open', reason: 'server', consecutiveFailures: 5, retryAt: 30_000, hold: 'timed' });
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport(), breaker });
    // A deadline that has already passed.
    await rejectsWith(backend.evaluate(noulReq(), options({ deadlineAt: Date.now() - 1 })), 'timeout');
    assert.deepEqual(breaker.snapshot(), due);
    // A deadline that passes after admission but before the first send.
    let reads = 0;
    const late = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport(), breaker, now: () => reads++ === 0 ? 0 : 1_000 });
    await rejectsWith(late.evaluate(noulReq(), options({ deadlineAt: 500 })), 'timeout');
    assert.deepEqual(breaker.snapshot(), due);
    // Local refusals never reach it.
    await rejectsWith(backend.evaluate(noulReq({ criteria: { true: 'only this side' } }), options()), 'invalid-request');
    await rejectsWith(backend.evaluate({ ...noulReq(), state: 'x'.repeat(200_000) }, options()), 'context');
    assert.deepEqual(breaker.snapshot(), due);
    assert.equal(fake.requests.length, 0);
    // The half-open probe cancelled in flight.
    const controller = new AbortController();
    fake.failNext({ stall: '{"model":' });
    const pending = backend.evaluate(noulReq(), options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await rejectsWith(pending, 'aborted');
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(breaker.snapshot(), due, 'a cancelled probe neither counts nor doubles the hold');
    // The next real call is still the probe, even beside an out-of-time call started first, and it closes the breaker.
    const [expired, real] = await Promise.allSettled([backend.evaluate(noulReq(), options({ deadlineAt: Date.now() - 1 })), backend.evaluate(noulReq(), options())]);
    assert.equal(expired.reason?.errorClass, 'timeout');
    assert.ok(real.value?.answers.q, real.reason?.message);
    assert.equal(breaker.snapshot().state, 'closed');
  } finally { await fake.close(); }
  // A 429 or a cancelled call while closed does not count either.
  const closed = new CircuitBreaker();
  for (let i = 0; i < 4; i++) { closed.acquire(); closed.failure('server'); }
  closed.acquire(); closed.failure('aborted');
  closed.acquire(); closed.failure('rate');
  assert.deepEqual(closed.snapshot(), { state: 'closed', reason: null, consecutiveFailures: 4, retryAt: null, hold: null });
  // Only the probe itself can give the probe slot back: a call admitted earlier cannot.
  let clock = 0;
  const shared = new CircuitBreaker({ now: () => clock });
  const early = shared.acquire();
  for (let i = 0; i < 5; i++) { shared.acquire(); shared.failure('server'); }
  clock = 30_000;
  const probe = shared.acquire();
  assert.deepEqual(probe, { probe: true });
  shared.failure('rate', 0, early);
  shared.release(early);
  assert.throws(() => shared.acquire(), error => error.errorClass === 'breaker-open', 'the probe in flight keeps its slot');
  shared.release(probe);
  assert.deepEqual(shared.acquire(), { probe: true });
});

test('an open breaker skips the call without a request', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    let generation = 1;
    const breaker = new CircuitBreaker();
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport(), breaker, credentialGeneration: () => generation });
    await rejectsWith(backend.evaluate(noulReq(), options({ credential: 'k-bad' })), 'auth');
    await rejectsWith(backend.evaluate(noulReq(), options()), 'breaker-open');
    assert.equal(fake.requests.length, 1);
    generation = 2;
    assert.ok((await backend.evaluate(noulReq(), options())).answers.q);
    assert.equal(breaker.snapshot().state, 'closed');
  } finally { await fake.close(); }
});

// ---------------- the legacy routing evaluator ----------------
