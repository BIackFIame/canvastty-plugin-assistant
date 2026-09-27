import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemOneHttpBackend } from '../src/engine/backends/SystemOneHttpBackend.ts';
import { BATTERY_STATE, batteryRequest, driftOf, lowerLimits, runConformance } from '../src/engine/backends/capabilities.ts';
import { presetCaps, S1_PRESETS } from '../src/engine/backends/systemOneRoutes.ts';
import { makeBrain, startFakeEikos } from './helpers/fake-eikos.mjs';
import { startFakeSystemOne } from './helpers/fake-systemone.mjs';

const signal = () => new AbortController().signal;
const status = (report, id) => report.checks.find(check => check.id === id)?.status;
const noul = { type: 'noul', instructions: 'Is the task about billing?', criteria: { true: 'It is about billing', false: 'It is not about billing' } };

/** `runOptions` may be a function of the fake (a key is bound to its address). */
async function eikosRun(fakeOptions = {}, runOptions = {}) {
  const fake = await startFakeEikos(fakeOptions);
  try {
    const backend = new SystemOneHttpBackend({ id: 'eikos1', preset: 'eikos', url: fake.url });
    const report = await runConformance(backend, { credential: null, signal: signal(), ...(typeof runOptions === 'function' ? runOptions(fake) : runOptions) });
    return { report, fake, backend, live: fake.liveSessions() };
  } finally { await fake.close(); }
}

test('a known-answer Eikos server passes every row, and the battery is the only content it receives', async () => {
  const { report, fake, live } = await eikosRun({ statelessDelayMs: 30, sessionDelayMs: 5 });
  assert.equal(report.added, true);
  assert.equal(report.dialect, 'eikos');
  for (const id of ['probe', 'route', 'shape', 'score', 'known-answers', 'determinism', 'option-order', 'model-identity', 'sessions', 'max-questions', 'latency']) assert.equal(status(report, id), 'pass', id);
  assert.equal(report.caps.deterministic, true);
  assert.equal(report.caps.orderSensitivity, 'none');
  assert.equal(report.caps.sessions, true);
  assert.ok(report.caps.sessionSpeedup > 1.2, `speedup ${report.caps.sessionSpeedup}`);
  assert.equal(report.caps.reportsVersion, 'fingerprint');
  assert.equal(report.caps.calibrated, 'uncalibrated', 'no AUTO until a calibration fit passes');
  assert.equal(report.caps.keyEnforced, null);
  assert.match(report.caps.fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(report.caps.modelHash, /^[0-9a-f]{64}$/u);
  assert.ok(report.requests <= 10, `requests ${report.requests}`);
  assert.deepEqual(live, [], 'every session the battery created was deleted');
  const posts = fake.requests.filter(item => item.method === 'POST' && item.path.endsWith('/systemone'));
  for (const item of posts) {
    const state = typeof item.json.state === 'string' ? JSON.parse(item.json.state) : item.json.state;
    assert.ok(JSON.stringify(state) === JSON.stringify(BATTERY_STATE) || JSON.stringify(state) === '{"n":3}' || item.path.includes('/sessions/'), 'nothing but synthetic battery data');
  }
  assert.equal(fake.requests.some(item => item.headers.authorization), false);
});

test('a confidently wrong model is refused; an unsure one is added but stays uncalibrated', async () => {
  const wrong = await eikosRun({ behaviour: 'wrong' });
  assert.equal(wrong.report.added, false);
  assert.equal(status(wrong.report, 'known-answers'), 'fail');
  const unsure = await eikosRun({ behaviour: 'unsure' });
  assert.equal(unsure.report.added, true);
  assert.equal(status(unsure.report, 'known-answers'), 'warn');
  assert.equal(unsure.report.caps.calibrated, 'uncalibrated');
});

test('a noisy model gets deterministic:false (no cache, no AUTO); a position-biased one gets symmetric averaging', async () => {
  const noisy = await eikosRun({ noise: 0.05 });
  assert.equal(noisy.report.caps.deterministic, false);
  assert.equal(status(noisy.report, 'determinism'), 'warn');
  const mild = await eikosRun({ biasStrength: 0.2 });
  assert.equal(mild.report.caps.orderSensitivity, 'mild');
  assert.equal(mild.report.added, true);
  const strong = await eikosRun({ biasStrength: 0.5 });
  assert.equal(strong.report.caps.orderSensitivity, 'strong', 'the top flips with the order');
  assert.equal(strong.report.caps.calibrated, 'uncalibrated');
  assert.equal(strong.report.added, true);
  assert.equal((await eikosRun({ biasStrength: 0.9 })).report.added, false, 'so biased it is confidently wrong');
});

test('a score 422 sets types.score=false and scores are then asked as choices over the same levels', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    fake.script.rejectScore = true;
    const backend = new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() });
    const report = await runConformance(backend, { credential: 'k-good', signal: signal() });
    assert.equal(report.added, true);
    assert.equal(report.caps.types.score, false);
    assert.equal(status(report, 'score'), 'warn');
    assert.equal(status(report, 'known-answers'), 'pass');
    assert.equal(report.caps.calibrated, 'vendor');
    assert.equal(report.caps.keyEnforced, true);
    backend.setCaps(report.caps);
    fake.requests.length = 0;
    const result = await backend.evaluate({ model: 'jev-1.13.0', state: 'x', questions: { size: { type: 'score', instructions: 'How large?', criteria: ['Tiny', 'Medium', 'Large'] } } }, { signal: signal(), deadlineAt: Date.now() + 3000, credential: 'k-good' });
    assert.equal(fake.requests[0].json.questions.size.type, 'choice');
    assert.deepEqual(fake.requests[0].json.questions.size.criteria, { 0: 'Tiny', 1: 'Medium', 2: 'Large' });
    const answer = result.answers.size;
    assert.equal(answer.type, 'score');
    assert.ok(Math.abs(answer.expectation - answer.probabilities.reduce((s, p, i) => s + i * p, 0)) < 1e-12);
  } finally { await fake.close(); }
});

test('an unstable model id makes the backend unpinnable', async () => {
  const fake = await startFakeEikos({ rotateModels: ['/opt/a/Eikos-4B', '/opt/b/Eikos-4B'] });
  try {
    const backend = new SystemOneHttpBackend({ id: 'e', preset: 'eikos', url: fake.url });
    const report = await runConformance(backend, { credential: null, signal: signal() });
    assert.equal(report.caps.reportsVersion, 'none');
    assert.equal(status(report, 'model-identity'), 'warn');
    backend.setCaps(report.caps);
    for (let i = 0; i < 2; i++) {
      const result = await backend.evaluate({ model: 'eikos', state: 'x', questions: { q: noul } }, { signal: signal(), deadlineAt: Date.now() + 3000, credential: null });
      assert.equal(result.resolvedVersion, null, 'never pinned, so never AUTO');
    }
  } finally { await fake.close(); }
  const stable = await eikosRun();
  assert.equal(stable.report.caps.reportsVersion, 'fingerprint');
});

test('a server-reported limit can only lower the preset', async () => {
  const caps = presetCaps(S1_PRESETS.custom, 'default');
  const lowered = lowerLimits(caps, { max_questions: 8, max_answers_per_question: 100000, max_input_tokens: 4000 });
  assert.deepEqual([lowered.maxQuestions, lowered.maxOptions, lowered.maxStateTokensPerQuestion, lowered.contextTokens, lowered.limitsSource], [8, 255, 4000, 4000, 'server']);
  assert.deepEqual(lowerLimits(caps, { max_questions: 1000 }), caps);
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    fake.script.limits = { max_questions: 12, max_answers_per_question: 1000 };
    const report = await runConformance(new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: fake.url, model: 'jev-1.13.0' }), { credential: { value: 'k-good', origin: fake.url }, signal: signal() });
    assert.equal(report.caps.maxQuestions, 12);
    assert.equal(report.caps.maxOptions, 255);
    assert.equal(report.caps.limitsSource, 'server');
    assert.equal(status(report, 'max-questions'), undefined, 'the 16-question probe is skipped below 16');
  } finally { await fake.close(); }
});

test('fewer than 16 questions per request is observed and requests are split', async () => {
  const fake = await startFakeSystemOne({ mode: 'laya' });
  try {
    fake.script.maxQuestions = 8;
    const backend = new SystemOneHttpBackend({ id: 'l', preset: 'laya', url: fake.url });
    const report = await runConformance(backend, { credential: null, signal: signal() });
    assert.equal(status(report, 'max-questions'), 'warn');
    assert.equal(report.caps.maxQuestions, 3);
    assert.equal(report.caps.limitsSource, 'observed');
    backend.setCaps(report.caps);
    fake.requests.length = 0;
    const questions = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q${i}`, { ...noul, instructions: `Is item ${i} about billing?` }]));
    await backend.evaluate({ model: 'typed-decisions', state: 'x', questions }, { signal: signal(), deadlineAt: Date.now() + 3000, credential: null });
    assert.deepEqual(fake.requests.map(item => Object.keys(item.json.questions).length), [3, 3, 1]);
  } finally { await fake.close(); }
});

test('fingerprint drift above 0.03 is a new model; below it the fingerprint holds', async () => {
  const first = await eikosRun();
  const same = await eikosRun({}, { previous: first.report.caps });
  assert.equal(same.report.drift, 'same');
  assert.equal(same.report.caps.fingerprint, first.report.caps.fingerprint);
  const small = await eikosRun({ fingerprintShift: 0.02 }, { previous: first.report.caps });
  assert.equal(small.report.drift, 'same');
  const moved = await eikosRun({ fingerprintShift: 0.05 }, { previous: first.report.caps });
  assert.equal(moved.report.drift, 'changed');
  assert.ok(driftOf(moved.report.caps.fingerprintVector, first.report.caps.fingerprintVector) > 0.03);
  const fitted = { ...first.report.caps, calibrated: 'fitted' };
  assert.equal((await eikosRun({}, { previous: fitted })).report.caps.calibrated, 'fitted', 'a re-check of the same model keeps its fit');
  assert.equal((await eikosRun({ fingerprintShift: 0.05 }, { previous: fitted })).report.caps.calibrated, 'uncalibrated', 'a changed model starts over');
});

test('sessions: used only when proven, and every created session is deleted even when asking fails', async () => {
  const noSessions = await startFakeSystemOne({ mode: 'laya' });
  try {
    const report = await runConformance(new SystemOneHttpBackend({ id: 'l', preset: 'laya', url: noSessions.url }), { credential: null, signal: signal() });
    assert.equal(report.caps.sessions, false);
    assert.equal(noSessions.requests.some(item => item.path.includes('sessions')), false, 'no sessions probe outside the eikos dialect');
  } finally { await noSessions.close(); }
  const mismatch = await eikosRun({});
  assert.equal(mismatch.report.caps.sessions, true);
  const fake = await startFakeEikos();
  try {
    let asks = 0;
    const brain = makeBrain();
    // The session answer differs from the stateless one: sessions are refused.
    fake.setBrain((state, question, labels) => { const vector = brain(state, question, labels); return typeof state === 'string' && asks++ === 0 ? vector.map((p, i) => i === 0 ? p - 0.1 : p + 0.1) : vector; });
    const report = await runConformance(new SystemOneHttpBackend({ id: 'e', preset: 'eikos', url: fake.url }), { credential: null, signal: signal() });
    assert.equal(report.caps.sessions, false);
    assert.deepEqual(fake.liveSessions(), []);
  } finally { await fake.close(); }
});

test('key probe: a wrong key must be refused on a loopback server with a key', async () => {
  const laya = await startFakeSystemOne({ mode: 'laya', keys: ['k-local'] });
  try {
    const backend = new SystemOneHttpBackend({ id: 'l', preset: 'laya', url: laya.url });
    const report = await runConformance(backend, { credential: { value: 'k-local', origin: laya.url }, signal: signal() });
    assert.equal(report.caps.keyEnforced, true);
    assert.equal(status(report, 'key'), 'pass');
    const wrong = laya.requests.filter(item => item.headers.authorization && item.headers.authorization !== 'Bearer k-local');
    assert.equal(wrong.length, 1);
  } finally { await laya.close(); }
  const { report } = await eikosRun({}, fake => ({ credential: { value: 'k-ignored', origin: fake.url } }));
  assert.equal(report.caps.keyEnforced, false, 'serve.py never reads the Authorization header');
  assert.equal(status(report, 'key'), 'warn');
});

test('route failures say why and add nothing', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const refused = await runConformance(new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() }), { credential: 'k-bad', signal: signal() });
    assert.deepEqual([refused.added, refused.failure, status(refused, 'route')], [false, 'auth', 'fail']);
    const missing = await runConformance(new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: fake.transport() }), { credential: null, signal: signal() });
    assert.equal(missing.failure, 'auth', 'TypeSafe answers 403 for a missing key');
  } finally { await fake.close(); }
  const down = await runConformance(new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: 'http://127.0.0.1:9' }), { credential: null, signal: signal(), timeoutMs: 1000 });
  assert.deepEqual([down.added, down.failure], [false, 'transport']);
  const wrongShape = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    wrongShape.failNext({ raw: JSON.stringify({ model: 'jev-1.13.0', answers: { q_noul: { type: 'noul', noul: 3 } }, usage: {} }) });
    const report = await runConformance(new SystemOneHttpBackend({ id: 't', preset: 'typesafe', transport: wrongShape.transport() }), { credential: 'k-good', signal: signal() });
    assert.deepEqual([report.added, status(report, 'shape')], [false, 'fail']);
  } finally { await wrongShape.close(); }
});

test('a custom server the battery finds to be Laya or Eikos takes that dialect’s limits: an oversize state is refused, never truncated', async () => {
  const call = () => ({ signal: signal(), deadlineAt: Date.now() + 3000, credential: null });
  // About 895 tokens: past the english checkpoint's 300-token room, far below the custom preset's 30,000.
  const state = { task: 'The invoice total is wrong after the discount step. '.repeat(60) };
  const laya = await startFakeSystemOne({ mode: 'laya' });
  try {
    const backend = new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: laya.url });
    const report = await runConformance(backend, { credential: null, signal: signal() });
    assert.equal(report.added, true);
    assert.equal(report.dialect, 'laya');
    // The configured model names no checkpoint, so the router may pick english: its limits apply.
    assert.deepEqual([report.caps.maxStateTokensPerQuestion, report.caps.maxOptions, report.caps.contextTokens, report.caps.maxQuestions, report.caps.optionHeadTokens], [300, 126, 0, 64, 192]);
    backend.setCaps(report.caps);
    laya.requests.length = 0;
    await assert.rejects(backend.evaluate({ model: 'default', state, questions: { billing: noul } }, call()), error => error.errorClass === 'context');
    assert.equal(laya.requests.length, 0);
    // The room follows the dialect even when the stored caps are still the custom preset's.
    const stale = new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: laya.url, caps: { ...presetCaps(S1_PRESETS.custom, 'default'), dialect: 'laya' } });
    await assert.rejects(stale.evaluate({ model: 'default', state, questions: { billing: noul } }, call()), error => error.errorClass === 'context');
    await assert.rejects(stale.evaluate({ model: 'constructor', state, questions: { billing: noul } }, call()), error => error.errorClass === 'context');
    assert.equal(laya.requests.length, 0);
    // About 450 tokens: inside multilingual's 700-token room.
    const medium = { task: 'The invoice total is wrong after the discount step. '.repeat(30) };
    const checkpoint = await stale.evaluate({ model: 'multilingual', state: medium, questions: { billing: noul } }, call());
    assert.equal(laya.requests[0].json.state.task, medium.task, 'within a named checkpoint’s room, sent byte for byte');
    assert.ok(checkpoint.answers.billing);
  } finally { await laya.close(); }
  const eikos = await startFakeEikos({ vllm: true });
  try {
    const backend = new SystemOneHttpBackend({ id: 'c', preset: 'custom', url: eikos.url });
    const report = await runConformance(backend, { credential: null, signal: signal() });
    assert.equal(report.dialect, 'eikos');
    assert.deepEqual([report.caps.maxStateTokensPerQuestion, report.caps.maxQuestions, report.caps.contextTokens], [15_000, 16, 0]);
    backend.setCaps(report.caps);
    const sent = eikos.requests.length;
    // About 20,000 tokens: serve.py would answer 422 (PyTorch) or a retried 500 (vLLM); the pre-count skips it.
    await assert.rejects(backend.evaluate({ model: 'default', state: 'word '.repeat(14_000), questions: { q: noul } }, call()), error => error.errorClass === 'context');
    assert.equal(eikos.requests.length, sent);
  } finally { await eikos.close(); }
});

test('a TypeSafe alias echoed back unchanged names no version: the battery refuses it', async () => {
  const fake = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    fake.setLatest('jev-latest');
    const report = await runConformance(new SystemOneHttpBackend({ id: 't', preset: 'typesafe', model: 'jev-latest', transport: fake.transport() }), { credential: 'k-good', signal: signal() });
    assert.deepEqual([report.added, report.failure, status(report, 'model-identity')], [false, 'version-mismatch', 'fail']);
  } finally { await fake.close(); }
});

test('every cloud preset passes the battery against its fake, with the route’s own tolerance and version kind', async () => {
  for (const [mode, preset, reportsVersion] of [['typesafe', 'typesafe', 'versioned'], ['openrouter', 'openrouter', 'dated'], ['vercel', 'vercel', 'alias']]) {
    const fake = await startFakeSystemOne({ mode });
    try {
      const report = await runConformance(new SystemOneHttpBackend({ id: mode, preset, transport: fake.transport() }), { credential: 'k-good', signal: signal() });
      assert.equal(report.added, true, mode);
      assert.equal(report.caps.reportsVersion, reportsVersion, mode);
      assert.equal(report.caps.decimals, 2);
      assert.equal(report.caps.deterministic, true);
      assert.equal(report.gateway, mode !== 'typesafe', mode);
      assert.ok(report.requests <= 10);
    } finally { await fake.close(); }
  }
  const alias = await startFakeSystemOne({ mode: 'typesafe' });
  try {
    const report = await runConformance(new SystemOneHttpBackend({ id: 't', preset: 'typesafe', model: 'jev-latest', transport: alias.transport() }), { credential: 'k-good', signal: signal() });
    assert.equal(report.caps.reportsVersion, 'versioned', 'jev-latest reports its resolved version');
  } finally { await alias.close(); }
  assert.deepEqual(Object.keys(batteryRequest('m').questions), ['q_noul', 'q_choice', 'q_score']);
});
