// The Assistant's settings page (bundled to settings/assistant.js). It runs in CanvasTTY's sandboxed plugin frame:
// settings go through the service (which validates and stores them), keys are written straight into the plugin's
// secrets and never read back — the page only learns whether one exists.
import type { AssistantBackendPreset, AssistantBackendSettings, AssistantBackendStatus, AssistantCheckResult, AssistantSettings } from '../shared/settings.ts';
import type { RecentReview } from '../review/reviewService.ts';

interface PluginHost {
  onContext(listener: (context: { appearance: { locale: 'ru' | 'en' } }) => void): void;
  secrets: { set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  service: {
    request(serviceId: string, method: string, params?: unknown): Promise<unknown>;
    onEvent(listener: (event: { serviceId: string; event: string; data: unknown }) => void): void;
  };
}
interface State {
  settings: AssistantSettings;
  status: { enabled: boolean; backends: AssistantBackendStatus[] };
  slots: Record<string, { secret: string; origin: string } | null>;
  checks: Record<string, AssistantCheckResult | { running: true } | { error: string }>;
  recent: RecentReview[];
}

const host = (window as unknown as { CanvasTTYPlugin: PluginHost }).CanvasTTYPlugin;
const SERVICE = 'assistant';

const STRINGS = {
  en: {
    title: 'Assistant', lead: 'Reviews agents\' commands and triages tasks with a small decision model: Jev (TypeSafe, OpenRouter, Vercel), Laya, an Eikos server, or a model on your Ollama. Off by default; while off nothing runs.',
    enabled: 'Assistant on', modes: 'Modes', review: 'Command review', triage: 'Task triage (launch and orchestrator)',
    off: 'Off', shadow: 'Learning', suggest: 'Suggest', auto: 'Auto',
    modeHelp: 'Learning records answers only. Suggest shows them on the card and enforces nothing. Auto may ask you or decline; it allows only what has qualified on your own answers, and only if CanvasTTY lets this plugin allow.',
    strictness: 'Review strictness', byTask: 'By the task (triage)', always: 'Always strict',
    data: 'Data', dataMode: 'Data check', strict: 'Strict', warn: 'Warn only', dataOff: 'Off',
    grant: 'What may leave this computer', grantOff: 'Only code facts (no text)', grantD1: 'Texts up to D1', grantD2: 'Texts up to D2',
    defaultClass: 'Class of card text', engine: 'Where it runs', engineAuto: 'Jev first, then this computer', engineJev: 'Jev only', engineLocal: 'This computer only',
    backends: 'Decision models', none: 'None yet.', add: 'Add', model: 'Model', url: 'Address', local: 'This server runs on this computer and sends nothing anywhere',
    check: 'Check', checking: 'Checking…', remove: 'Remove', enabledBackend: 'On', key: 'Key', keySet: 'key saved', keyNone: 'no key', saveKey: 'Save key', removeKey: 'Remove key',
    trust: 'I trust it with', where: { local: 'this computer', remote: 'leaves this computer' },
    checkOk: (r: AssistantCheckResult) => `OK: ${r.modelLabel ?? 'the model'} answered${r.latencyMs !== null ? ` in ${r.latencyMs} ms` : ''} (${r.requests} requests).`,
    checkFail: (r: AssistantCheckResult) => `Not usable: ${r.checks.filter(c => c.status === 'fail').map(c => c.detail).join(' ') || r.failure || 'the check failed'}`,
    smart: 'Second reviewer (larger local Ollama model)', smartNone: 'None', smartModel: 'Ollama model', smartAsk: 'While learning, also ask the second reviewer',
    recent: 'Recent reviews', noRecent: 'Nothing reviewed yet.', right: 'Right', wrong: 'Wrong',
    saved: 'Saved.', notSaved: 'Not saved: '
  },
  ru: {
    title: 'Помощник', lead: 'Проверяет команды агентов и разбирает задачи маленькой моделью решений: Jev (TypeSafe, OpenRouter, Vercel), Laya, сервер Eikos или модель в вашей Ollama. По умолчанию выключен; выключенный ничего не запускает.',
    enabled: 'Помощник включён', modes: 'Режимы', review: 'Проверка команд', triage: 'Разбор задачи (запуск и оркестратор)',
    off: 'Выкл', shadow: 'Обучение', suggest: 'Подсказки', auto: 'Авто',
    modeHelp: 'Обучение только записывает ответы. Подсказки показывают их на окне и ничего не решают. Авто может спросить вас или отказать; разрешает только то, что прошло проверку на ваших ответах, и только если CanvasTTY разрешил этому плагину разрешать.',
    strictness: 'Строгость проверки', byTask: 'По задаче (разбор)', always: 'Всегда строго',
    data: 'Данные', dataMode: 'Проверка данных', strict: 'Строго', warn: 'Только предупреждать', dataOff: 'Выкл',
    grant: 'Что может уйти с этого компьютера', grantOff: 'Только служебные признаки (без текста)', grantD1: 'Тексты до D1', grantD2: 'Тексты до D2',
    defaultClass: 'Класс текста окна', engine: 'Где работает', engineAuto: 'Сначала Jev, потом этот компьютер', engineJev: 'Только Jev', engineLocal: 'Только этот компьютер',
    backends: 'Модели решений', none: 'Пока нет.', add: 'Добавить', model: 'Модель', url: 'Адрес', local: 'Сервер работает на этом компьютере и никуда не отправляет данные',
    check: 'Проверить', checking: 'Проверяю…', remove: 'Удалить', enabledBackend: 'Вкл', key: 'Ключ', keySet: 'ключ сохранён', keyNone: 'нет ключа', saveKey: 'Сохранить ключ', removeKey: 'Удалить ключ',
    trust: 'Доверяю до', where: { local: 'этот компьютер', remote: 'уходит с компьютера' },
    checkOk: (r: AssistantCheckResult) => `Работает: ${r.modelLabel ?? 'модель'} ответила${r.latencyMs !== null ? ` за ${r.latencyMs} мс` : ''} (запросов: ${r.requests}).`,
    checkFail: (r: AssistantCheckResult) => `Не подходит: ${r.checks.filter(c => c.status === 'fail').map(c => c.detail).join(' ') || r.failure || 'проверка не прошла'}`,
    smart: 'Второй проверяющий (большая локальная модель Ollama)', smartNone: 'Нет', smartModel: 'Модель Ollama', smartAsk: 'Во время обучения тоже спрашивать второго проверяющего',
    recent: 'Последние проверки', noRecent: 'Пока ничего не проверялось.', right: 'Верно', wrong: 'Неверно',
    saved: 'Сохранено.', notSaved: 'Не сохранено: '
  }
};
type Strings = typeof STRINGS.en;
let t: Strings = STRINGS.en;
let state: State | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;

const PRESETS: Array<{ id: AssistantBackendPreset; label: string; keyed: boolean; url: string | null; model: string }> = [
  { id: 'emulated', label: 'Ollama', keyed: false, url: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' },
  { id: 'typesafe', label: 'Jev · TypeSafe', keyed: true, url: null, model: 'jev-1.13.0' },
  { id: 'openrouter', label: 'Jev · OpenRouter', keyed: true, url: null, model: 'typesafe/jev-1.13' },
  { id: 'vercel', label: 'Jev · Vercel', keyed: true, url: null, model: 'typesafe-ai/jev' },
  { id: 'laya', label: 'Laya', keyed: false, url: 'http://127.0.0.1:8000', model: 'typed-decisions' },
  { id: 'eikos', label: 'Eikos (serve.py)', keyed: false, url: 'http://127.0.0.1:8000', model: 'eikos' },
  { id: 'custom', label: 'System One server', keyed: false, url: 'https://', model: 'default' }
];

function say(message: string): void { status.textContent = message; }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function select<T extends string>(value: T, options: Array<[T, string]>, onChange: (value: T) => void, name: string): HTMLSelectElement {
  const node = el('select', { name });
  for (const [option, label] of options) node.append(el('option', { value: option, textContent: label, selected: option === value }));
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

function checkbox(checked: boolean, label: string, onChange: (checked: boolean) => void, name: string): HTMLLabelElement {
  const input = el('input', { type: 'checkbox', checked, name });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'check' }, input, ` ${label}`);
}

async function load(): Promise<void> {
  state = await host.service.request(SERVICE, 'state') as State;
  render();
}

/** Saves run one at a time, each on the settings the previous one left, so a quick second change keeps the first. */
let saving: Promise<void> = Promise.resolve();
function save(change: (settings: AssistantSettings) => void): Promise<void> {
  saving = saving.then(async () => {
    if (!state) return;
    const next = structuredClone(state.settings);
    change(next);
    try {
      await host.service.request(SERVICE, 'save', { settings: next });
      say(t.saved);
    } catch (error) {
      say(`${t.notSaved}${errorText(error)}`);
    }
    await load().catch(error => say(errorText(error)));
  });
  return saving;
}

function modeSelect(useCase: 'command.review' | 'task.route'): HTMLSelectElement {
  const modes: Array<['off' | 'shadow' | 'suggest' | 'auto', string]> = [['off', t.off], ['shadow', t.shadow], ['suggest', t.suggest], ['auto', t.auto]];
  return select(state!.settings.modes[useCase], modes, value => void save(s => { s.modes[useCase] = value; }), useCase);
}

function row(label: string, control: Node): HTMLDivElement { return el('div', { className: 'row' }, el('span', { className: 'label', textContent: label }), control); }

function backendRow(entry: AssistantBackendSettings): HTMLLIElement {
  const preset = PRESETS.find(item => item.id === entry.preset);
  const info = state!.status.backends.find(item => item.id === entry.id);
  const slot = state!.slots[entry.id] ?? null;
  const check = state!.checks[entry.id];
  const item = el('li', { className: 'backend', dataset: { backend: entry.id } });
  const head = el('div', { className: 'row' },
    el('strong', { textContent: `${preset?.label ?? entry.preset} · ${entry.model ?? ''}` }),
    el('span', { className: 'muted', textContent: `${entry.url ?? ''} — ${info ? t.where[info.target] : ''}` }));
  const controls = el('div', { className: 'row' });
  controls.append(checkbox(entry.enabled, t.enabledBackend, value => void save(s => { s.backends.find(b => b.id === entry.id)!.enabled = value; }), `enabled-${entry.id}`));
  if (info?.target === 'remote') {
    controls.append(el('span', { className: 'label', textContent: t.trust }), select(entry.trust ?? 'D0', [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2']], value => void save(s => { s.backends.find(b => b.id === entry.id)!.trust = value; }), `trust-${entry.id}`));
  }
  const checkButton = el('button', { type: 'button', textContent: t.check, name: `check-${entry.id}` });
  checkButton.addEventListener('click', () => {
    say(t.checking);
    host.service.request(SERVICE, 'check', { backendId: entry.id }).then(() => load(), error => say(errorText(error)));
  });
  const removeButton = el('button', { type: 'button', textContent: t.remove });
  removeButton.addEventListener('click', () => void save(s => { s.backends = s.backends.filter(b => b.id !== entry.id); }));
  controls.append(checkButton, removeButton);
  item.append(head, controls);
  if (slot) {
    // Write-only: the value goes into the plugin's secrets bound to this address and is never read back here.
    const input = el('input', { type: 'password', placeholder: t.key, autocomplete: 'off', name: `key-${entry.id}` });
    const saveKey = el('button', { type: 'button', textContent: t.saveKey });
    saveKey.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      // The field is cleared only once the key is stored: a failed write keeps what the person pasted.
      let stored = false;
      try {
        await host.secrets.set(slot.secret, JSON.stringify({ origin: slot.origin, value }));
        stored = true; input.value = '';
        await host.service.request(SERVICE, 'keyChanged', { backendId: entry.id });
        say(t.saved);
      } catch (error) { say(`${t.notSaved}${errorText(error)}`); }
      if (stored) await load();
    });
    const removeKey = el('button', { type: 'button', textContent: t.removeKey });
    removeKey.addEventListener('click', async () => {
      try {
        await host.secrets.delete(slot.secret);
        await host.service.request(SERVICE, 'keyChanged', { backendId: entry.id });
      } catch (error) { say(errorText(error)); }
      await load();
    });
    item.append(el('div', { className: 'row' }, el('span', { className: 'muted', textContent: info?.keyConfigured ? t.keySet : t.keyNone }), input, saveKey, removeKey));
  }
  if (check) {
    const line = 'running' in check ? t.checking : 'error' in check ? check.error : check.added ? t.checkOk(check) : t.checkFail(check);
    item.append(el('div', { className: 'check-result', textContent: line, dataset: { result: entry.id } }));
  }
  return item;
}

function addForm(): HTMLDivElement {
  const form = el('div', { className: 'add' });
  const presetSelect = el('select', { name: 'preset' });
  for (const preset of PRESETS) presetSelect.append(el('option', { value: preset.id, textContent: preset.label }));
  const model = el('input', { name: 'model', placeholder: t.model, value: PRESETS[0]!.model });
  const url = el('input', { name: 'url', placeholder: t.url, value: PRESETS[0]!.url ?? '' });
  const localInput = el('input', { type: 'checkbox', name: 'local', checked: true });
  const local = el('label', { className: 'check' }, localInput, ` ${t.local}`);
  const sync = (): void => {
    const preset = PRESETS.find(item => item.id === presetSelect.value)!;
    model.value = preset.model;
    url.value = preset.url ?? '';
    url.disabled = preset.url === null;
    local.hidden = preset.url === null;
    localInput.checked = !!preset.url && /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)/u.test(preset.url);
  };
  presetSelect.addEventListener('change', sync);
  const add = el('button', { type: 'button', textContent: t.add, name: 'add' });
  add.addEventListener('click', () => {
    const preset = PRESETS.find(item => item.id === presetSelect.value)!;
    const taken = new Set(state!.settings.backends.map(b => b.id));
    let n = 1;
    while (taken.has(`${preset.id}-${n}`)) n++;
    const entry: AssistantBackendSettings = { id: `${preset.id}-${n}`, preset: preset.id, enabled: true, model: model.value.trim() };
    if (preset.id === 'emulated') entry.runtime = 'ollama';
    if (preset.url !== null) entry.url = url.value.trim();
    if (preset.url !== null && localInput.checked) {
      try {
        const parsed = new URL(entry.url!);
        entry.localConfirmed = { port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), at: Date.now() };
      } catch { /* the service refuses the address */ }
    }
    void save(s => { s.backends.push(entry); });
  });
  form.append(presetSelect, model, url, add, local);
  return form;
}

function smartSection(): HTMLDivElement {
  const smart = state!.settings.smart;
  const model = el('input', { name: 'smart-model', placeholder: t.smartModel, value: smart.kind === 'ollama-chat' ? smart.model : '' });
  const saveSmart = el('button', { type: 'button', textContent: t.add, name: 'smart-save' });
  saveSmart.addEventListener('click', () => void save(s => {
    s.smart = model.value.trim() ? { kind: 'ollama-chat', url: 'http://127.0.0.1:11434', model: model.value.trim() } : { kind: 'none' };
  }));
  return el('div', {},
    row(t.smart, el('span', {}, model, saveSmart)),
    checkbox(state!.settings.shadowAsksSmart, t.smartAsk, value => void save(s => { s.shadowAsksSmart = value; }), 'shadow-asks-smart'));
}

function recentSection(): HTMLUListElement {
  const list = el('ul', { className: 'recent' });
  if (!state!.recent.length) list.append(el('li', { className: 'muted', textContent: t.noRecent }));
  for (const entry of state!.recent.slice(0, 20)) {
    const item = el('li', {}, el('code', { textContent: entry.summary }), ` → ${entry.act ?? '—'} (${entry.outcome}, ${entry.tier ?? '—'}, ${entry.reason}) `);
    if (entry.auditId && entry.tier !== 'rule' && !entry.label) {
      for (const verdict of ['right', 'wrong'] as const) {
        const button = el('button', { type: 'button', textContent: t[verdict] });
        button.addEventListener('click', async () => { await host.service.request(SERVICE, 'feedback', { auditId: entry.auditId, verdict }); await load(); });
        item.append(button);
      }
    } else if (entry.label) item.append(el('span', { className: 'muted', textContent: t[entry.label] }));
    list.append(item);
  }
  return list;
}

function render(): void {
  if (!state) return;
  const s = state.settings;
  const backends = el('ul', { className: 'backends' });
  if (!s.backends.length) backends.append(el('li', { className: 'muted', textContent: t.none }));
  for (const entry of s.backends) backends.append(backendRow(entry));
  root.replaceChildren(
    el('h1', { textContent: t.title }),
    el('p', { className: 'muted', textContent: t.lead }),
    checkbox(s.enabled, t.enabled, value => void save(next => { next.enabled = value; }), 'enabled'),
    el('h2', { textContent: t.modes }),
    row(t.review, modeSelect('command.review')),
    row(t.triage, modeSelect('task.route')),
    el('p', { className: 'muted', textContent: t.modeHelp }),
    row(t.strictness, select(s.reviewStrictness, [['triage', t.byTask], ['strict', t.always]], value => void save(next => { next.reviewStrictness = value; }), 'strictness')),
    el('h2', { textContent: t.backends }),
    backends,
    addForm(),
    smartSection(),
    el('h2', { textContent: t.data }),
    row(t.engine, select(s.engine, [['auto', t.engineAuto], ['jev', t.engineJev], ['local', t.engineLocal]], value => void save(next => { next.engine = value; }), 'engine')),
    row(t.dataMode, select(s.dataClassMode, [['strict', t.strict], ['warn', t.warn], ['off', t.dataOff]], value => void save(next => { next.dataClassMode = value; }), 'data-mode')),
    row(t.grant, select(s.grant, [['off', t.grantOff], ['D1', t.grantD1], ['D2', t.grantD2]], value => void save(next => { next.grant = value; }), 'grant')),
    row(t.defaultClass, select(s.defaultDataClass, [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2'], ['D3', 'D3']], value => void save(next => { next.defaultDataClass = value; }), 'default-class')),
    el('h2', { textContent: t.recent }),
    recentSection()
  );
}

host.onContext(({ appearance }) => {
  t = appearance.locale === 'ru' ? STRINGS.ru : STRINGS.en;
  document.documentElement.lang = appearance.locale;
  render();
});
host.service.onEvent(({ serviceId, event, data }) => {
  if (serviceId !== SERVICE || event !== 'check') return;
  const result = data as AssistantCheckResult | { error: string };
  say('error' in result ? result.error : result.added ? t.checkOk(result) : t.checkFail(result));
  void load();
});
load().catch(error => say(errorText(error)));
