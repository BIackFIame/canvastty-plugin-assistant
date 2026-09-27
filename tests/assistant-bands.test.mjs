import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandOf, belowFloor, enforcement, reviewOutcome, ReviewCircuit, thresholdFor
} from '../src/engine/bands.ts';
import { ACTION_CLASSES, PERSON_ONLY_CLASSES, REVIEW_RISK_NOULS, REVIEW_TABLE_B } from '../src/shared/catalog.ts';
import { choiceAnswer, noulAnswer, scoreAnswer } from '../src/shared/systemOne.ts';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('bands: the confidence floor, Table A AUTO for Jev only, no AUTO for uncalibrated answers or other families', () => {
  // A noul at p = 0.6 is below the floor (conf = |2p − 1| = 0.2).
  assert.equal(belowFloor(noulAnswer(0.6)), true);
  assert.equal(bandOf(noulAnswer(0.6), {}, true), 'person');
  const kind = choiceAnswer(['code_change', 'debug', 'other'], [0.8, 0.1, 0.1], 'code_change');
  const { threshold } = thresholdFor('task.route', 'kind', 'jev', 'jev-1.13.0');
  assert.equal(bandOf(kind, threshold, true), 'auto');
  assert.equal(bandOf(kind, threshold, false), 'person');
  assert.equal(bandOf({ ...kind, uncalibrated: true }, threshold, true), 'person');
  for (const family of ['laya', 'eikos', 'systemone-generic', 'emulated']) assert.equal(bandOf(kind, thresholdFor('task.route', 'kind', family, 'x').threshold, true), 'person', family);
  // A fitted threshold for another family can open an AUTO band.
  const fitted = new Map([['task.route/kind/eikos/v1', { auto: { minTop: 0.7, minMargin: 0.3 } }]]);
  assert.equal(bandOf(kind, thresholdFor('task.route', 'kind', 'eikos', 'v1', fitted).threshold, true), 'auto');
  // A score split between two neighbours is a position, not confusion.
  const split = scoreAnswer([0.02, 0.03, 0.47, 0.48]);
  assert.equal(belowFloor(split), false);
  assert.equal(bandOf(split, thresholdFor('task.route', 'difficulty', 'jev', 'jev-1.13.0').threshold, true), 'auto');
  assert.equal(bandOf(undefined, threshold, true), 'person');
});

test('R10: Shadow shows and does nothing, Suggest enforces nothing (a block included), Auto acts only when qualified', () => {
  assert.deepEqual(enforcement('shadow', true), { act: false, show: false });
  assert.deepEqual(enforcement('suggest', true), { act: false, show: true });
  assert.deepEqual(enforcement('auto', false), { act: false, show: true });
  assert.deepEqual(enforcement('auto', true), { act: true, show: true });
  const noul = p => noulAnswer(p);
  const light = { serves_request: noul(0.05), addresses_reviewer: noul(0), effect_hidden: noul(0.1), external_effect: noul(0.1), destructive: noul(0.95), exfiltration: noul(0.1), persistence: noul(0.1), security_weakening: noul(0.1), obfuscated: noul(0.1) };
  const facts = { actionClass: 'build_test', unseeableEffect: false, riskyFacts: false, requestTypedByPerson: true, tier1: null };
  const base = { qualified: () => true, family: 'jev', calibrated: 'vendor', pinned: true, variant: 'full', truncated: false, session: { suspect: false, strict: false, personOnly: false } };
  assert.deepEqual([reviewOutcome(facts, light, { ...base, mode: 'suggest' }).outcome, reviewOutcome(facts, light, { ...base, mode: 'suggest' }).enforce], ['block', false]);
  assert.equal(reviewOutcome(facts, light, { ...base, mode: 'auto', qualified: () => false }).enforce, false);
  assert.equal(reviewOutcome(facts, light, { ...base, mode: 'auto' }).enforce, true);
});

test('R2: models only tighten — the triage\'s isolation never weakens an explicit choice', async () => {
  const { tightenIsolation } = await import('../src/triage/triage.ts');
  const next = rng(7);
  const isolations = ['direct', 'worktree', 'container'];
  for (let i = 0; i < 500; i++) {
    const base = isolations[Math.floor(next() * 3)], suggested = [...isolations, null, 'bogus'][Math.floor(next() * 5)];
    assert.ok(isolations.indexOf(tightenIsolation(base, suggested)) >= isolations.indexOf(base));
  }
});

test('property: R3 and R3-V are the only allow paths of command review; nothing missing ever allows', () => {
  const next = rng(42);
  const pick = list => list[Math.floor(next() * list.length)];
  const p = () => pick([0, 0.01, 0.05, 0.1, 0.15, 0.19, 0.25, 0.4, 0.5, 0.6, 0.85, 0.9, 0.93, 0.97, 1]);
  const ids = ['serves_request', 'addresses_reviewer', ...REVIEW_RISK_NOULS];
  let allows = 0;
  for (let i = 0; i < 20_000; i++) {
    // Half the cases start clean (requested, no risk), so both allow paths are reached often.
    const clean = next() < 0.5;
    const draw = id => clean ? (id === 'serves_request' ? pick([0.5, 0.85, 0.9, 0.93, 0.97, 1]) : pick([0, 0.01, 0.05, 0.1, 0.15, 0.19, 0.25])) : p();
    const light = Object.fromEntries(ids.map(id => [id, noulAnswer(draw(id))]));
    if (next() < 0.05) delete light[pick(ids)];
    const smart = next() < 0.5 ? Object.fromEntries(ids.map(id => [id, noulAnswer(draw(id))])) : null;
    const facts = { actionClass: pick(ACTION_CLASSES), unseeableEffect: next() < 0.2, riskyFacts: next() < 0.3, requestTypedByPerson: next() < 0.7, tier1: pick([null, null, null, null, 'deny', 'ask']) };
    const qualifiedSet = new Set(['auto-allow', 'verify-allow', 'auto-deny'].filter(() => next() < 0.5));
    const context = {
      mode: pick(['shadow', 'suggest', 'auto']), qualified: outcome => qualifiedSet.has(outcome), family: pick(['jev', 'jev', 'eikos', 'emulated']),
      calibrated: pick(['vendor', 'fitted', 'uncalibrated', null]), pinned: next() < 0.8, variant: pick(['full', 'full', 'metadata', null]), truncated: next() < 0.2,
      session: { suspect: next() < 0.1, strict: next() < 0.2, personOnly: next() < 0.05 }
    };
    const result = reviewOutcome(facts, next() < 0.03 ? null : light, context, smart);
    if (result.outcome === 'allow') {
      allows++;
      assert.ok(result.path === 'R3' || result.path === 'R3-V');
      assert.equal(facts.tier1, null);
      assert.equal(context.variant, 'full');
      assert.equal(context.session.suspect || context.session.personOnly, false);
      assert.equal(PERSON_ONLY_CLASSES.includes(facts.actionClass), false);
      assert.equal(facts.unseeableEffect, false);
      const lp = id => light[id].p;
      assert.ok(lp('addresses_reviewer') < 0.3 && lp('serves_request') >= 0.5 && REVIEW_RISK_NOULS.every(id => lp(id) < 0.5));
      if (result.path === 'R3') {
        const row = REVIEW_TABLE_B[facts.actionClass];
        assert.ok(row && context.family === 'jev' && lp('serves_request') >= row.tAllow && REVIEW_RISK_NOULS.every(id => lp(id) < row.rMax));
        assert.ok(!facts.riskyFacts && context.calibrated && context.calibrated !== 'uncalibrated' && context.pinned && !context.truncated);
        assert.ok(facts.actionClass === 'read_only' || facts.requestTypedByPerson && !context.session.strict);
        assert.equal(result.enforce, context.mode === 'auto' && qualifiedSet.has('auto-allow'));
      } else {
        assert.ok(smart && smart.serves_request.p >= 0.9 && REVIEW_RISK_NOULS.every(id => smart[id].p < 0.2));
        assert.equal(context.session.strict, false);
        assert.equal(result.enforce, context.mode === 'auto' && qualifiedSet.has('verify-allow'));
      }
    }
    if (result.enforce) assert.equal(context.mode, 'auto');
    if (result.outcome === 'block') assert.equal(result.enforce, context.mode === 'auto' && qualifiedSet.has('auto-deny'));
    // R7: an outcome is never a persistent permission.
    assert.ok(['person', 'block', 'allow', 'verify'].includes(result.outcome));
  }
  assert.ok(allows > 20, `the generator must reach both allow paths (${allows})`);
});

test('a requested dangerous command goes to the person, never a block; addresses_reviewer marks the session suspect', () => {
  const answers = values => Object.fromEntries(Object.entries({ serves_request: 0.95, addresses_reviewer: 0, effect_hidden: 0, external_effect: 0, destructive: 0, exfiltration: 0, persistence: 0, security_weakening: 0, obfuscated: 0, ...values }).map(([id, p]) => [id, noulAnswer(p)]));
  const facts = { actionClass: 'delete', unseeableEffect: false, riskyFacts: false, requestTypedByPerson: true, tier1: null };
  const context = { mode: 'auto', qualified: () => true, family: 'jev', calibrated: 'vendor', pinned: true, variant: 'full', truncated: false, session: { suspect: false, strict: false, personOnly: false } };
  assert.equal(reviewOutcome(facts, answers({ destructive: 0.95 }), context).outcome, 'person');
  assert.equal(reviewOutcome(facts, answers({ serves_request: 0.1, destructive: 0.95 }), context).outcome, 'block');
  const suspect = reviewOutcome({ ...facts, actionClass: 'read_only' }, answers({ addresses_reviewer: 0.4 }), context);
  assert.deepEqual([suspect.outcome, suspect.markSuspect], ['person', true]);
  // read_only in the AUTO band on a calibrated pinned Jev: auto allow.
  assert.deepEqual(reviewOutcome({ ...facts, actionClass: 'read_only' }, answers({}), context).path, 'R3');
  // build_test after the agent edited build files: no AUTO, only VERIFY.
  assert.equal(reviewOutcome({ ...facts, actionClass: 'build_test', riskyFacts: true }, answers({}), context).outcome, 'verify');
});

test('the 3 / 20 denial circuit makes a session person-only', () => {
  const circuit = new ReviewCircuit();
  for (let i = 0; i < 3; i++) circuit.record('s', 'block', true);
  assert.equal(circuit.personOnly('s'), true);
  const other = new ReviewCircuit();
  for (let i = 0; i < 20; i++) { other.record('t', 'block', true); other.record('t', 'allow', false); }
  assert.equal(other.personOnly('t'), true);
  const shown = new ReviewCircuit();
  for (let i = 0; i < 5; i++) shown.record('u', 'block', false);
  assert.equal(shown.personOnly('u'), false);
});
