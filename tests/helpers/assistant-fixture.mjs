// Shared set-up for the assistant tests: an engine over fake System One servers, a fake key store and plain
// settings. Nothing leaves this computer: cloud routes are sent to the fakes on 127.0.0.1.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantEngine } from '../../src/engine/AssistantEngine.ts';
import { DEFAULT_ASSISTANT_SETTINGS } from '../../src/shared/settings.ts';
import { startFakeSystemOne } from './fake-systemone.mjs';

export function fakeSecrets(keys = {}) {
  const store = { ...keys };
  const generations = {};
  const calls = [];
  return {
    calls,
    store,
    async statusFor(owner) { return { configured: owner in store, origin: null }; },
    async getBound(owner, origin) { calls.push(owner); return owner in store ? { value: store[owner], origin } : null; },
    async setFor(owner, value) { store[owner] = value; generations[owner] = (generations[owner] ?? 0) + 1; },
    async removeFor(owner) { delete store[owner]; generations[owner] = (generations[owner] ?? 0) + 1; },
    generationFor(owner) { return generations[owner] ?? 0; }
  };
}

/** Sends the fixed cloud routes (TypeSafe, OpenRouter, Vercel) to `fake`; everything else goes where it was addressed. */
export function cloudTo(fake) {
  return (target, init) => {
    const url = new URL(String(target));
    if (/typesafe\.ai$|openrouter\.ai$|vercel\.sh$/u.test(url.hostname)) return fetch(`${fake.url}${url.pathname}`, init);
    return fetch(target, init);
  };
}

/** The plugin's settings (the chain kept them in the app settings; `rest` still sets e.g. `dataClassMode`). */
export function appSettings(assistant = {}, rest = {}) {
  return { ...structuredClone(DEFAULT_ASSISTANT_SETTINGS), enabled: true, grant: 'D2', backends: [{ id: 'jev', preset: 'typesafe', enabled: true }], ...assistant, ...rest };
}

export async function engineWith({ assistant = {}, settings: rest = {}, fake: fakeOptions = {}, keys = { 'decision-jev': 'k-good' }, now } = {}) {
  const fake = await startFakeSystemOne({ mode: 'typesafe', ...fakeOptions });
  const directory = await mkdtemp(join(tmpdir(), 'canvastty-assistant-'));
  const settings = appSettings(assistant, rest);
  const secrets = fakeSecrets(keys);
  const engine = new AssistantEngine({ settings: () => settings, directory, secrets, transport: cloudTo(fake), ...(now ? { now } : {}) });
  return {
    fake, directory, settings, secrets, engine,
    posts: () => fake.requests.filter(request => request.method === 'POST'),
    async close() { engine.dispose(); await fake.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

export const ctx = (extra = {}) => ({ signal: new AbortController().signal, assertCurrent() {}, requester: 'person', ...extra });

export const routeRequest = (task, dataClass = 'D2', extra = {}) => ({
  useCase: 'task.route', set: 'task.route', fields: [{ name: 'task', value: task, dataClass, disclosure: 'content', bound: 2000 }], ...extra
});

export const reviewRequest = (command, dataClass = 'D2', extra = {}) => ({
  useCase: 'command.review', set: 'command.review', actionClass: 'build_test', summary: 'Bash · npm test (build_test)',
  fields: [
    { name: 'person_request', value: 'Run the unit tests and fix what fails', dataClass, disclosure: 'content', bound: 1500 },
    { name: 'action.tool', value: 'Bash', dataClass: 'D0', disclosure: 'metadata' },
    { name: 'action.command', value: command, dataClass, disclosure: 'content', bound: 2000 },
    { name: 'action.shape', value: { program: 'npm', subcommand: 'test', flags: [] }, dataClass: 'D0', disclosure: 'metadata' },
    { name: 'facts', value: { stays_inside_project: 'yes', network_access: 'none', deletes_files: 'no' }, dataClass: 'D0', disclosure: 'metadata' }
  ],
  ...extra
});
