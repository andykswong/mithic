/**
 * Browser tests for IframeRuntime (Group G.2).
 *
 * These tests run in real Chromium via Playwright/Vitest browser mode.
 *
 * Guest-import strategy: the iframe runs in an opaque origin (no allow-same-origin),
 * so it cannot use import maps or reach the Vite dev server. We therefore pass guest
 * logic as self-contained inline code strings. The bootstrap inside the srcdoc turns
 * that string into a Blob URL module (or falls back to indirect eval), so `import`
 * from @mithic/guest-runtime is NOT needed inside the guest string — we reconstruct
 * the minimal createGuest logic inline.
 */
import { expect, test } from 'vitest';
import { IframeRuntime } from './iframe.ts';

// Minimal inline createGuest re-implementation for use inside iframe guest code.
// This avoids any dependency on @mithic/guest-runtime inside the opaque-origin iframe.
const INLINE_GUEST_PRELUDE = /* js */`
function createGuest({ control, init, preopenPorts = {} }) {
  const signalListeners = [];
  const responseListeners = [];
  control.start?.();
  control.onmessage = (e) => {
    const msg = e.data;
    if (msg && typeof msg === 'object' && 'event' in msg) {
      if (msg.event === 'signal') {
        const p = msg.payload || {};
        for (const cb of signalListeners) cb(p.signal || '', p.extra);
      }
    } else {
      for (const cb of responseListeners) cb(msg);
    }
  };
  const transport = {
    send(m, t) { control.postMessage(m, t || []); },
    onMessage(cb) { responseListeners.push(cb); },
    close() { control.close(); },
  };
  // Minimal SyscallClient
  let nextId = 1;
  const pending = new Map();
  transport.onMessage((msg) => {
    if (msg && typeof msg === 'object' && 'id' in msg && 'ok' in msg) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message || 'syscall error'), { code: msg.error?.code }));
    }
  });
  function syscall(call, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport.send({ id, call, args });
    });
  }
  // Build stdout writable from preopen port
  const stdoutPort = preopenPorts[1];
  let stdoutWriter = null;
  if (stdoutPort) {
    stdoutPort.start?.();
    // Grant credit upfront
    stdoutPort.postMessage({ type: 'credit', bytes: 1 << 20 });
  }
  return {
    pid: init.pid,
    args: init.args,
    env: init.env,
    cwd: init.cwd,
    syscall,
    onSignal(cb) { signalListeners.push(cb); },
    exit(code) {
      control.postMessage({ type: 'exit', code });
      for (const { reject } of pending.values()) reject(Object.assign(new Error('transport closed'), { code: 'EPIPE' }));
      pending.clear();
      control.close();
    },
    writeStdout(bytes) {
      if (!stdoutPort) return;
      stdoutPort.postMessage({ type: 'data', chunk: bytes });
    },
    closeStdout() {
      if (!stdoutPort) return;
      stdoutPort.postMessage({ type: 'end' });
    },
  };
}
`;

test('IframeRuntime: syscall round-trip — guest posts request, runtime delivers response', async () => {
  const rt = new IframeRuntime();

  // Guest code posts a synthetic syscall request back to the host via window.parent.postMessage.
  // The IframeRuntime's window.onmessage listener picks it up and routes it to onMessage callbacks.
  const code = /* js */`
    export default async (_boot) => {
      window.parent.postMessage({ id: 1, call: 'process/getpid', args: {} }, '*');
    };
  `;

  const init = {
    type: 'init' as const,
    entry: 'inline' as const,
    args: ['prog'],
    env: {},
    cwd: '/',
    pid: 1,
    ppid: 0,
    capabilities: [],
  };

  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init });
  rt.onMessage(handle, (m) => received.push(m));

  await new Promise<void>((r) => setTimeout(r, 500));

  expect(received).toContainEqual({ id: 1, call: 'process/getpid', args: {} });

  rt.dispose(handle);
}, 10000);

test('IframeRuntime: opaque origin — guest cannot reach parent localStorage or DOM', async () => {
  const rt = new IframeRuntime();

  // Guest tries to access window.parent.document — should throw due to opaque origin sandboxing.
  // We detect this by having the guest report success/failure via postMessage.
  const code = /* js */`
    export default async (_boot) => {
      let opaque = false;
      try {
        // In a sandboxed iframe without allow-same-origin, accessing parent.document throws
        const _ = window.parent.document.title;
        opaque = false;
      } catch (_e) {
        opaque = true;
      }
      window.parent.postMessage({ id: 99, call: 'opaque-check', args: { opaque } }, '*');
    };
  `;

  const init = {
    type: 'init' as const,
    entry: 'inline' as const,
    args: [],
    env: {},
    cwd: '/',
    pid: 2,
    ppid: 0,
    capabilities: [],
  };

  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init });
  rt.onMessage(handle, (m) => received.push(m));

  await new Promise<void>((r) => setTimeout(r, 1000));

  // The guest should have reported opaque: true
  const opaqueMsg = received.find(
    (m) => m != null && typeof m === 'object' && (m as { call?: string }).call === 'opaque-check',
  ) as { args: { opaque: boolean } } | undefined;

  expect(opaqueMsg).toBeDefined();
  expect(opaqueMsg?.args.opaque).toBe(true);

  rt.dispose(handle);
}, 10000);

test('IframeRuntime: boot handshake delivers control + preopenPorts to guest', async () => {
  const rt = new IframeRuntime();

  // Create a control channel to pass to the guest
  const { port1: kernelControl, port2: guestControl } = new MessageChannel();

  const code = INLINE_GUEST_PRELUDE + `
    export default async (boot) => {
      window.parent.postMessage({
        id: 7,
        call: 'boot-check',
        args: {
          hasControl: boot != null && 'control' in boot,
          hasInit: boot != null && 'init' in boot,
          hasPreopenPorts: boot != null && 'preopenPorts' in boot,
          pid: boot != null ? boot.init.pid : -1,
        }
      }, '*');
    };
  `;

  const init = {
    type: 'init' as const,
    entry: 'inline' as const,
    args: [],
    env: {},
    cwd: '/',
    pid: 42,
    ppid: 0,
    capabilities: [],
  };

  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init,
    transfer: [guestControl],
  });
  rt.onMessage(handle, (m) => received.push(m));

  await new Promise<void>((r) => setTimeout(r, 1000));

  expect(received).toContainEqual({
    id: 7,
    call: 'boot-check',
    args: { hasControl: true, hasInit: true, hasPreopenPorts: true, pid: 42 },
  });

  rt.dispose(handle);
  kernelControl.close();
}, 10000);

test('IframeRuntime: isAlive returns true then false after dispose', async () => {
  const rt = new IframeRuntime();

  const code = 'export default async (_boot) => {};';
  const init = {
    type: 'init' as const,
    entry: 'inline' as const,
    args: [],
    env: {},
    cwd: '/',
    pid: 5,
    ppid: 0,
    capabilities: [],
  };

  const handle = await rt.spawn(code, { init });
  expect(rt.isAlive(handle)).toBe(true);
  rt.dispose(handle);
  expect(rt.isAlive(handle)).toBe(false);
}, 10000);

test('IframeRuntime: postMessage delivers message to guest recv hook', async () => {
  const rt = new IframeRuntime();

  // Guest installs __isola_recv and echoes messages back via parent.postMessage
  const code = /* js */`
    export default async (_boot) => {
      globalThis.__isola_recv = (msg) => {
        window.parent.postMessage({ id: 50, call: 'echo', args: { got: msg } }, '*');
      };
    };
  `;

  const init = {
    type: 'init' as const,
    entry: 'inline' as const,
    args: [],
    env: {},
    cwd: '/',
    pid: 6,
    ppid: 0,
    capabilities: [],
  };

  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init });
  rt.onMessage(handle, (m) => received.push(m));

  // Wait for guest to install __isola_recv
  await new Promise<void>((r) => setTimeout(r, 300));

  rt.postMessage(handle, { id: 42, ok: true, result: 'ping' });

  await new Promise<void>((r) => setTimeout(r, 500));

  expect(received).toContainEqual({ id: 50, call: 'echo', args: { got: { id: 42, ok: true, result: 'ping' } } });

  rt.dispose(handle);
}, 10000);
