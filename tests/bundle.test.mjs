// The installable package as CanvasTTY runs it: the manifest's file integrity, the manifest against CanvasTTY's own
// validator (when CANVASTTY_REPO points at a checkout), and the bundled service as a child process speaking JSON-RPC
// lines, with the host's calls answered by the test and a fake Ollama as the model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-assistant-bundle-')));
const project = join(base, 'project');
mkdirSync(join(project, '.git'), { recursive: true });
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

test('the manifest\'s coreFiles match the package bytes, and the service and page are single bundled files', () => {
  for (const file of manifest.coreFiles) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path}: run npm run build`);
  }
  for (const path of ['services/assistant.mjs', 'settings/assistant.js']) {
    assert.ok(manifest.coreFiles.some(file => file.path === path), path);
    assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /^import .* from ["']\.\.?\//mu, `${path} is bundled`);
  }
});

test('the manifest passes CanvasTTY\'s own validator (when CANVASTTY_REPO points at a checkout)', { skip: !process.env.CANVASTTY_REPO }, async () => {
  const { validatePluginManifest } = await import(join(process.env.CANVASTTY_REPO, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  assert.deepEqual(checked.services[0].decide, { events: ['pre-tool'], timeoutMs: 45_000 });
  assert.equal(checked.services[0].launch.policy, undefined);
  assert.deepEqual(checked.services[0].tools.map(tool => tool.name), ['recommend', 'review_status']);
});

function startService(t, { dataDir, host = {} }) {
  const child = spawn(process.execPath, [join(root, 'services', 'assistant.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map();
  const hostCalls = [];
  const events = [];
  let nextId = 1;
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: child.stdout }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      hostCalls.push({ method: message.method, params: message.params });
      try {
        const handler = host[message.method];
        if (!handler) throw new Error(`host: ${message.method} not allowed`);
        write({ id: message.id, result: (await handler(message.params)) ?? null });
      } catch (error) {
        write({ id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.method === 'event') { events.push(message.params); return; }
    if (message.method) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  write({ method: 'canvastty.initialize', params: { apiVersion: 2, pluginId: manifest.id, serviceId: 'assistant', dataDir, locale: 'ru', hostVersion: 'test' } });
  return {
    hostCalls, events,
    request: (method, params) => new Promise((resolve, reject) => {
      const id = `t${nextId++}`;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    })
  };
}

const decide = (command, extra = {}) => ({
  event: 'pre-tool', sessionId: 'card-1', provider: 'claude', role: 'agent', cwd: project, agentCwd: project,
  tool: { name: 'Bash', kind: 'shell', command, paths: [] }, input: { command }, truncated: false, budgetMs: 45_000, ...extra
});

test('end to end over JSON-RPC: off answers nothing; on in Auto the rule allows git status, sudo is denied, an unclear command asks; «Проверить» reports', async t => {
  const ollama = await startFakeOllama({ prefer: ['true', 'none_of_these', '0'] });
  t.after(() => ollama.close());
  const storage = {};
  const service = startService(t, {
    dataDir: join(base, 'data'),
    host: {
      'storage.get': ({ key }) => storage[key] ?? null,
      'storage.set': ({ key, value }) => { storage[key] = value; },
      'sessions.subscribe': () => ({ sessions: [] }),
      'secrets.get': () => null,
      'redaction.register': () => null,
      'cards.setBadge': () => null
    }
  });
  // Off by default: no opinion, no model.
  assert.equal(await service.request('canvastty.decide', decide('sudo ls')), null);
  const { settings } = await service.request('state');
  assert.equal(settings.enabled, false);
  const port = Number(new URL(ollama.url).port);
  await service.request('save', { settings: { ...settings, enabled: true, modes: { 'task.route': 'suggest', 'command.review': 'auto' },
    backends: [{ id: 'emulated-1', preset: 'emulated', runtime: 'ollama', model: 'qwen3.5:9b', url: ollama.url, enabled: true, localConfirmed: { port, at: 1 } }] } });
  assert.equal(storage.settings.enabled, true);

  assert.deepEqual(await service.request('canvastty.decide', decide('git status')), { verdict: 'allow', reason: 'CanvasTTY Assistant: a read-only command' });
  const sudo = await service.request('canvastty.decide', decide('sudo ls'));
  assert.equal(sudo.verdict, 'deny');
  const unclear = await service.request('canvastty.decide', decide('npm install left-pad'));
  assert.equal(unclear.verdict, 'ask');
  assert.ok(ollama.requests.some(r => r.path === '/api/chat'), 'the model was asked about the unclear command');

  // «Проверить»: the synthetic battery, answered as an event.
  assert.deepEqual(await service.request('check', { backendId: 'emulated-1' }), { running: true });
  const deadline = Date.now() + 10_000;
  while (!service.events.some(event => event.event === 'check') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const result = service.events.find(event => event.event === 'check').data;
  assert.equal(result.added, true, JSON.stringify(result.checks));
  assert.equal(result.modelLabel, 'qwen3.5:9b');
  const state = await service.request('state');
  assert.equal(state.checks['emulated-1'].added, true);
  assert.equal(state.status.backends[0].tested, true);
  assert.equal(state.recent.length, 3);

  // Tools and a launch through the same process.
  const caller = { id: 'orch-1', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: project, workingDirectory: project };
  const status = JSON.parse((await service.request('canvastty.tools.call', { tool: 'review_status', caller, input: {} })).content);
  assert.equal(status.commandReview, 'auto');
  assert.equal(await service.request('canvastty.launch.prepare', { sessionId: 's2', provider: 'claude', profile: 'yolo', role: 'agent', cwd: project, restoring: false, resume: false, options: {}, chosen: true, environment: null }), null);
});
