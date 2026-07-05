import { test, expect } from 'vitest';
import { WorkerRuntime } from './worker.ts';

function baseInit(pid: number) {
  return { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid, ppid: 0, capabilities: [] };
}

// The primary guard (§3.5): the PRODUCTION defaultWorkerFactory must build the worker from a
// `data:` URL, never a host-page `blob:`. A `data:` worker becomes null-origin automatically once
// Chrome 150 (kDataUrlWorkerOpaqueOrigin) ships, whereas a host-page `blob:` worker inherits the
// host origin forever. We route through the REAL factory (no injected factory) and stub
// globalThis.Worker to capture the exact URL the production code constructs — so this fails if the
// factory is reverted to blob: (URL.createObjectURL is available in-browser → blob: URL).
test('the production defaultWorkerFactory spawns from a data: URL, never a host-page blob: (opaque-origin mechanism, §3.5)', async () => {
  const realWorker = globalThis.Worker;
  let seenUrl = '';
  class CaptureWorker {
    onmessage: unknown = null;
    constructor(url: string | URL) { seenUrl = String(url); }
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  (globalThis as unknown as { Worker: unknown }).Worker = CaptureWorker;
  try {
    const rt = new WorkerRuntime(); // NO injected factory → exercises the real defaultWorkerFactory
    const handle = await rt.spawn('globalThis.__mithic_default = () => {};', { init: baseInit(1) });
    rt.dispose(handle);
  } finally {
    (globalThis as unknown as { Worker: unknown }).Worker = realWorker;
  }
  expect(seenUrl.startsWith('data:text/javascript,')).toBe(true);
  expect(seenUrl.startsWith('blob:')).toBe(false);
}, 10000);

test('data: Worker origin: opaque(null) when kDataUrlWorkerOpaqueOrigin is active, else host-origin (transitional, §3.5)', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  // The guest reports self.origin AND a concrete host-origin isolation probe: whether opening the
  // host page's IndexedDB is DENIED. In an opaque origin (Chrome 150+, kDataUrlWorkerOpaqueOrigin)
  // indexedDB.open() throws SecurityError synchronously; in the current same-origin worker it
  // succeeds. localStorage is not exposed to Workers at all, so IndexedDB is the usable signal.
  // The probe deletes any DB it creates so the test is side-effect-free today.
  const code = /* js */`
    globalThis.__mithic_default = (boot) => {
      let idbDenied = false;
      try {
        const req = indexedDB.open('__mithic_host_probe__');
        req.onsuccess = () => { try { req.result.close(); indexedDB.deleteDatabase('__mithic_host_probe__'); } catch (_e) {} };
        req.onerror = () => {};
      } catch (_e) {
        idbDenied = true;
      }
      boot.control.postMessage({ id: 1, call: 'origin-check', args: { origin: self.origin, idbDenied } });
    };
  `;
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const handle = await rt.spawn(code, { init: baseInit(2), transfer: [ch.port2] });
  await new Promise<void>((r) => setTimeout(r, 500));
  const msg = received.find((m) => (m as { call?: string })?.call === 'origin-check') as { args: { origin: string; idbDenied: boolean } } | undefined;
  expect(msg).toBeDefined();
  const hostOrigin = window.location.origin;
  // Two regimes: Chrome 150+ (kDataUrlWorkerOpaqueOrigin) → 'null'; pre-150 → inherits host origin.
  // Non-vacuous: fails if the worker reports any OTHER origin (an unexpected third value).
  expect(msg!.args.origin === 'null' || msg!.args.origin === hostOrigin).toBe(true);
  if (msg!.args.origin === 'null') {
    // Opaque-origin regime (Chrome 150+): host-origin IndexedDB must be unreachable. This branch
    // self-activates when the flag ships and asserts real inbound isolation; asserts nothing pre-150.
    expect(msg!.args.idbDenied).toBe(true);
  }
  rt.dispose(handle);
}, 10000);

// ACCEPTED RESIDUAL (spec §3.5a): a null-origin Worker still holds fetch/WebSocket/EventSource/
// sendBeacon and can spawn a nested worker with fresh network globals. This is NOT a bug fixed
// here — it is a regression-guard that the residual is UNDERSTOOD. The "network is only net/fetch"
// invariant holds on the IFRAME (connect-src 'none'), NOT the Worker. When worker-in-iframe lands
// (§3.5a / §11 / TODO G6-worker-outbound), FLIP these to block-assertions. Do NOT "fix" this by
// reverting to a same-origin/host-minted-blob: worker — that reintroduces the §3.5 inbound vuln.
test('DOCUMENTED residual: null-origin Worker retains network globals + can spawn a nested worker with fresh fetch (§3.5a)', async () => {
  const rt = new WorkerRuntime();
  const ch = new MessageChannel();
  // Prove the ACTUAL §3.5a residual: the guest doesn't just SEE a Worker symbol — it SPAWNS a
  // nested worker and confirms the child runs and has a fresh `fetch` (a real egress primitive).
  // Reports via a timeout fallback so the test never hangs if the child fails to run.
  const code = /* js */`
    globalThis.__mithic_default = (boot) => {
      let reported = false;
      const report = (args) => { if (!reported) { reported = true; boot.control.postMessage({ id: 3, call: 'residual', args }); } };
      const present = {
        fetch: typeof fetch === 'function',
        WebSocket: typeof WebSocket === 'function',
        Worker: typeof Worker === 'function',
      };
      try {
        const src = 'self.onmessage = () => self.postMessage(typeof fetch === "function");';
        const nested = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'classic' });
        nested.onmessage = (ev) => report({ ...present, nestedRan: true, nestedHasFetch: ev.data === true });
        nested.onerror = () => report({ ...present, nestedRan: false, nestedHasFetch: false });
        nested.postMessage('go');
        setTimeout(() => report({ ...present, nestedRan: false, nestedHasFetch: false }), 1500);
      } catch (_e) {
        report({ ...present, nestedRan: false, nestedHasFetch: false });
      }
    };
  `;
  const received: unknown[] = [];
  ch.port1.onmessage = (e) => received.push(e.data);
  ch.port1.start?.();
  const handle = await rt.spawn(code, { init: baseInit(4), transfer: [ch.port2] });
  await new Promise<void>((r) => setTimeout(r, 2500));
  const msg = received.find((m) => (m as { call?: string })?.call === 'residual') as { args: Record<string, boolean> } | undefined;
  expect(msg).toBeDefined();
  // These are TRUE today (accepted residual). This test EXISTS to make that explicit; flip to
  // block-assertions when worker-in-iframe lands (§3.5a / §11 / TODO G6-worker-outbound).
  expect(msg!.args.fetch).toBe(true);
  expect(msg!.args.Worker).toBe(true);
  expect(msg!.args.nestedRan).toBe(true);
  expect(msg!.args.nestedHasFetch).toBe(true);
  rt.dispose(handle);
}, 10000);
