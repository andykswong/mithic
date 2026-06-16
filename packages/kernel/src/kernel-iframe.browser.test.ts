/**
 * Kernel + IframeRuntime integration browser test (Group G.3).
 *
 * Same shape as kernel.test.ts (WorkerRuntime) but uses IframeRuntime as the
 * runtime backend, verifying the full end-to-end path in a real browser.
 *
 * Guest-import strategy:
 *   The iframe runs in an opaque origin (sandbox="allow-scripts" without allow-same-origin),
 *   so it cannot reach the Vite dev server or use import maps to resolve @mithic/guest-runtime.
 *   We therefore embed a minimal self-contained guest implementation inline in the code string.
 *   This is the same technique used in iframe.browser.test.ts.
 *
 *   The embedded guest implements:
 *     - createGuest(boot) → { exit, writeStdout, closeStdout }
 *     - portToWritable(port) — simplified, credit-based, matching @mithic/guest-runtime/streams
 *
 *   The Kernel.spawn() code string parameter contains this inline guest prelude
 *   followed by the actual guest logic that uses createGuest(boot).
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * Self-contained inline guest runtime for use inside the opaque-origin iframe.
 * Implements the minimum subset of @mithic/guest-runtime needed for the test:
 *   - createGuest({ control, init, preopenPorts })
 *   - portToWritable(port) with credit-based flow control
 */
const INLINE_GUEST_RUNTIME = /* js */`
// ---- inline portToWritable (mirrors @mithic/guest-runtime/streams) ----
function portToWritable(port) {
  port.start?.();
  let credit = 0;
  const creditWaiters = [];
  port.onmessage = (e) => {
    const msg = e.data;
    if (msg && msg.type === 'credit') {
      credit += msg.bytes;
      while (creditWaiters.length > 0 && credit >= creditWaiters[0].needed) {
        creditWaiters.shift().resolve();
      }
    }
  };
  let buf = [], bufSize = 0;
  async function flushNow() {
    const chunks = buf; buf = []; bufSize = 0;
    for (const chunk of chunks) {
      if (credit < chunk.byteLength) {
        await new Promise(resolve => creditWaiters.push({ needed: chunk.byteLength, resolve }));
      }
      credit -= chunk.byteLength;
      const transfer = chunk.byteLength >= 10240 ? [chunk.buffer] : [];
      port.postMessage({ type: 'data', chunk }, transfer);
    }
  }
  return new WritableStream({
    write(chunk) { buf.push(chunk); bufSize += chunk.byteLength; if (bufSize >= 16384) return flushNow(); return Promise.resolve(); },
    close() { return flushNow().then(() => { port.postMessage({ type: 'end' }); port.close(); }); },
    abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); },
  });
}

// ---- inline createGuest (mirrors @mithic/guest-runtime) ----
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
  let nextId = 1;
  const pending = new Map();
  transport.onMessage((msg) => {
    if (msg && typeof msg === 'object' && 'id' in msg && 'ok' in msg) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message || 'err'), { code: msg.error?.code }));
    }
  });
  function syscall(call, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); transport.send({ id, call, args }); });
  }
  const stdoutPort = preopenPorts[1];
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream();
  return {
    pid: init.pid,
    args: init.args,
    env: init.env,
    cwd: init.cwd,
    stdout,
    syscall,
    onSignal(cb) { signalListeners.push(cb); },
    exit(code) {
      control.postMessage({ type: 'exit', code });
      for (const { reject } of pending.values()) reject(Object.assign(new Error('transport closed'), { code: 'EPIPE' }));
      pending.clear();
      control.close();
    },
  };
}
`;

test('kernel + IframeRuntime: guest writes to stdout and exits 0', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

  // Guest code: inline runtime prelude + actual guest logic.
  // Kernel.spawn() passes this as a code string; the iframe bootstrap rewrites
  // 'export default' to a globalThis assignment and evals the result.
  const code = INLINE_GUEST_RUNTIME + `
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode('hello\\n'));
      await w.close();
      g.exit(0);
    };
  `;

  const { pid, stdout } = await kernel.spawn(code, {
    args: ['prog'],
    capabilities: [],
    captureStdout: true,
  });

  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);

  const bytes = await stdout!;
  expect(new TextDecoder().decode(bytes)).toContain('hello');
}, 20000);

test('kernel + IframeRuntime: capabilities are empty for guest spawned with no caps', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

  const code = INLINE_GUEST_RUNTIME + `
    export default async (boot) => {
      const g = createGuest(boot);
      // Just exit immediately
      g.exit(0);
    };
  `;

  const { pid } = await kernel.spawn(code, { args: [], capabilities: [] });
  const result = await kernel.wait(pid);
  expect(result.code).toBe(0);
}, 20000);
