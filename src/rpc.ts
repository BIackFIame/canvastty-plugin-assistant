// The CanvasTTY service protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout (same as canvastty-environments).
// The host sends canvastty.initialize first, then requests; the service may call the host back (storage, secrets…).
import { createInterface } from 'node:readline';

export interface Host {
  callHost(method: string, params?: unknown): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', message: unknown): void;
  /** A notification to this plugin's own surfaces (host.service.onEvent). */
  emit(event: string, data: unknown): void;
}
type Handler = (params: Record<string, unknown>, host: Host) => unknown;

export interface ServeOptions {
  methods: Record<string, Handler>;
  notifications?: Record<string, Handler>;
  onInitialize?: (params: Record<string, unknown>, host: Host) => unknown;
}

export function serve({ methods, notifications = {}, onInitialize }: ServeOptions): void {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  const send = (message: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
  const host: Host = {
    callHost: (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    }),
    log: (level, message) => send({ method: 'log', params: { level, message: String(message).slice(0, 500) } }),
    emit: (event, data) => send({ method: 'event', params: { event, data } })
  };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

  createInterface({ input: process.stdin }).on('line', line => {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    const method = message.method;
    if (method === 'canvastty.initialize') {
      Promise.resolve().then(() => onInitialize?.(record(message.params), host))
        .catch((error: unknown) => host.log('error', `initialize failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (method === 'canvastty.shutdown') process.exit(0);
    if (typeof method === 'string' && message.id === undefined) {
      Promise.resolve().then(() => notifications[method]?.(record(message.params), host))
        .catch((error: unknown) => host.log('warn', `${method}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (typeof method === 'string') {
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
      Promise.resolve().then(() => {
        if (!handler) throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
        return handler(record(message.params), host);
      }).then(
        result => send({ id: message.id, result: result ?? null }),
        (error: unknown) => send({ id: message.id, error: { code: (error as { code?: number })?.code ?? -32000, message: String(error instanceof Error ? error.message : error).slice(0, 400) } })
      );
      return;
    }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    const error = record(message.error);
    if (message.error) waiter.reject(new Error(typeof error.message === 'string' ? error.message : 'Host request failed.'));
    else waiter.resolve(message.result);
  }).on('close', () => process.exit(0));
}
