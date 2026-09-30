// The CanvasTTY service protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout (same as canvastty-environments).
// The host sends canvastty.initialize first, then requests; the service may call the host back (storage, secrets…).
// The transport is bounded both ways: a frame above the frame limit is skipped without being held, host calls have a
// deadline and an in-flight cap, requests beyond the handler cap are answered busy, and on shutdown or end of input
// the handlers still running get a short drain to answer before the process exits. Output is bounded too: a frame
// above the frame limit is never written (an answer becomes an error, a host call fails, an event is dropped), and
// while the host is not reading (write() returned false) frames wait in order for 'drain', with the waiting events
// and logs capped at outboundBytes by dropping the oldest of them; answers and host calls are never dropped.

export interface Host {
  callHost(method: string, params?: unknown): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', message: unknown): void;
  /** A notification to this plugin's own surfaces (host.service.onEvent). */
  emit(event: string, data: unknown): void;
}
type Handler = (params: Record<string, unknown>, host: Host) => unknown;

export const RPC_LIMITS = Object.freeze({
  /** CanvasTTY caps service frames at 1 MiB in both directions. */
  frameBytes: 1_048_576,
  hostCallMs: 30_000,
  hostCalls: 64,
  activeHandlers: 64,
  /** CanvasTTY waits 2 s after canvastty.shutdown before SIGTERM. */
  drainMs: 1_500,
  /** Events and logs held while the host is not reading, at most. */
  outboundBytes: 8 * 1_048_576
});

export interface ServeOptions {
  methods: Record<string, Handler>;
  notifications?: Record<string, Handler>;
  onInitialize?: (params: Record<string, unknown>, host: Host) => unknown;
  /** For tests: the streams, the exit and smaller limits. */
  input?: NodeJS.ReadableStream;
  output?: { write(text: string): unknown; once?(event: 'drain', listener: () => void): unknown };
  exit?: (code: number) => void;
  limits?: Partial<typeof RPC_LIMITS>;
}

export function serve({ methods, notifications = {}, onInitialize, input = process.stdin, output = process.stdout, exit = code => process.exit(code), limits = {} }: ServeOptions): void {
  const limit = { ...RPC_LIMITS, ...limits };
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let active = 0;
  let stopping = false;
  let hostGone = false;
  let onIdle: (() => void) | null = null;
  // Frames waiting for 'drain', in order; `droppable` ones (events, logs) count against outboundBytes.
  const queue: { text: string; bytes: number; droppable: boolean }[] = [];
  let held = 0;
  let blocked = false;
  let dropped = 0;
  let onFlushed: (() => void) | null = null;
  const write = (text: string): void => {
    if (output.write(text) === false && typeof output.once === 'function') { blocked = true; output.once('drain', flush); }
  };
  function flush(): void {
    blocked = false;
    while (queue.length && !blocked) {
      const frame = queue.shift()!;
      if (frame.droppable) held -= frame.bytes;
      write(frame.text);
    }
    if (blocked) return;
    if (dropped) {
      const count = dropped;
      dropped = 0;
      send({ method: 'log', params: { level: 'warn', message: `Dropped ${count} events or logs while the host was not reading.` } }, true);
    }
    if (!blocked && !queue.length) onFlushed?.();
  }
  /** Writes one frame, or holds it while the host is not reading; false when it is larger than the frame limit. */
  const send = (message: Record<string, unknown>, droppable = false): boolean => {
    const text = `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
    const bytes = Buffer.byteLength(text);
    // A log is cut to 500 characters, so only answers, host calls and events can outgrow a frame.
    if (bytes > limit.frameBytes && message.method !== 'log') return false;
    if (!blocked) { write(text); return true; }
    if (droppable) {
      for (let at = 0; held + bytes > limit.outboundBytes && at < queue.length;) {
        const frame = queue[at]!;
        if (!frame.droppable) { at++; continue; }
        held -= frame.bytes;
        queue.splice(at, 1);
        dropped++;
      }
      if (held + bytes > limit.outboundBytes) { dropped++; return true; }
      held += bytes;
    }
    queue.push({ text, bytes, droppable });
    return true;
  };
  const host: Host = {
    callHost: (method, params) => new Promise((resolve, reject) => {
      if (hostGone) { reject(new Error('The host connection is closed.')); return; }
      if (pending.size >= limit.hostCalls) { reject(new Error('Too many host calls in flight.')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The host did not answer ${method} in time.`)); }, limit.hostCallMs);
      pending.set(id, { resolve, reject, timer });
      if (!send({ id, method, params })) {
        clearTimeout(timer); pending.delete(id);
        reject(new Error(`The ${method} request is larger than the frame limit.`));
      }
    }),
    log: (level, message) => { send({ method: 'log', params: { level, message: String(message).slice(0, 500) } }, true); },
    emit: (event, data) => {
      if (!send({ method: 'event', params: { event, data } }, true)) host.log('warn', `Dropped a ${String(event).slice(0, 80)} event larger than the frame limit.`);
    }
  };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
  /** Runs a handler, counted as active until it settles. */
  const track = (run: () => unknown): Promise<unknown> => {
    active++;
    return Promise.resolve().then(run).finally(() => { active--; if (active === 0) onIdle?.(); });
  };
  /** Takes no new work, lets the running handlers answer (bounded), then exits. */
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    let exited = false;
    const finish = (): void => { if (exited) return; exited = true; clearTimeout(timer); exit(0); };
    const timer = setTimeout(finish, limit.drainMs);
    // Exits once the answers written so far have left too (still bounded by the drain timer).
    onIdle = () => { if (blocked || queue.length) onFlushed = finish; else finish(); };
    if (active === 0) onIdle();
  };

  const handle = (line: string): void => {
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    const method = message.method;
    if (method === 'canvastty.initialize') {
      Promise.resolve().then(() => onInitialize?.(record(message.params), host))
        .catch((error: unknown) => host.log('error', `initialize failed: ${errorText(error)}`));
      return;
    }
    if (method === 'canvastty.shutdown') { stop(); return; }
    if (typeof method === 'string' && message.id === undefined) {
      if (stopping) return;
      if (active >= limit.activeHandlers) { host.log('warn', `${method}: dropped, the service is busy`); return; }
      const handler = Object.hasOwn(notifications, method) ? notifications[method] : undefined;
      track(() => handler?.(record(message.params), host))
        .catch((error: unknown) => host.log('warn', `${method}: ${errorText(error)}`));
      return;
    }
    if (typeof method === 'string') {
      if (stopping || active >= limit.activeHandlers) {
        send({ id: message.id, error: { code: -32000, message: stopping ? 'The service is stopping.' : 'The service is busy; try again.' } });
        return;
      }
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
      track(() => {
        if (!handler) throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
        return handler(record(message.params), host);
      }).then(
        result => {
          if (!send({ id: message.id, result: result ?? null })) send({ id: message.id, error: { code: -32000, message: 'The answer is larger than the frame limit.' } });
        },
        (error: unknown) => send({ id: message.id, error: { code: (error as { code?: number })?.code ?? -32000, message: errorText(error).slice(0, 400) } })
      );
      return;
    }
    const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    clearTimeout(waiter.timer);
    const error = record(message.error);
    if (message.error) waiter.reject(new Error(typeof error.message === 'string' ? error.message : 'Host request failed.'));
    else waiter.resolve(message.result);
  };

  // Lines are cut from raw bytes: a frame is kept as chunks and joined once at its newline; one that grows past the
  // limit is dropped up to its newline without being held.
  let chunks: Buffer[] = [];
  let size = 0;
  let skipping = false;
  const drop = (): void => { if (!skipping) host.log('warn', 'Dropped a host message larger than the frame limit.'); chunks = []; size = 0; };
  input.on('data', (data: Buffer | string) => {
    let chunk = typeof data === 'string' ? Buffer.from(data) : data;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10)) {
      const part = chunk.subarray(0, newline);
      chunk = chunk.subarray(newline + 1);
      if (skipping || size + part.length > limit.frameBytes) { drop(); skipping = false; continue; }
      const line = (chunks.length ? Buffer.concat([...chunks, part]) : part).toString('utf8');
      chunks = []; size = 0;
      handle(line);
    }
    if (!chunk.length || skipping) return;
    if (size + chunk.length > limit.frameBytes) { drop(); skipping = true; return; }
    // A chunk can be a view into a larger pooled buffer; keep a copy of just this part.
    chunks.push(Buffer.from(chunk)); size += chunk.length;
  });
  const closed = (): void => {
    if (hostGone) return;
    hostGone = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('The host connection closed.')); }
    pending.clear();
    stop();
  };
  input.on('end', closed);
  input.on('error', closed);
}
