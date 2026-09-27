import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SystemOneHttpBackend } from '../src/engine/backends/SystemOneHttpBackend.ts';
import { runConformance } from '../src/engine/backends/capabilities.ts';
import { presetCaps, resolveEndpoint, S1_PRESETS, secretOwnerFor } from '../src/engine/backends/systemOneRoutes.ts';
import { startFakeSystemOne } from './helpers/fake-systemone.mjs';

const noul = { type: 'noul', instructions: 'Is the task about billing?', criteria: { true: 'It is about billing', false: 'It is not about billing' } };
const request = (model, extra = {}) => ({ model, state: { task: 'Fix the invoice total' }, questions: { billing: noul, ...extra } });
const options = (extra = {}) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 3000, credential: 'k-good', ...extra });
const encryption = { isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() };

async function withFake(mode, work, fakeOptions = {}) {
  const fake = await startFakeSystemOne({ mode, ...fakeOptions });
  try { return await work(fake); } finally { await fake.close(); }
}

test('OpenRouter gets provider{zdr:true, data_collection:deny, allow_fallbacks:false} on every request; no other route does', async () => {
  await withFake('openrouter', async fake => {
    const backend = new SystemOneHttpBackend({ id: 'or', preset: 'openrouter', transport: fake.transport() });
    const result = await backend.evaluate(request('typesafe/jev-1.13'), options());
    assert.deepEqual(fake.requests[0].json.provider, { zdr: true, data_collection: 'deny', allow_fallbacks: false });
    assert.equal(fake.requests[0].path, '/api/v1/systemone');
    assert.equal(result.resolvedVersion, 'typesafe/jev-1.13-20260917');
    assert.equal(result.usage.costSource, 'reported');
    assert.match(result.requestId, /^gen-dec-/u);
    assert.equal('session_id' in fake.requests[0].json, false);
  });
  for (const [mode, preset, model] of [['typesafe', 'typesafe', 'jev-1.13.0'], ['vercel', 'vercel', 'typesafe-ai/jev']]) {
    await withFake(mode, async fake => {
      await new SystemOneHttpBackend({ id: mode, preset, transport: fake.transport() }).evaluate(request(model), options());
      assert.deepEqual(Object.keys(fake.requests[0].json).sort(), ['model', 'questions', 'state']);
    });
  }
});

test('every route receives both noul criteria; one-sided criteria never leave the machine', async () => {
  for (const [mode, preset, model, url] of [['typesafe', 'typesafe', 'jev-1.13.0'], ['openrouter', 'openrouter', 'typesafe/jev-1.13'], ['vercel', 'vercel', 'typesafe-ai/jev'], ['laya', 'laya', 'typed-decisions', true]]) {
    await withFake(mode, async fake => {
      const backend = new SystemOneHttpBackend({ id: mode, preset, ...(url ? { url: fake.url } : { transport: fake.transport() }) });
      await backend.evaluate(request(model), options({ credential: url ? null : 'k-good' }));
      assert.deepEqual(fake.requests[0].json.questions.billing.criteria, noul.criteria);
      await assert.rejects(backend.evaluate(request(model, { one: { ...noul, criteria: { true: 'only this side' } } }), options()), error => error.errorClass === 'invalid-request');
      assert.equal(fake.requests.length, 1);
    });
  }
});

test('Vercel is marked unpinnable: alias model, no resolved version, gateway cost read from a string', async () => {
  assert.equal(S1_PRESETS.vercel.pinnable, false);
  assert.equal(presetCaps(S1_PRESETS.vercel, 'typesafe-ai/jev').reportsVersion, 'alias');
  await withFake('vercel', async fake => {
    const result = await new SystemOneHttpBackend({ id: 'v', preset: 'vercel', transport: fake.transport() }).evaluate(request('typesafe-ai/jev'), options());
    assert.equal(result.reportedModel, 'typesafe-ai/jev');
    assert.equal(result.resolvedVersion, null);
    assert.deepEqual([result.usage.costUsd, result.usage.costSource], [0.00001155, 'reported']);
    assert.match(result.requestId, /^gen_/u);
    await assert.rejects(new SystemOneHttpBackend({ id: 'v', preset: 'vercel', transport: fake.transport() }).evaluate(request('jev-latest'), options()), error => error.errorClass === 'invalid-request');
  });
});

test('Laya token budget per checkpoint: an oversize state is refused, never truncated, and nothing is sent', async () => {
  await withFake('laya', async fake => {
    const backend = new SystemOneHttpBackend({ id: 'laya', preset: 'laya', url: fake.url });
    assert.equal(backend.caps().maxStateTokensPerQuestion, 700);
    assert.equal(presetCaps(S1_PRESETS.laya, 'english').maxStateTokensPerQuestion, 300);
    const text = 'The invoice total is wrong after the discount step. '.repeat(30);
    const long = { model: 'english', state: { task: text }, questions: { billing: noul } };
    await assert.rejects(backend.evaluate(long, options({ credential: null })), error => error.errorClass === 'context');
    assert.equal(fake.requests.length, 0);
    const result = await backend.evaluate({ ...long, model: 'multilingual' }, options({ credential: null }));
    assert.equal(result.resolvedVersion, 'multilingual');
    assert.equal(fake.requests[0].json.state.task, text, 'sent byte for byte');
    await assert.rejects(backend.evaluate({ ...long, model: 'typed-decisions', state: 'x'.repeat(50_001) }, options({ credential: null })), error => error.errorClass === 'context');
    const mixed = await backend.evaluate({ model: 'english', state: 'short task', questions: { billing: noul, wide: { type: 'choice', instructions: 'Which label?', criteria: Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`l${i}`, null])) } } }, options({ credential: null }));
    assert.deepEqual(mixed.skipped, { wide: 'context' }, 'more options than the english option head holds');
    assert.ok(mixed.answers.billing);
  });
});

test('Laya’s option head: a question whose options would be trimmed is skipped (context), never sent', async () => {
  await withFake('laya', async fake => {
    const backend = new SystemOneHttpBackend({ id: 'laya', preset: 'laya', url: fake.url });
    const long = reps => 'Covers invoices, refunds, payment retries and the ledger export. '.repeat(reps).trim();
    const wide = (labels, reps) => ({ type: 'choice', instructions: 'Which area of the code is this about?', criteria: Object.fromEntries(labels.map(label => [label, long(reps)])) });
    // english: about 233 head tokens against a 192-token head, while the whole question still fits the 300-token room.
    const english = await backend.evaluate({ model: 'english', state: 'short task', questions: { billing: noul, area: wide(['billing', 'database', 'none_of_these'], 4) } }, options({ credential: null }));
    assert.deepEqual(english.skipped, { area: 'context' });
    assert.ok(english.answers.billing);
    assert.deepEqual(Object.keys(fake.requests[0].json.questions), ['billing'], 'the trimmed question never leaves the machine');
    // multilingual: about 385 head tokens against 256, inside the 700-token room.
    const multilingual = await backend.evaluate({ model: 'multilingual', state: 'short task', questions: { billing: noul, area: wide(['billing', 'database', 'none_of_these', 'security'], 5) } }, options({ credential: null }));
    assert.deepEqual(multilingual.skipped, { area: 'context' });
    assert.deepEqual(Object.keys(fake.requests[1].json.questions), ['billing']);
    // The same three options with short descriptions fit the head and are sent.
    const short = { type: 'choice', instructions: 'Which area?', criteria: { billing: 'Payment code', database: 'Schema', none_of_these: 'None of these' } };
    const fits = await backend.evaluate({ model: 'english', state: 'short task', questions: { area: short } }, options({ credential: null }));
    assert.deepEqual(fits.skipped, {});
    assert.equal(fits.answers.area.type, 'choice');
    // A score's levels share the head too.
    const levels = await backend.evaluate({ model: 'english', state: 'short task', questions: { risk: { type: 'score', instructions: 'How risky?', criteria: [long(4), long(4), long(4)] } } }, options({ credential: null })).catch(error => error);
    assert.equal(levels.errorClass, 'context');
    assert.equal(fake.requests.length, 3);
  });
});

test('a server’s own option limit skips a wider question (context) even when its text fits', async () => {
  await withFake('typesafe', async fake => {
    const caps = { ...presetCaps(S1_PRESETS.custom, 'jev-1.13.0'), maxOptions: 4, limitsSource: 'server' };
    const backend = new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: fake.url, model: 'jev-1.13.0', caps });
    const five = { type: 'choice', instructions: 'Which one?', criteria: { a: null, b: null, c: null, d: null, e: null } };
    const four = { type: 'choice', instructions: 'Which one?', criteria: { a: null, b: null, c: null, d: null } };
    const result = await backend.evaluate({ model: 'jev-1.13.0', state: 'x', questions: { billing: noul, five, four } }, options({ credential: { value: 'k-good', origin: fake.url } }));
    assert.deepEqual(result.skipped, { five: 'context' });
    assert.deepEqual(Object.keys(fake.requests[0].json.questions), ['billing', 'four']);
  });
});

test('Laya reads: 4-decimal vectors, entropy confidence only logged, a missing answer type inferred', async () => {
  await withFake('laya', async fake => {
    fake.script.omitType = true;
    fake.script.answers.area = [0.0712, 0.1133, 0.8155];
    const backend = new SystemOneHttpBackend({ id: 'laya', preset: 'laya', url: fake.url });
    const choice = { type: 'choice', instructions: 'Which area of the code do `changed_files` belong to?', criteria: { billing: 'Payment code', database: 'Schema', none_of_these: 'None of these' } };
    const result = await backend.evaluate({ model: 'typed-decisions', state: { changed_files: ['docs/README.md'] }, questions: { area: choice } }, options({ credential: null }));
    assert.equal(result.answers.area.choice, 'none_of_these');
    assert.equal(result.decimals, 4);
    assert.ok(result.vendorConfidence.area < result.answers.area.conf, 'entropy confidence is a different scale and never used');
    assert.equal(fake.requests[0].headers.authorization, undefined, 'a keyless server gets no Authorization header');
  });
});

test('endpoints: cloud routes are fixed; a person’s server is loopback http or https, base URL or full endpoint', () => {
  assert.equal(resolveEndpoint(S1_PRESETS.typesafe).endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(resolveEndpoint(S1_PRESETS.openrouter).endpoint, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(resolveEndpoint(S1_PRESETS.vercel).endpoint, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  assert.throws(() => resolveEndpoint(S1_PRESETS.typesafe, 'https://evil.example/v1/systemone'));
  assert.deepEqual(resolveEndpoint(S1_PRESETS.eikos), { endpoint: 'http://127.0.0.1:8000/v1/systemone', origin: 'http://127.0.0.1:8000', base: 'http://127.0.0.1:8000', locality: 'loopback' });
  assert.equal(resolveEndpoint(S1_PRESETS.laya, 'http://localhost:9000').endpoint, 'http://127.0.0.1:9000/v1/systemone');
  assert.equal(resolveEndpoint(S1_PRESETS.custom, 'http://[::1]:8000/').endpoint, 'http://[::1]:8000/v1/systemone');
  assert.equal(resolveEndpoint(S1_PRESETS.custom, 'https://decide.example.org/api').endpoint, 'https://decide.example.org/api/v1/systemone');
  assert.equal(resolveEndpoint(S1_PRESETS.custom, 'https://decide.example.org/api').locality, 'remote-host');
  assert.equal(resolveEndpoint(S1_PRESETS.custom, 'http://127.0.0.1:8000/v1/evaluate').endpoint, 'http://127.0.0.1:8000/v1/evaluate');
  assert.equal(resolveEndpoint(S1_PRESETS.custom, 'http://127.0.0.1:8000/v1/evaluate').base, 'http://127.0.0.1:8000');
  assert.throws(() => resolveEndpoint(S1_PRESETS.eikos, 'http://127.0.0.1:8000/v1/predict'), undefined, 'aliases are for custom servers only');
  for (const bad of ['http://192.168.1.5:8000', 'http://decide.example.org', 'https://user:pw@decide.example.org', 'https://decide.example.org/?k=1', 'https://decide.example.org/#x', 'ftp://127.0.0.1', 'not a url']) {
    assert.throws(() => resolveEndpoint(S1_PRESETS.custom, bad), error => error.errorClass === 'invalid-request', bad);
  }
  assert.equal(secretOwnerFor(S1_PRESETS.typesafe, 'x', 'vendor-cloud'), 'decision-jev');
  assert.equal(secretOwnerFor(S1_PRESETS.eikos, 'eikos1', 'loopback'), 'assistant-local-eikos1');
  assert.equal(secretOwnerFor(S1_PRESETS.custom, 'gpu', 'remote-host'), 'assistant-server-gpu');
});

test('a backend attaches a key only to its bound origin; keyless servers get no header', async () => {
  await withFake('eikos', async fake => {
    const backend = new SystemOneHttpBackend({ id: 'e', preset: 'eikos', url: fake.url });
    await assert.rejects(backend.evaluate(request('eikos'), options({ credential: { value: 'k-local', origin: 'http://127.0.0.1:1' } })), /another address/u);
    assert.equal(fake.requests.length, 0);
    await backend.evaluate(request('eikos'), options({ credential: null }));
    assert.equal(fake.requests[0].headers.authorization, undefined);
    await backend.evaluate(request('eikos'), options({ credential: { value: 'k-local', origin: fake.url } }));
    assert.equal(fake.requests[1].headers.authorization, 'Bearer k-local');
  });
});

test('a bare key string is only for a cloud route’s fixed address; any other server refuses it before egress', async () => {
  const foreign = 'k-openrouter-for-another-origin';
  await withFake('eikos', async fake => {
    const backend = new SystemOneHttpBackend({ id: 'e', preset: 'eikos', url: fake.url });
    await assert.rejects(backend.evaluate(request('eikos'), options({ credential: foreign })), error => error.errorClass === 'invalid-request');
    await assert.rejects(backend.probe('/health', options({ credential: foreign })), error => error.errorClass === 'invalid-request');
    await assert.rejects(backend.exchange(request('eikos'), options({ credential: foreign })), error => error.errorClass === 'invalid-request');
    await assert.rejects(runConformance(backend, { credential: foreign, signal: new AbortController().signal }), error => error.errorClass === 'invalid-request');
    assert.equal(fake.requests.length, 0);
  });
  const calls = [];
  const custom = new SystemOneHttpBackend({ id: 'gpu', preset: 'custom', url: 'https://decide.example.org', transport: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } });
  await assert.rejects(custom.evaluate(request('default'), options({ credential: foreign })), error => error.errorClass === 'invalid-request');
  await assert.rejects(custom.evaluate(request('default'), options({ credential: { value: foreign, origin: 'https://openrouter.ai' } })), /another address/u);
  assert.equal(calls.length, 0);
  // A cloud route binds a bare string to its own fixed origin.
  await withFake('openrouter', async fake => {
    await new SystemOneHttpBackend({ id: 'or', preset: 'openrouter', transport: fake.transport() }).evaluate(request('typesafe/jev-1.13'), options());
    assert.equal(fake.requests[0].headers.authorization, 'Bearer k-good');
  });
});

test('a redirect never carries the key anywhere: redirect is an error', async t => {
  const hits = [];
  const target = createServer((req, res) => { hits.push(req.headers.authorization ?? null); res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { target.closeAllConnections(); target.close(resolve); }));
  await withFake('typesafe', async fake => {
    fake.failNext({ status: 307, headers: { location: `http://127.0.0.1:${target.address().port}/v1/systemone` }, body: {} });
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    await assert.rejects(backend.evaluate(request('jev-1.13.0'), options()), error => ['transport', 'bad-request'].includes(error.errorClass));
    assert.deepEqual(hits, []);
  });
});

test('request ids: the TypeSafe header, never a guessed one', async () => {
  await withFake('typesafe', async fake => {
    const result = await new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() }).evaluate(request('jev-1.13.0'), options());
    assert.match(result.requestId, /^req_[0-9a-f]{32}$/u);
    assert.equal(result.resolvedVersion, 'jev-1.13.0');
    assert.deepEqual([result.usage.costSource, result.attempts], ['price-table', 1]);
  });
  await withFake('laya', async fake => {
    const result = await new SystemOneHttpBackend({ id: 'l', preset: 'laya', url: fake.url }).evaluate(request('typed-decisions'), options({ credential: null }));
    assert.equal(result.requestId, null);
  });
});

test('OpenRouter retries carry no TypeSafe retry header', async () => {
  await withFake('openrouter', async fake => {
    fake.failNext({ status: 429, headers: { 'retry-after-ms': '5' }, body: { error: { code: 429, message: 'Rate limited' } } });
    const result = await new SystemOneHttpBackend({ id: 'or', preset: 'openrouter', transport: fake.transport() }).evaluate(request('typesafe/jev-1.13'), options());
    assert.equal(result.attempts, 2);
    assert.equal(fake.requests[1].headers['x-typesafe-retry-count'], undefined);
  });
});
