import test from 'node:test';
import assert from 'node:assert/strict';
import { backendLevel, gateCap, gateFields, gateTarget, privacyGate } from '../src/engine/privacyGate.ts';
import { redactAndBound, redactForEgress, redactValue } from '../src/engine/redact.ts';
import { ctx, engineWith, reviewRequest, routeRequest } from './helpers/assistant-fixture.mjs';

// Secret-shaped fixtures are assembled at run time: the repository secret audit scans tests too.
const ANT = tail => ['sk', 'ant', tail].join('-');
const AWS = tail => `${'AK'}${'IA'}${tail}`;
const RANK = { D0: 0, D1: 1, D2: 2, D3: 3 };
const MODES = ['strict', 'warn', 'off'];
const GRANTS = ['off', 'D1', 'D2'];
const CLASSES = ['D0', 'D1', 'D2', 'D3'];
const min = (a, b) => RANK[a] <= RANK[b] ? a : b;

/** §1.5, written out independently of the implementation. */
function oracle(mode, grant, target, stateClass) {
  let cap;
  if (target.kind === 'local') cap = 'D3';
  else if (grant === 'off') cap = null;
  else if (mode === 'off') cap = 'D3';
  else if (mode === 'strict') cap = min(grant, target.level.cap);
  else cap = target.level.source === 'trust' ? min(grant, target.level.cap) : grant;
  return cap !== null && RANK[stateClass] <= RANK[cap];
}

const TARGETS = [
  { kind: 'remote', level: { cap: 'D2', source: 'trust' } }, { kind: 'remote', level: { cap: 'D0', source: 'trust' } },
  { kind: 'remote', level: { cap: 'D2', source: 'review' } }, { kind: 'remote', level: { cap: 'D0', source: 'review' } },
  { kind: 'remote', level: { cap: 'D0', source: 'estimate' } }, { kind: 'local' }
];

test('privacyGate matrix: 3 modes × 3 grants × 4 classes × every level source matches §1.5', () => {
  let cases = 0;
  for (const mode of MODES) for (const grant of GRANTS) for (const cls of CLASSES) for (const target of TARGETS) {
    assert.equal(privacyGate(mode, grant, target, cls).allowed, oracle(mode, grant, target, cls), JSON.stringify({ mode, grant, cls, target }));
    cases++;
  }
  assert.equal(cases, 3 * 3 * 4 * TARGETS.length);
});

test('D3 never reaches a remote System One backend in Strict or Warn, and does in Off only with texts allowed', () => {
  for (const target of TARGETS.filter(item => item.kind === 'remote')) {
    for (const grant of GRANTS) {
      assert.equal(privacyGate('strict', grant, target, 'D3').allowed, false);
      assert.equal(privacyGate('warn', grant, target, 'D3').allowed, false);
      assert.equal(privacyGate('off', grant, target, 'D3').allowed, grant !== 'off');
    }
  }
});

test('Warn only: a review or estimate below the grant never holds text back and returns a notice; a trust the person set limits', () => {
  const estimate = privacyGate('warn', 'D2', { kind: 'remote', level: { cap: 'D0', source: 'estimate' } }, 'D2');
  assert.deepEqual(estimate, { allowed: true, cap: 'D2', notice: { cap: 'D0', source: 'estimate' } });
  assert.equal(privacyGate('warn', 'D2', { kind: 'remote', level: { cap: 'D0', source: 'trust' } }, 'D1').allowed, false);
  assert.equal(privacyGate('strict', 'D2', { kind: 'remote', level: { cap: 'D0', source: 'estimate' } }, 'D1').allowed, false);
  // In Off nothing about classes is shown.
  assert.equal(privacyGate('off', 'D2', { kind: 'remote', level: { cap: 'D0', source: 'estimate' } }, 'D3').notice, undefined);
});

test('levels: the person\'s trust, else the D0 estimate (data-handling reviews are not ported)', () => {
  assert.deepEqual(backendLevel({ trust: 'D2' }), { cap: 'D2', source: 'trust' });
  assert.deepEqual(backendLevel({ trust: 'D0' }), { cap: 'D0', source: 'trust' });
  assert.deepEqual(backendLevel({}), { cap: 'D0', source: 'estimate' });
});

test('targets: local needs loopback and the person\'s «Да» for that port; anything else is remote at its level', () => {
  const entry = { id: 'e', preset: 'eikos', enabled: true, url: 'http://127.0.0.1:8000', localConfirmed: { port: 8000, at: 1 } };
  assert.equal(gateTarget(entry, 'loopback', 8000).kind, 'local');
  const remote = gateTarget({ ...entry, localConfirmed: undefined }, 'loopback', 8000);
  assert.equal(remote.kind, 'remote');
  // A remote backend keeps no D3: its level is the person's trust or the D0 estimate.
  assert.deepEqual(remote.target.level, { cap: 'D0', source: 'estimate' });
  assert.equal(gateTarget(entry, 'loopback', 9000).kind, 'remote');
  assert.equal(gateTarget(entry, 'ollama-cloud', 8000).kind, 'remote', 'an Ollama model not yet proven local');
  assert.equal(gateTarget(entry, 'remote-host', 8000).kind, 'remote');
});

test('gateFields: a field above the cap withholds the content; the metadata-only variant carries no free text, path or flag value', () => {
  const fields = [
    { name: 'person_request', value: 'deploy it', dataClass: 'D2', disclosure: 'content' },
    { name: 'action.command', value: 'git push --force origin main', dataClass: 'D2', disclosure: 'content' },
    { name: 'action.shape', value: { program: 'git', subcommand: 'push', flags: ['--force'] }, dataClass: 'D0', disclosure: 'metadata' },
    { name: 'facts', value: { network_access: 'sends data to a remote' }, dataClass: 'D0', disclosure: 'metadata' }
  ];
  const remote = { kind: 'remote', level: { cap: 'D0', source: 'estimate' } };
  const meta = gateFields(fields, 'strict', 'D2', remote, true);
  assert.equal(meta.variant, 'metadata');
  assert.deepEqual(meta.state, { action: { shape: { program: 'git', subcommand: 'push', flags: ['--force'] } }, facts: { network_access: 'sends data to a remote' } });
  assert.deepEqual(meta.withheld.map(([name]) => name), ['person_request', 'action.command']);
  assert.equal(gateFields(fields, 'strict', 'D2', remote, false).variant, null);
  const full = gateFields(fields, 'warn', 'D2', remote, true);
  assert.equal(full.variant, 'full');
  assert.equal(full.state.action.command, 'git push --force origin main');
  assert.deepEqual(full.notice, { cap: 'D0', source: 'estimate' });
});

test('redaction: both passes mask keys, env values, query strings and blobs, before any length bound', () => {
  const planted = `use ${ANT('api03-' + 'A'.repeat(28))} and Authorization: Bearer abcdefghijklmnop1234 and ${AWS('ABCDEFGHIJKLMNOP')}; FOO_TOKEN=supersecretvalue DEPLOY_ENV=prod https://x.example/cb?code=12345&state=abc 3f786850e387550fdab836ed7e6dc881de23001b`;
  const { text, count } = redactForEgress(planted);
  for (const secret of [ANT('api03'), 'abcdefghijklmnop1234', AWS('ABCDEFGHIJKLMNOP'), 'supersecretvalue', '=prod', 'code=12345', '3f786850e387550fdab836ed7e6dc881de23001b']) assert.equal(text.includes(secret), false, secret);
  assert.ok(count >= 6);
  assert.match(text, /<redacted:/u);
  // A path is not a blob.
  assert.equal(redactForEgress('src/main/services/assistant/backends/SystemOneHttpBackend.ts').count, 0);
  // Values under secret-named keys are masked whole.
  const masked = '<redacted:key-value>';
  assert.deepEqual(redactValue({ api_key: 'x', nested: { password: 'hunter2', note: 'ok' } }).value, { api_key: masked, nested: { password: masked, note: 'ok' } });
  // A key straddling the bound is masked whole first, and the cut never lands inside a marker.
  const key = ANT('api03-' + 'Z'.repeat(40));
  const bounded = redactAndBound('x'.repeat(1990) + key, 2000);
  assert.equal(bounded.text.includes(ANT('')), false);
  assert.equal(bounded.text.includes('ZZZZ'), false);
  assert.equal(/<redacted:[^>]*$/u.test(bounded.text), false);
});

test('TypeSafe direct in Strict without trust: metadata only; one click of trust D2 sends D2 texts', async () => {
  const f = await engineWith({ settings: { dataClassMode: 'strict' } });
  try {
    const routed = await f.engine.ask(routeRequest('Refactor the parser in src/parse.ts'), ctx());
    assert.equal(routed.branch, 'fallback');
    assert.equal(routed.fallbackReason, 'data-class');
    assert.equal(f.posts().length, 0);
    // The gate ran before any credential read.
    assert.equal(f.secrets.calls.length, 0);
    const reviewed = await f.engine.ask(reviewRequest('npm test'), ctx());
    assert.equal(reviewed.variant, 'metadata');
    const body = f.posts()[0].json;
    assert.deepEqual(Object.keys(body.state).sort(), ['action', 'facts']);
    assert.deepEqual(Object.keys(body.state.action), ['tool', 'shape']);
    assert.equal(JSON.stringify(body).includes('Run the unit tests'), false);
    assert.deepEqual(Object.keys(body.questions).sort(), ['destructive', 'exfiltration', 'external_effect', 'persistence', 'security_weakening']);

    f.settings.backends[0].trust = 'D2';
    const trusted = await f.engine.ask(routeRequest('Refactor the parser in src/parse.ts'), ctx());
    assert.equal(trusted.variant, 'full');
    assert.equal(f.posts().at(-1).json.state.task, 'Refactor the parser in src/parse.ts');
  } finally { await f.close(); }
});

test('Warn only sends D2 texts with the notice; Off sends a D3 state; metadata-only grant sends no text in any mode', async () => {
  const f = await engineWith();
  try {
    const warned = await f.engine.ask(routeRequest('Refactor the parser'), ctx());
    assert.equal(warned.variant, 'full');
    assert.deepEqual(warned.notice, { backendId: 'jev', cap: 'D0', source: 'estimate' });
    f.settings.dataClassMode = 'off';
    const off = await f.engine.ask(routeRequest('Secret roadmap text', 'D3'), ctx());
    assert.equal(off.variant, 'full');
    assert.equal(off.notice, null);
    assert.equal(f.posts().at(-1).json.state.task, 'Secret roadmap text');
    for (const mode of ['strict', 'warn', 'off']) {
      f.settings.dataClassMode = mode;
      f.settings.grant = 'off';
      const before = f.posts().length;
      const decision = await f.engine.ask(routeRequest('Some task', 'D0'), ctx());
      assert.equal(decision.fallbackReason, 'metadata-grant-required', mode);
      assert.equal(f.posts().length, before, mode);
    }
  } finally { await f.close(); }
});

test('credential redaction reaches the fake in Strict, Warn and Off alike', async () => {
  const f = await engineWith({ assistant: { backends: [{ id: 'jev', preset: 'typesafe', enabled: true, trust: 'D2' }] } });
  try {
    for (const mode of ['strict', 'warn', 'off']) {
      f.settings.dataClassMode = mode;
      const task = `${mode}: deploy with ${ANT('api03-' + 'Q'.repeat(30))} and Bearer ${'t0k3n'.repeat(4)} and ${AWS('QWERTYUIOPASDFGH')} OPENAI_API_KEY=abc123def456`;
      const decision = await f.engine.ask(routeRequest(task), ctx());
      assert.equal(decision.variant, 'full', mode);
      const raw = f.posts().at(-1).raw;
      for (const secret of [ANT('api03'), 't0k3nt0k3n', AWS('QWERTYUIOPASDFGH'), 'abc123def456']) assert.equal(raw.includes(secret), false, `${mode} ${secret}`);
      assert.match(raw, /<redacted:/u);
    }
  } finally { await f.close(); }
});
