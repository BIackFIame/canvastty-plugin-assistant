// Service entry (bundled to services/assistant.mjs): wires the Assistant to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { Assistant, type LaunchContext, type SessionSummary } from './assistant.ts';

// Requests that arrive while the service is still reading its settings wait for it (CanvasTTY's own timeout
// bounds the wait; a late decision is an "ask" there, never an allow).
let resolveReady: (assistant: Assistant) => void;
const ready = new Promise<Assistant>(resolve => { resolveReady = resolve; });
let assistant: Assistant | null = null;

serve({
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    const saved = await host.callHost('storage.get', { key: 'settings' }).catch(() => null);
    assistant = new Assistant({ host, dataDir, settings: saved });
    resolveReady(assistant);
    try {
      const answer = await host.callHost('sessions.subscribe', {}) as { sessions?: SessionSummary[] } | null;
      assistant.sessionsKnown(answer?.sessions);
    } catch (error) {
      host.log('warn', `sessions.subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  notifications: {
    'canvastty.sessions.event': params => { assistant?.sessionEvent(params); }
  },
  methods: {
    // Host-only requests.
    'canvastty.decide': async params => (await ready).decide(params),
    'canvastty.launch.prepare': async params => (await ready).launch(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await ready).tool(String(params.tool), params.caller as SessionSummary | undefined, (params.input ?? {}) as Record<string, unknown>),
    // The settings page.
    state: async () => (await ready).state(),
    save: async params => (await ready).save(params.settings),
    check: async params => (await ready).check(String(params.backendId)),
    keyChanged: async params => { (await ready).keyChanged(String(params.backendId)); return null; },
    feedback: async params => (await ready).review.feedback(String(params.auditId), params.verdict === 'right' ? 'right' : 'wrong')
  }
});
