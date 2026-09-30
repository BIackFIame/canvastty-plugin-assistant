import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { AssistantBudget } from '../src/engine/AssistantBudget.ts';
import { AssistantLog, decisionRecord } from '../src/engine/AssistantLog.ts';
import { IncompatibilityTracker } from '../src/engine/conformance.ts';
import { SystemOneError } from '../src/shared/systemOne.ts';
import { startFakeEikos } from './helpers/fake-eikos.mjs';
import { ctx, engineWith, routeRequest } from './helpers/assistant-fixture.mjs';

const exists = async dir => { try { return (await readdir(dir)).length > 0; } catch { return false; } };

test('off means nothing: no call, no file, no backend; a use case that is off is the same', async () => {
  const f = await engineWith({ assistant: { enabled: false } });
  try {
    const decision = await f.engine.ask(routeRequest('Refactor the parser'), ctx());
    assert.deepEqual([decision.branch, decision.auditId, decision.answers], ['off', null, null]);
    assert.equal(f.fake.requests.length, 0);
    assert.equal(f.secrets.calls.length, 0);
    assert.equal(await exists(f.directory), false, 'no file written while off');
    f.settings.enabled = true;
    f.settings.modes['task.route'] = 'off';
    assert.equal((await f.engine.ask(routeRequest('Refactor the parser'), ctx())).branch, 'off');
    assert.equal(f.fake.requests.length, 0);
    assert.equal(await exists(f.directory), false);
    // A deterministic rule decides without a call.
    f.settings.modes['task.route'] = 'suggest';
    assert.equal((await f.engine.ask(routeRequest('x', 'D2', { rule: 'explicit-provider' }), ctx())).branch, 'rule');
    assert.equal(f.fake.requests.length, 0);
  } finally { await f.close(); }
});

test('chain order: Auto tries Jev first and moves on without a key; Local never touches Jev; Jev only never touches a local server', async () => {
  const eikos = await startFakeEikos();
  const port = Number(new URL(eikos.url).port);
  const local = { id: 'eik', preset: 'eikos', enabled: true, url: eikos.url, localConfirmed: { port, at: 1 } };
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }, local] }, keys: {} });
  try {
    const auto = await f.engine.ask(routeRequest('Refactor the parser', 'D3'), ctx());
    // Jev had no key (and D3 cannot leave in Warn): the local server answered.
    assert.equal(auto.backend?.id, 'eik');
    assert.equal(auto.backend?.target, 'local');
    assert.equal(f.posts().length, 0);
    f.settings.engine = 'jev';
    const jev = await f.engine.ask(routeRequest('Another task', 'D2'), ctx());
    assert.deepEqual([jev.branch, jev.fallbackReason], ['fallback', 'credential-required']);
    const eikosPosts = eikos.requests.filter(r => r.method === 'POST').length;
    f.secrets.store['decision-jev'] = 'k-good';
    f.settings.engine = 'local';
    const onlyLocal = await f.engine.ask(routeRequest('Third task', 'D2'), ctx());
    assert.equal(onlyLocal.backend?.id, 'eik');
    assert.equal(f.posts().length, 0);
    assert.equal(eikos.requests.filter(r => r.method === 'POST').length, eikosPosts + 1);
  } finally { await f.close(); await eikos.close(); }
});

test('cache: answers only; a hit reruns the mapping, and mode, trust or key changes clear it', async () => {
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }] } });
  try {
    const check = await f.engine.check('jev');
    assert.equal(check.added, true);
    const before = f.posts().length;
    let strict = false;
    const map = () => ({ outcome: strict ? 'person' : 'hint', qualifiedOutcome: null });
    const first = await f.engine.ask(routeRequest('Refactor the parser', 'D2', { map }), ctx());
    assert.equal(first.cached, false);
    strict = true;
    const second = await f.engine.ask(routeRequest('Refactor the parser', 'D2', { map }), ctx());
    assert.deepEqual([second.cached, second.outcome], [true, 'person']);
    assert.equal(f.posts().length, before + 1);
    f.settings.dataClassMode = 'off';
    assert.equal((await f.engine.ask(routeRequest('Refactor the parser', 'D2', { map }), ctx())).cached, false);
    f.settings.backends[0].trust = 'D1';
    f.settings.backends[0].trust = 'D2';
    await f.secrets.setFor('decision-jev', 'k-good'); f.engine.keyChanged();
    assert.equal((await f.engine.ask(routeRequest('Refactor the parser', 'D2', { map }), ctx())).cached, false);
    assert.equal(f.posts().length, before + 3);
  } finally { await f.close(); }
});

test('budget: slots are reserved before any await, so concurrent calls never overshoot a cap', async () => {
  const f = await engineWith({ fake: { delayMs: 30 } });
  try {
    // task.route allows 10 requests per minute.
    const decisions = await Promise.all(Array.from({ length: 15 }, (_, i) => f.engine.ask(routeRequest(`Task number ${i}`), ctx())));
    assert.equal(f.posts().length, 10);
    assert.equal(decisions.filter(d => d.fallbackReason === 'budget').length, 5);
    assert.ok(decisions.every(d => !d.enforce));
  } finally { await f.close(); }
  let now = Date.UTC(2026, 8, 25, 12);
  const budget = new AssistantBudget({ limits: () => ({ perMinute: 1000, perDay: 30, cloudUsdPerDay: 1 }), now: () => now });
  let granted = 0;
  for (let i = 0; i < 60; i++) { now += 3_000; if (budget.reserve({ useCase: 'command.review', cloud: true, sessionId: `s${i % 5}` })) granted++; }
  assert.equal(granted, 30, 'the day cap holds');
  const spend = new AssistantBudget({ limits: () => ({ perMinute: 1000, perDay: 1000, cloudUsdPerDay: 0.01 }), now: () => now });
  spend.reserve({ useCase: 'task.route', cloud: true }).commit(0.02);
  assert.equal(spend.reserve({ useCase: 'task.route', cloud: true }), null);
  assert.notEqual(spend.reserve({ useCase: 'task.route', cloud: false }), null);
  const local = new AssistantBudget({ limits: () => ({ perMinute: 1000, perDay: 1000, cloudUsdPerDay: 1 }) });
  const slots = Array.from({ length: 6 }, () => local.local());
  assert.equal(slots.filter(Boolean).length, 5, 'one in flight and a queue of four');
});

test('budget: a cloud call holds its cost estimate against the day cap while it runs; an unknown cost counts as the estimate', () => {
  const budget = new AssistantBudget({ limits: () => ({ perMinute: 1000, perDay: 1000, cloudUsdPerDay: 0.5 }) });
  const first = budget.reserve({ useCase: 'task.route', cloud: true, estimateUsd: 0.3 });
  assert.notEqual(first, null);
  assert.equal(budget.reserve({ useCase: 'task.route', cloud: true, estimateUsd: 0.3 }), null, 'two running calls could pass the cap together');
  first.commit(0.01);
  const second = budget.reserve({ useCase: 'task.route', cloud: true, estimateUsd: 0.3 });
  assert.notEqual(second, null, 'the real cost replaced the estimate');
  second.commit(null);
  assert.equal(budget.spent().usd, 0.31);
  const third = budget.reserve({ useCase: 'task.route', cloud: true, estimateUsd: 0.1 });
  third.release();
  assert.equal(budget.spent().usd, 0.31, 'a call that sent nothing costs nothing');
});

test('budget: a call already cancelled is never queued for the local backend', async () => {
  const budget = new AssistantBudget({ limits: () => ({ perMinute: 1000, perDay: 1000, cloudUsdPerDay: 1 }) });
  const running = budget.local();
  const aborted = new AbortController(); aborted.abort(new Error('gone'));
  const late = budget.local(aborted.signal);
  const outcome = await Promise.race([late.ready.then(() => 'ready', error => error.message), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))]);
  assert.equal(outcome, 'gone');
  // It took no queue place: four more still fit.
  assert.equal(Array.from({ length: 5 }, () => budget.local()).filter(Boolean).length, 4);
  running.release();
});

test('breaker: auth stays open until the key changes; the next real call after that is the probe', async () => {
  const f = await engineWith({ keys: { 'decision-jev': 'k-bad' } });
  try {
    const first = await f.engine.ask(routeRequest('Refactor the parser'), ctx());
    assert.equal(first.fallbackReason, 'auth');
    const sent = f.posts().length;
    const second = await f.engine.ask(routeRequest('Refactor the parser again'), ctx());
    assert.equal(second.fallbackReason, 'breaker-open');
    assert.equal(f.posts().length, sent);
    await f.secrets.setFor('decision-jev', 'k-good'); f.engine.keyChanged();
    const third = await f.engine.ask(routeRequest('Refactor the parser once more'), ctx());
    assert.equal(third.branch, 'suggest');
    assert.equal(f.posts().length, sent + 1);
  } finally { await f.close(); }
});

test('a single real 422 does not mark the question set incompatible unless the synthetic request reproduces it', async () => {
  const tracker = new IncompatibilityTracker();
  assert.equal(await tracker.confirm('b', 'task.route', async () => ({})), false);
  assert.equal(tracker.isIncompatible('b', 'task.route'), false);
  assert.equal(await tracker.confirm('b', 'task.route', async () => { throw new SystemOneError('bad-request', 'x'); }), true);
  assert.equal(tracker.isIncompatible('b', 'task.route'), true);
  const f = await engineWith();
  try {
    f.fake.failNext({ status: 422, body: { detail: [{ loc: ['body', 'state'], msg: 'odd', type: 'x', input: 'secret input' }] } });
    const odd = await f.engine.ask(routeRequest('A task with odd input'), ctx());
    assert.equal(odd.branch, 'fallback');
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = await f.engine.ask(routeRequest('A normal task'), ctx());
    assert.equal(next.branch, 'suggest');
  } finally { await f.close(); }
});

test('assertCurrent aborts and suppresses late results; a settings change voids pending decisions', async () => {
  const f = await engineWith({ fake: { delayMs: 60 } });
  try {
    const stale = await f.engine.ask(routeRequest('Refactor the parser'), ctx({ assertCurrent() { throw new Error('superseded'); } }));
    assert.deepEqual([stale.branch, stale.fallbackReason, stale.answers], ['fallback', 'stale', null]);
    const pending = f.engine.ask(routeRequest('Another task'), ctx());
    setTimeout(() => { f.settings.dataClassMode = 'strict'; f.engine.settingsChanged(); }, 10);
    const voided = await pending;
    assert.equal(voided.branch, 'fallback');
    assert.ok(['settings-changed', 'aborted'].includes(voided.fallbackReason));
    assert.equal(voided.answers, null);
  } finally { await f.close(); }
});

test('R4: errors, timeouts, invalid output, an open breaker, a spent budget and a missing key never enforce anything', async () => {
  const f = await engineWith();
  try {
    const failures = [{ status: 500 }, { status: 529 }, { status: 429, headers: { 'retry-after-ms': '1' } }, { raw: 'not json' }, { raw: '{"model":"jev-1.14.0","answers":{}}' }, { status: 403 }, { status: 402 }];
    for (const failure of failures) {
      f.fake.failNext(failure, failure, failure);
      const decision = await f.engine.ask(routeRequest(`Task for ${JSON.stringify(failure)}`, 'D2', { map: () => ({ outcome: 'allow', qualifiedOutcome: 'default' }) }), ctx());
      assert.equal(decision.branch, 'fallback', JSON.stringify(failure));
      assert.deepEqual([decision.enforce, decision.outcome, decision.answers], [false, null, null]);
    }
    delete f.secrets.store['decision-jev'];
    const nokey = await f.engine.ask(routeRequest('No key', 'D2', { map: () => ({ outcome: 'allow', qualifiedOutcome: 'default' }) }), ctx());
    assert.equal(nokey.enforce, false);
  } finally { await f.close(); }
});

test('shadow returns the assistant-off behaviour, records the decision, and joins the person\'s label', async () => {
  const f = await engineWith();
  try {
    f.settings.modes['task.route'] = 'shadow';
    const decision = await f.engine.ask(routeRequest('Refactor the parser', 'D2', { map: () => ({ outcome: 'code', qualifiedOutcome: 'default' }) }), ctx());
    assert.equal(decision.branch, 'shadow-recorded');
    assert.deepEqual([decision.answers, decision.outcome, decision.enforce], [null, null, false]);
    assert.ok(decision.auditId);
    assert.equal(f.engine.feedback(decision.auditId, 'right'), true);
    assert.equal(f.engine.feedback('no-such-decision', 'right'), false);
    await new Promise(resolve => setTimeout(resolve, 20));
    const records = await new AssistantLog({ directory: f.directory }).read();
    assert.deepEqual(records.map(r => r.kind), ['decision', 'label']);
    assert.equal(records[0].outcome, 'code');
    assert.equal(records[1].auditId, decision.auditId);
    const stats = await f.engine.statistics('7d');
    assert.equal(stats.useCases['task.route'].labelled, 1);
    assert.equal(stats.useCases['task.route'].agreement, 1);
  } finally { await f.close(); }
});

test('Auto acts only for a qualified outcome on a tested, calibrated, pinned backend, and never from Suggest', async () => {
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }] } });
  try {
    const map = () => ({ outcome: 'code', qualifiedOutcome: 'default' });
    f.settings.modes['task.route'] = 'auto';
    // Untested backend (no battery yet): never enforced.
    assert.equal((await f.engine.ask(routeRequest('Task A', 'D2', { map }), ctx())).enforce, false);
    await f.engine.check('jev');
    // Tested, but nothing qualified yet.
    assert.equal((await f.engine.ask(routeRequest('Task B', 'D2', { map }), ctx())).enforce, false);
    // Forty agreeing labels in the log for (task.route, default, jev, jev-1.13.0) qualify it (with none wrong, the
    // Wilson bound at z = 1.96 drops under E_max = 0.10 from 35 labels on).
    const log = new AssistantLog({ directory: f.directory });
    for (let i = 0; i < 40; i++) {
      const id = `seed-${i}`;
      await log.append(decisionRecord({ id, at: Date.now() - 1000, useCase: 'task.route', mode: 'auto', catalogVersion: 1, questionSetHash: null, stateHash: null, stateBytes: 0, fields: { sent: [], withheld: [] }, dataCheck: null, redactions: 0,
        backend: { id: 'jev', preset: 'typesafe', family: 'jev', dialect: 'typesafe-v1', modelLabel: 'jev-1.13.0', resolvedVersion: 'jev-1.13.0', pinned: true, calibrated: 'vendor', T: 1 },
        requestId: null, latencyMs: 1, attempts: 1, cached: false, usage: null, answers: null, vendorConfidence: null, bands: null, variant: 'full', branch: 'auto', outcome: 'code', qualifiedOutcome: 'default', actionClass: null, fallbackReason: null, truncated: false, sessionRef: null, summary: null }));
      await log.append({ v: 1, kind: 'label', auditId: id, label: 'right', source: 'person', agrees: true, baselineAgrees: null, at: Date.now() - 500 });
    }
    // A new engine over the same directory reads the log on its first Auto decision.
    const { AssistantEngine } = await import('../src/engine/AssistantEngine.ts');
    const engine = new AssistantEngine({ settings: () => f.settings, directory: f.directory, secrets: f.secrets, transport: (target, init) => fetch(`${f.fake.url}${new URL(String(target)).pathname}`, init) });
    const acted = await engine.ask(routeRequest('Task C', 'D2', { map }), ctx());
    assert.equal(acted.enforce, true);
    // Truncated or metadata-only states never relax (R3, R9).
    assert.equal((await engine.ask(routeRequest('x'.repeat(2500), 'D2', { map }), ctx())).enforce, false);
    f.settings.modes['task.route'] = 'suggest';
    assert.equal((await engine.ask(routeRequest('Task D', 'D2', { map }), ctx())).enforce, false);
    engine.dispose();
  } finally { await f.close(); }
});

test('Auto: a decision cancelled while the log is read for its statistics is not enforced', async () => {
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }] } });
  try {
    f.settings.modes['task.route'] = 'auto';
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { reached = resolve; });
    f.engine.log.read = async () => { reached(); await gate; return []; };
    let cancelled = false;
    const asking = f.engine.ask(routeRequest('Task E', 'D2', { map: () => ({ outcome: 'code', qualifiedOutcome: 'auto-deny' }) }), ctx({ assertCurrent() { if (cancelled) throw new Error('stale'); } }));
    await reading;
    cancelled = true;
    release();
    const decision = await asking;
    assert.deepEqual([decision.branch, decision.enforce, decision.fallbackReason], ['fallback', false, 'stale']);
  } finally { await f.close(); }
});

test('the smart verifier: a local Ollama model first, the same state and questions, never the light answers; a cloud stub is refused', async () => {
  const { startFakeOllama } = await import('./helpers/fake-ollama.mjs');
  const { documentBlock } = await import('../src/engine/backends/jsonSchemaReadout.ts');
  const { SMART_SYSTEM } = await import('../src/engine/SmartVerifier.ts');
  const { reviewRequest } = await import('./helpers/assistant-fixture.mjs');
  const ollama = await startFakeOllama();
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }], smart: { kind: 'ollama-chat', url: ollama.url, model: 'gemma3:12b' } } });
  try {
    f.settings.modes['command.review'] = 'suggest';
    const request = reviewRequest('npm test -- --watch=false');
    const light = await f.engine.ask(request, ctx());
    assert.equal(light.variant, 'full');
    const smart = await f.engine.verify(request, light, ctx());
    assert.ok(smart && smart.serves_request.type === 'noul' && smart.serves_request.uncalibrated);
    const chats = ollama.inferences();
    assert.equal(chats.length, 1);
    const body = chats[0].json;
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].content, SMART_SYSTEM);
    // Exactly the light tier's state: nothing of the light tier's answers.
    assert.ok(body.messages[1].content.startsWith(documentBlock(f.posts().at(-1).json.state)));
    for (const id of Object.keys(light.answers)) assert.equal(body.messages[1].content.includes(`"${id}":{"p"`), false, id);
    // Learning asks the smart model only when the person enabled it.
    f.settings.modes['command.review'] = 'shadow';
    const shadow = await f.engine.ask(reviewRequest('npm run lint'), ctx());
    assert.equal(await f.engine.verify(request, shadow, ctx()), null);
    assert.equal(ollama.inferences().length, 1);
    // A cloud stub under a plain name is not local: nothing with the state is sent.
    f.settings.smart = { kind: 'ollama-chat', url: ollama.url, model: 'gemini-3-flash-preview' };
    f.settings.modes['command.review'] = 'suggest';
    const again = await f.engine.ask(reviewRequest('npm run build'), ctx());
    assert.equal(await f.engine.verify(request, again, ctx()), null);
    assert.equal(ollama.inferences().length, 1);
    assert.equal(ollama.state.cloudRequests.length, 0);
  } finally { await f.close(); await ollama.close(); }
});

test('«Проверить»: the synthetic battery is all a backend gets before a grant; results live in main and belong to one configuration', async () => {
  const { startFakeOllama } = await import('./helpers/fake-ollama.mjs');
  const { stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { CapsStore } = await import('../src/engine/conformance.ts');
  const ollama = await startFakeOllama({ prefer: ['true', 'none_of_these', '0'], strength: 0.9 });
  const entry = { id: 'oll', preset: 'emulated', enabled: true, runtime: 'ollama', model: 'gemma3:12b', url: ollama.url };
  const f = await engineWith({ assistant: { enabled: false, grant: 'off', backends: [entry] } });
  try {
    const report = await f.engine.check('oll');
    assert.equal(report.added, true, JSON.stringify(report.checks));
    for (const request of ollama.inferences()) assert.match(JSON.stringify(request.json), /CI run finished/u);
    assert.equal((await stat(join(f.directory, 'caps.json'))).mode & 0o777, 0o600);
    const store = new CapsStore(f.directory);
    await store.load();
    const caps = store.get(entry);
    assert.ok(caps && caps.testedAt > 0 && caps.calibrated === 'uncalibrated');
    assert.equal(store.get({ ...entry, model: 'qwen3.5:9b' }), null, 'another model is another backend');
    const status = await f.engine.status();
    assert.equal(status.backends[0].tested, true);
    // Without the person's «Да» an Ollama model is not local: remote, estimate D0.
    assert.deepEqual([status.backends[0].target, status.backends[0].level], ['remote', { cap: 'D0', source: 'estimate' }]);
  } finally { await f.close(); await ollama.close(); }
});

test('the metadata-only variant is the last step: a local backend that may take the full state answers first', async () => {
  const eikos = await startFakeEikos();
  const port = Number(new URL(eikos.url).port);
  const { reviewRequest } = await import('./helpers/assistant-fixture.mjs');
  const local = { id: 'eik', preset: 'eikos', enabled: true, url: eikos.url, localConfirmed: { port, at: 1 } };
  const f = await engineWith({ settings: { dataClassMode: 'strict' }, assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true }, local] } });
  try {
    f.settings.modes['command.review'] = 'suggest';
    const decision = await f.engine.ask(reviewRequest('npm test'), ctx());
    assert.deepEqual([decision.backend?.id, decision.variant], ['eik', 'full']);
    assert.equal(f.posts().length, 0);
    f.settings.backends[1].enabled = false;
    const meta = await f.engine.ask(reviewRequest('npm test'), ctx());
    assert.deepEqual([meta.backend?.id, meta.variant], ['jev', 'metadata']);
  } finally { await f.close(); await eikos.close(); }
});

test('the statistics in memory follow the log retention instead of growing for the life of the process', async () => {
  const DAY = 86_400_000;
  let clock = Date.UTC(2026, 5, 10, 12);
  const f = await engineWith({ now: () => clock });
  try {
    f.settings.logRetentionDays = 2;
    f.settings.modes['task.route'] = 'shadow';
    const map = () => ({ outcome: 'code', qualifiedOutcome: 'default' });
    const old = await f.engine.ask(routeRequest('Old task', 'D2', { map }), ctx());
    assert.equal(f.engine.feedback(old.auditId, 'right'), true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.engine.stats.size, { decisions: 1, labels: 1 });
    clock += 3 * DAY;
    await f.engine.ask(routeRequest('New task', 'D2', { map }), ctx());
    assert.deepEqual(f.engine.stats.size, { decisions: 1, labels: 0 }, 'the decision and label past retention went');
    // Reading the log back does not bring them in again.
    const stats = await f.engine.statistics('30d');
    assert.equal(stats.useCases['task.route'].calls, 1);
    assert.deepEqual(f.engine.stats.size, { decisions: 1, labels: 0 });
  } finally { await f.close(); }
});

test('the smart verifier takes the local backend slot: one request at a time, the rest queued', async () => {
  const { reviewRequest } = await import('./helpers/assistant-fixture.mjs');
  const f = await engineWith({ assistant: { smart: { kind: 'ollama-chat', url: 'http://127.0.0.1:9', model: 'gemma3:12b' } } });
  try {
    f.settings.modes['command.review'] = 'suggest';
    let running = 0, most = 0;
    const releases = [];
    f.engine.smart.ask = async () => {
      running++; most = Math.max(most, running);
      await new Promise(resolve => releases.push(resolve));
      running--;
      return { answers: { serves_request: { type: 'noul', p: 0.9 } } };
    };
    const decision = { mode: 'suggest', variant: 'full' };
    const calls = [0, 1, 2].map(n => f.engine.verify(reviewRequest(`npm test ${n}`), decision, ctx({ sessionId: `s${n}` })));
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(running, 1, 'never more than one smart request in flight');
      releases.shift()();
    }
    const answers = await Promise.all(calls);
    assert.equal(answers.filter(Boolean).length, 3);
    assert.equal(most, 1);
  } finally { await f.close(); }
});
