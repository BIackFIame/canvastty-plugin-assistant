// The service transport with in-memory streams: host calls have a deadline and an in-flight cap and fail when the
// host goes away, oversized frames are skipped, handlers are capped, and shutdown lets running handlers answer.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { serve } from '../src/rpc.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

function start(options = {}, limits = {}) {
  const input = new PassThrough();
  const frames = [];
  const exits = [];
  let host;
  serve({
    methods: {}, ...options,
    onInitialize: (_params, given) => { host = given; },
    input, output: { write: text => { for (const line of text.split('\n').filter(Boolean)) frames.push(JSON.parse(line)); } },
    exit: code => exits.push(code),
    limits: { hostCallMs: 50, drainMs: 200, ...limits }
  });
  const write = message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  write({ method: 'canvastty.initialize', params: {} });
  return { input, frames, exits, write, host: () => host, answer: id => frames.find(f => f.id === id && !f.method) };
}

test('a host call without an answer fails at its deadline; a late answer is ignored', async () => {
  const rpc = start();
  await tick();
  const call = rpc.host().callHost('storage.get', { key: 'x' });
  await assert.rejects(call, /did not answer storage\.get in time/);
  const sent = rpc.frames.find(f => f.method === 'storage.get');
  rpc.write({ id: sent.id, result: 'late' });
  await tick();
  assert.equal(rpc.exits.length, 0);
});

test('host calls beyond the in-flight cap fail at once; end of input fails the pending ones and exits', async () => {
  const rpc = start({}, { hostCalls: 2, hostCallMs: 60_000 });
  await tick();
  const first = rpc.host().callHost('storage.get', {});
  const second = rpc.host().callHost('storage.get', {});
  await assert.rejects(rpc.host().callHost('storage.get', {}), /Too many host calls/);
  rpc.input.end();
  await assert.rejects(first, /host connection closed/);
  await assert.rejects(second, /host connection closed/);
  await assert.rejects(rpc.host().callHost('storage.get', {}), /connection is closed/);
  await tick();
  assert.deepEqual(rpc.exits, [0]);
});

test('an oversized frame is skipped without being held; the next frame is answered', async () => {
  const rpc = start({ methods: { echo: params => params.value } }, { frameBytes: 96 });
  rpc.input.write(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"value":"${'x'.repeat(40)}`);
  rpc.input.write(`${'y'.repeat(100)}"}}\n`);
  rpc.write({ id: 2, method: 'echo', params: { value: 'ok' } });
  // A frame split over many small chunks is joined once.
  for (const piece of JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'echo', params: { value: 'split' } }).match(/.{1,5}/gu)) rpc.input.write(piece);
  rpc.input.write('\n');
  await tick(); await tick();
  assert.equal(rpc.answer(1), undefined);
  assert.equal(rpc.answer(2).result, 'ok');
  assert.equal(rpc.answer(3).result, 'split');
  assert.ok(rpc.frames.some(f => f.method === 'log' && /larger than the frame limit/.test(f.params.message)));
});

test('requests beyond the handler cap are answered busy', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rpc = start({ methods: { wait: () => gate } }, { activeHandlers: 2 });
  for (const id of [1, 2, 3]) rpc.write({ id, method: 'wait' });
  await tick();
  assert.match(rpc.answer(3).error.message, /busy/);
  release('done');
  await tick(); await tick();
  assert.equal(rpc.answer(1).result, 'done');
  assert.equal(rpc.answer(2).result, 'done');
});

test('shutdown lets a running handler answer, refuses new requests, then exits', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rpc = start({ methods: { wait: () => gate } });
  rpc.write({ id: 1, method: 'wait' });
  await tick();
  rpc.write({ method: 'canvastty.shutdown' });
  rpc.write({ id: 2, method: 'wait' });
  await tick();
  assert.match(rpc.answer(2).error.message, /stopping/);
  assert.deepEqual(rpc.exits, []);
  release('answered');
  await tick(); await tick();
  assert.equal(rpc.answer(1).result, 'answered');
  assert.deepEqual(rpc.exits, [0]);
});

test('shutdown does not wait forever for a stuck handler', async () => {
  const rpc = start({ methods: { stuck: () => new Promise(() => undefined) } }, { drainMs: 30 });
  rpc.write({ id: 1, method: 'stuck' });
  await tick();
  rpc.write({ method: 'canvastty.shutdown' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(rpc.exits, [0]);
});

test('only own methods are handlers', async () => {
  const rpc = start({ methods: {} });
  rpc.write({ id: 1, method: 'toString' });
  await tick(); await tick();
  assert.equal(rpc.answer(1).error.code, -32601);
});
