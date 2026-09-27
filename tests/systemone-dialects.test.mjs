import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemOneHttpBackend } from '../src/engine/backends/SystemOneHttpBackend.ts';
import { decodeErrorBody, decodeResponse, detectDialect, detectHealthDialect, encodeRequest, flattenEntry } from '../src/engine/backends/dialects.ts';
import { modelLabel } from '../src/engine/backends/systemOneRoutes.ts';
import { runConformance } from '../src/engine/backends/capabilities.ts';
import { EIKOS_MODEL_PATH, startFakeEikos } from './helpers/fake-eikos.mjs';
import { startFakeSystemOne } from './helpers/fake-systemone.mjs';

const options = (extra = {}) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 5000, credential: null, ...extra });
const noul = { type: 'noul', instructions: 'Did the build fail?', criteria: { true: 'The build failed', false: 'The build passed' } };
const score = { type: 'score', instructions: 'How large is the change?', criteria: ['Tiny', 'Medium', 'Large'] };

async function withEikos(work, fakeOptions = {}) {
  const fake = await startFakeEikos(fakeOptions);
  try { return await work(fake, new SystemOneHttpBackend({ id: 'eikos1', preset: 'eikos', url: fake.url })); } finally { await fake.close(); }
}

/** Eikos's own view of a description: what options_of shows its model (str() of the value). */
function modelVisible(body) { return JSON.stringify(body.questions); }

test('Eikos requests: noul as noul with both sides, score always a list, flattened objects, labels for null, no verify, no key', async () => {
  await withEikos(async (fake, backend) => {
    const request = {
      model: 'eikos',
      state: { task: 'Fix the build', files: ['a.ts'] },
      questions: {
        failed: noul,
        size: score,
        area: {
          type: 'choice',
          instructions: { question: 'Which area does `task` touch?', focus: 'the code, not the docs', hints: ['ci', 'build'] },
          criteria: { build: { what: 'Build scripts and CI', not_for: 'Application code', examples: ['Makefile', 'package.json'] }, app: 'Application code', other: null }
        }
      }
    };
    await backend.evaluate(request, options());
    const sent = fake.requests[0].json;
    assert.deepEqual(sent.questions.failed, { type: 'noul', instructions: 'Did the build fail?', criteria: noul.criteria });
    assert.deepEqual(sent.questions.size.criteria, ['Tiny', 'Medium', 'Large']);
    assert.equal(sent.questions.area.instructions, 'Which area does `task` touch?\nfocus: the code, not the docs\nhints: ci; build');
    assert.equal(sent.questions.area.criteria.build, 'Build scripts and CI\nnot_for: Application code\nexamples: Makefile; package.json');
    assert.equal(sent.questions.area.criteria.other, 'other', 'a null description becomes its label');
    assert.deepEqual(sent.state, request.state, 'plain calls keep the state an object');
    const visible = modelVisible(sent);
    for (const repr of ["{'", 'None', "['"]) assert.equal(visible.includes(repr), false, repr);
    assert.equal(JSON.stringify(sent).includes('"mode"'), false, 'never mode:"verify"');
    assert.deepEqual(Object.keys(sent).sort(), ['model', 'questions', 'state']);
    assert.equal(fake.requests[0].headers.authorization, undefined);
  });
});

test('Eikos requests: at most 16 questions each, and the per-question token pre-count refuses without sending', async () => {
  await withEikos(async (fake, backend) => {
    const questions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, { ...noul, instructions: `Is item ${i} broken?` }]));
    const result = await backend.evaluate({ model: 'eikos', state: 'x', questions }, options());
    assert.equal(Object.keys(result.answers).length, 20);
    assert.deepEqual(fake.requests.map(item => Object.keys(item.json.questions).length), [16, 4]);
    fake.requests.length = 0;
    const huge = { model: 'eikos', state: 'word '.repeat(12_000), questions: { failed: noul } };
    await assert.rejects(backend.evaluate(huge, options()), error => error.errorClass === 'context');
    assert.equal(fake.requests.length, 0, 'an over-long prompt would be a 422 on PyTorch and a 500 behind vLLM');
  });
});

test('Eikos answers: the argmax score and expected are only cross-checked; the expectation is recomputed', async () => {
  await withEikos(async (fake, backend) => {
    const result = await backend.evaluate({ model: 'eikos', state: 'x', questions: { size: score } }, options());
    const reply = fake.requests.length;
    assert.equal(reply, 1);
    const answer = result.answers.size;
    assert.equal(answer.type, 'score');
    assert.ok(Math.abs(answer.expectation - answer.probabilities.reduce((s, p, i) => s + i * p, 0)) < 1e-12);
    assert.equal(answer.level, answer.probabilities.indexOf(Math.max(...answer.probabilities)));
  });
  const request = { model: 'eikos', state: 'x', questions: { size: score } };
  const base = { model: EIKOS_MODEL_PATH, answers: { size: { type: 'score', probabilities: { 0: 0.2, 1: 0.7, 2: 0.1 }, score: 1, expected: 0.9, confidence: 0.7 } }, usage: { input_tokens: 90, output_tokens: 0 }, latency_s: 0.4 };
  const ok = decodeResponse('eikos', base, request);
  assert.equal(ok.answers.size.level, 1);
  assert.equal(ok.serverLatencyMs, 400);
  assert.throws(() => decodeResponse('eikos', { ...base, answers: { size: { ...base.answers.size, score: 2 } } }, request), error => error.errorClass === 'invalid-response');
  assert.throws(() => decodeResponse('eikos', { ...base, answers: { size: { ...base.answers.size, expected: 1.5 } } }, request), error => error.errorClass === 'invalid-response');
  assert.throws(() => decodeResponse('eikos', { ...base, answers: { size: { ...base.answers.size, probabilities: { low: 0.2, 1: 0.7, 2: 0.1 } } } }, request), error => ['invalid-response', 'incomplete-answer'].includes(error.errorClass));
  // TypeSafe's `score` is the mean and is simply ignored.
  assert.equal(decodeResponse('typesafe-v1', { model: 'jev-1.13.0', answers: { size: { type: 'score', score: 99, legend: {}, probabilities: { 0: 0.2, 1: 0.7, 2: 0.1 } } }, usage: {} }, request).answers.size.level, 1);
});

test('Eikos answers: noul from noul or probability; a disagreement is invalid; value and confidence are ignored', () => {
  const request = { model: 'eikos', state: 'x', questions: { failed: noul } };
  const envelope = answer => ({ model: EIKOS_MODEL_PATH, answers: { failed: answer }, usage: { input_tokens: 1, output_tokens: 0 } });
  assert.equal(decodeResponse('eikos', envelope({ type: 'noul', noul: 0.8, probability: 0.8, value: true, confidence: 0.8 }), request).answers.failed.p, 0.8);
  assert.equal(decodeResponse('eikos', envelope({ type: 'noul', probability: 0.3, value: false, confidence: 0.7 }), request).answers.failed.p, 0.3);
  assert.throws(() => decodeResponse('eikos', envelope({ type: 'noul', noul: 0.8, probability: 0.7 }), request), error => error.errorClass === 'invalid-response');
  assert.equal(decodeResponse('eikos', envelope({ type: 'noul', noul: 0.8, probability: 0.8 + 5e-7, value: false }), request).answers.failed.p, 0.8, 'value is never read');
  assert.throws(() => decodeResponse('typesafe-v1', { ...envelope({ type: 'noul', probability: 0.3 }), model: 'jev-1.13.0' }, request), error => error.errorClass === 'invalid-response', 'only Eikos may fall back to probability');
});

test('Eikos answers: type is always choice; more than 26 options go through the tournament and are hints only', async () => {
  await withEikos(async (fake, backend) => {
    const wide = { type: 'choice', instructions: 'Which file changed?', criteria: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, `file ${i}`])) };
    const narrow = { type: 'choice', instructions: 'Which file changed?', criteria: { a: 'file a', b: 'file b' } };
    const result = await backend.evaluate({ model: 'eikos', state: 'x', questions: { wide, narrow } }, options());
    assert.equal(result.answers.wide.uncalibrated, true);
    assert.equal(result.answers.narrow.uncalibrated, undefined);
    assert.ok(Math.abs(Object.values(result.answers.wide.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(fake.requests[0].json.questions.wide, 'sent as it is: the server runs its tournament');
  });
});

test('all dialects: the same vector gives the same CanvasTTY conf whatever the vendor confidence says', () => {
  const request = { model: 'm', state: 'x', questions: { area: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', c: 'C' } } } };
  const probabilities = { a: 0.7, b: 0.2, c: 0.1 };
  const jev = decodeResponse('typesafe-v1', { model: 'jev-1.13.0', answers: { area: { type: 'choice', choice: 'a', probabilities, confidence: 0.55 } }, usage: {} }, request);
  const laya = decodeResponse('laya', { model: 'laya-rl-agent', answers: { area: { choice: 'a', probabilities, confidence: 0.27, answer_confidence: 0.7 } }, usage: {}, routing: { model: 'english' } }, request);
  const eikos = decodeResponse('eikos', { model: EIKOS_MODEL_PATH, answers: { area: { type: 'choice', choice: 'a', probabilities, confidence: 0.7 } }, usage: {} }, request);
  assert.deepEqual(jev.answers, laya.answers);
  assert.deepEqual(laya.answers, eikos.answers);
  assert.deepEqual([jev.vendorConfidence.area, laya.vendorConfidence.area, eikos.vendorConfidence.area], [0.55, 0.27, 0.7]);
  assert.ok(Math.abs(jev.answers.area.conf - 0.55) < 1e-12);
});

test('model id: a path with spaces and a user name is accepted, shown only as basename#hash, and never carried in errors', async () => {
  assert.match(modelLabel(EIKOS_MODEL_PATH, 'eikos'), /^Eikos-4B-MLX-8bit#[0-9a-f]{8}$/u);
  assert.equal(modelLabel('jev-1.13.0', 'typesafe'), 'jev-1.13.0');
  assert.match(modelLabel('/srv/x y/model', 'custom'), /^model#[0-9a-f]{8}$/u);
  await withEikos(async (fake, backend) => {
    const result = await backend.evaluate({ model: 'eikos', state: 'x', questions: { failed: noul } }, options());
    assert.equal(result.reportedModel, EIKOS_MODEL_PATH, 'kept in memory for the pin check');
    assert.equal(result.modelLabel.includes('Test User'), false);
    const { reportedModel: _memoryOnly, ...loggable } = result;
    assert.equal(JSON.stringify(loggable).includes('Test User'), false);
    const report = await runConformance(backend, { credential: null, signal: new AbortController().signal });
    assert.equal(JSON.stringify(report).includes('Test User'), false, 'the conformance report and caps hold only the label and hashes');
    backend.setCaps(report.caps);
    fake.set({ model: '/Users/Other Person/models/Eikos-27B' });
    const error = await backend.evaluate({ model: 'eikos', state: 'x', questions: { failed: noul } }, options()).catch(caught => caught);
    assert.equal(error.errorClass, 'version-mismatch', 'a different model behind the same URL is a new version');
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes('Other Person'), false);
  });
});

test('errors: Eikos 422 is bad-request with no retry; unknown session differs from a wrong path; 500 text is never carried or logged', async () => {
  await withEikos(async (fake, backend) => {
    fake.failNext({ status: 422, body: { error: 'q: at least 2 options are required' } });
    await assert.rejects(backend.evaluate({ model: 'eikos', state: 'x', questions: { failed: noul } }, options()), error => error.errorClass === 'bad-request');
    assert.equal(fake.requests.length, 1);
    const wrongPath = new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: `${fake.url}/v1/predict` });
    await assert.rejects(wrongPath.evaluate({ model: 'default', state: 'x', questions: { failed: noul } }, options()), error => error.errorClass === 'not-found' && !error.unknownSession);
    assert.deepEqual(decodeErrorBody('{"error":"unknown session"}', 404), { unknownModel: false, unknownSession: true, loc: null });
    assert.deepEqual(decodeErrorBody('{"error":"not found"}', 404), { unknownModel: false, unknownSession: false, loc: null });
    const secret = `TypeError: ${EIKOS_MODEL_PATH}/tokenizer.json SECRET_TRACE`;
    fake.requests.length = 0;
    fake.failNext({ status: 500, body: { error: secret } }, { status: 500, body: { error: secret } });
    const printed = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const name of Object.keys(originals)) console[name] = (...args) => { printed.push(args.map(String).join(' ')); };
    let error;
    try { error = await backend.evaluate({ model: 'eikos', state: 'x', questions: { failed: noul } }, options()).catch(caught => caught); }
    finally { Object.assign(console, originals); }
    assert.equal(error.errorClass, 'server');
    assert.equal(fake.requests.length, 2, 'a server error is retried once within the deadline');
    assert.equal(JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes('SECRET_TRACE'), false);
    assert.equal(printed.join('\n').includes('SECRET_TRACE'), false);
  });
  const stub = new SystemOneHttpBackend({ id: 'e', preset: 'eikos', transport: async () => new Response('{"error":"unknown session"}', { status: 404 }) });
  await assert.rejects(stub.evaluate({ model: 'eikos', state: 'x', questions: { failed: noul } }, options()), error => error.errorClass === 'not-found' && error.unknownSession === true);
});

test('fake-eikos is faithful: its own validation, error shapes and tournament', async () => {
  await withEikos(async fake => {
    const post = async (path, body) => { const response = await fetch(`${fake.url}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }); return [response.status, await response.json()]; };
    assert.deepEqual(await post('/v1/systemone', '{not json'), [422, { error: 'Expecting value: line 1 column 1 (char 0)' }]);
    assert.equal((await post('/v1/systemone', { state: 'x', questions: { q: { type: 'choice', criteria: { only: 'one' } } } }))[0], 422);
    assert.equal((await post('/v1/systemone', { state: 'x', questions: { q: { type: 'score', criteria: { low: 'a', high: 'b' } } } }))[0], 422, 'score labels must parse as numbers');
    const [status, body] = await post('/v1/systemone', [1, 2]);
    assert.equal(status, 500); assert.match(body.error, /^AttributeError: /u);
    assert.equal((await post('/v1/systemone', { state: 'x', questions: { q: null } }))[0], 500);
    const [, unknown] = await post('/v1/evaluate', { state: 'x', questions: { q: { type: 'mystery', criteria: ['a', 'b'] } } });
    assert.equal(unknown.answers.q.type, 'choice');
    const [, nouls] = await post('/v1/systemone', { state: 'x', questions: { q: { type: 'boolean' } } });
    assert.deepEqual(Object.keys(nouls.answers.q).sort(), ['confidence', 'noul', 'probability', 'type', 'value']);
    assert.equal(nouls.answers.q.type, 'boolean');
    assert.deepEqual(await (await fetch(`${fake.url}/health`)).json(), { ok: true, model: EIKOS_MODEL_PATH });
    assert.deepEqual([(await fetch(`${fake.url}/nope`)).status], [404]);
    fake.set({ maxTokens: 50 });
    assert.equal((await post('/v1/systemone', { state: 'x'.repeat(400), questions: { q: noul } }))[0], 422);
    fake.set({ vllm: true });
    const [vllmStatus, vllmBody] = await post('/v1/systemone', { state: 'x'.repeat(400), questions: { q: noul } });
    assert.equal(vllmStatus, 500); assert.match(vllmBody.error, /^HTTPError/u);
  });
  await withEikos(async fake => {
    const post = async body => (await fetch(`${fake.url}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) })).json();
    const plain = await post({ state: 'x', questions: { q: noul } });
    fake.set({ sym: true });
    const symmetric = await post({ state: 'x', questions: { q: noul } });
    assert.equal(symmetric.usage.input_tokens, 2 * plain.usage.input_tokens);
  });
});

test('detection: health shapes and answer fields settle a custom server’s dialect', async () => {
  assert.equal(detectHealthDialect({ ok: true, model: '/models/x' }), 'eikos');
  assert.equal(detectHealthDialect({ status: 'ok', loaded: ['english'], device: 'cpu' }), 'laya');
  assert.equal(detectHealthDialect({ models: [{ name: 'jev-latest' }] }), 'typesafe-v1');
  assert.equal(detectHealthDialect({ hello: 'world' }), null);
  assert.deepEqual(detectDialect({ model: 'x', answers: { s: { type: 'score', score: 1, expected: 0.9, probabilities: {} } } }), { dialect: 'eikos', gateway: false });
  assert.deepEqual(detectDialect({ model: 'laya-rl-agent', answers: {}, routing: { model: 'english' } }), { dialect: 'laya', gateway: false });
  assert.deepEqual(detectDialect({ model: 'x', id: 'gen-1', answers: {} }), { dialect: 'typesafe-v1', gateway: true });
  assert.deepEqual(detectDialect({ model: 'jev-1.13.0', answers: { s: { type: 'score', legend: {}, probabilities: {} } } }), { dialect: 'typesafe-v1', gateway: false });

  const eikos = await startFakeEikos();
  try {
    const report = await runConformance(new SystemOneHttpBackend({ id: 'c1', preset: 'custom', url: eikos.url }), { credential: null, signal: new AbortController().signal });
    assert.equal(report.dialect, 'eikos');
    assert.equal(report.caps.dialect, 'eikos');
    assert.equal(report.added, true);
  } finally { await eikos.close(); }
  const laya = await startFakeSystemOne({ mode: 'laya' });
  try {
    const report = await runConformance(new SystemOneHttpBackend({ id: 'c2', preset: 'custom', url: laya.url }), { credential: null, signal: new AbortController().signal });
    assert.equal(report.dialect, 'laya');
  } finally { await laya.close(); }
  const typesafe = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const backend = new SystemOneHttpBackend({ id: 'c3', preset: 'custom', url: typesafe.url, model: 'jev-1.13.0' });
    const report = await runConformance(backend, { credential: { value: 'k-good', origin: typesafe.url }, signal: new AbortController().signal });
    assert.equal(report.dialect, 'typesafe-v1');
    assert.equal(report.gateway, false);
  } finally { await typesafe.close(); }
});

test('flattening is the one used for Eikos and the emulated prompt', () => {
  assert.equal(flattenEntry('plain'), 'plain');
  assert.equal(flattenEntry(null, 'label'), 'label');
  assert.equal(flattenEntry({ what: 'Build scripts', examples: ['a', 'b'] }), 'Build scripts\nexamples: a; b');
  assert.equal(flattenEntry({ question: 'Is `x` ok?', x_hint: 'the value' }), 'Is `x` ok?\nx_hint: the value');
  assert.equal(flattenEntry({ note: 'no lead field' }), 'note: no lead field');
  const encoded = encodeRequest('typesafe-v1', { model: 'jev-1.13.0', state: 'x', questions: { q: { type: 'choice', instructions: { question: 'Which?', a: 'b' }, criteria: { a: null, b: { what: 'B' } } } } });
  assert.deepEqual(encoded.questions.q.instructions, { question: 'Which?', a: 'b' }, 'TypeSafe receives structure as written');
});
