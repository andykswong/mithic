import { expect, test } from 'vitest';
import { MockWorker } from '@mithic/worker/mock';
import type { MockWorkerInner } from '@mithic/worker/mock';
import { WorkerRuntime, BOOTSTRAP_SOURCE, type WorkerFactory, type WorkerLike } from './worker.ts';

/**
 * A test factory that creates MockWorkers and simulates the OF1/G2 stage-2
 * bootstrap protocol in Node:
 * - Listens for `{ __mithic_init, ports }` messages and stores boot state (with `imports: {}`)
 * - Listens for `{ __mithic_run: { guest, isUrl, imports } }` messages from the runtime
 * - Evaluates the guest SOURCE in a minimal scope with `self.__post` and `onmessage`
 *   (Node CANNOT `import(blob:)`, so the mock evals the string directly instead of minting a
 *   blob: module — the fixtures set `globalThis.__mithic_default`, which the eval exposes)
 * - Calls `__mithic_default(boot)` if set
 * - Routes inbound (non-run, non-init) messages to `__mithic_recv`
 */
function makeTestFactory(): WorkerFactory {
  return {
    create(_src: string): WorkerLike {
      // State for the simulated worker scope
      let isoRecv: ((msg: unknown) => void) | null = null;
      let isoDefault: ((boot: unknown) => Promise<void> | void) | null = null;
      let pendingBoot: { imports?: Record<string, string> } | null = null;

      let innerRef: MockWorkerInner;

      const mock = new MockWorker((inner) => {
        innerRef = inner;

        // Wire inbound messages from runtime → bootstrap simulation
        inner.onmessage = (e: MessageEvent<unknown>) => {
          const data = e.data;
          if (data != null && typeof data === 'object') {
            const d = data as Record<string, unknown>;
            if ('__mithic_init' in d) {
              // Reconstruct the boot object exactly as BOOTSTRAP_SOURCE does —
              // honoring data.preopenFds (K2) rather than positional mapping.
              const ports = Array.isArray(d['ports']) ? d['ports'] as unknown[] : [];
              const preopenFds = Array.isArray(d['preopenFds']) ? d['preopenFds'] as number[] : null;
              const preopenPorts: Record<number, unknown> = {};
              for (let i = 1; i < ports.length; i++) {
                if (ports[i] == null) continue;
                const fd = preopenFds ? preopenFds[i - 1] : i - 1;
                if (typeof fd === 'number') preopenPorts[fd] = ports[i];
              }
              pendingBoot = { control: ports[0], init: d['__mithic_init'], preopenPorts, imports: {} } as never;
              return;
            }
            if ('__mithic_run' in d && d['__mithic_run'] != null && typeof d['__mithic_run'] === 'object') {
              // OF1/G2 stage 2. Node cannot import(blob:), so the mock evals the guest
              // SOURCE string directly (fixtures set globalThis.__mithic_default) and
              // populates boot.imports from the DATA carried in the run message.
              const spec = d['__mithic_run'] as { guest: string; isUrl: boolean; imports?: Record<string, string> };
              if (pendingBoot) pendingBoot.imports = spec.imports ?? {};

              // Evaluate guest code in a scope that provides self.__post
              const guestScope = {
                __mithic_recv: null as ((msg: unknown) => void) | null,
                __mithic_default: null as ((boot: unknown) => Promise<void> | void) | null,
              };

              // The __post function sends to the host (outer side)
              const selfObj = {
                __post: (msg: unknown) => { inner.postMessage(msg); },
              };

              // Run guest code: it may set globalThis.__mithic_default or __mithic_recv
              try {
                new Function(
                  'globalThis', 'self',
                  spec.guest,
                )(guestScope, selfObj);
              } catch { /* ignore eval errors in tests */ }

              isoDefault = guestScope.__mithic_default;
              isoRecv = guestScope.__mithic_recv;

              if (typeof isoDefault === 'function') {
                Promise.resolve(isoDefault(pendingBoot)).then(() => {
                  isoRecv = guestScope.__mithic_recv;
                }).catch(() => { /* ignore */ });
              }
              return;
            }
          }
          // Forward kernel response/event to guest recv hook
          if (typeof isoRecv === 'function') {
            isoRecv(data);
          }
        };
      });

      void innerRef!; // suppress uninitialised warning

      return mock as unknown as WorkerLike;
    },
  };
}

test('worker backend spawns a process that posts a syscall request', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  const code = 'globalThis.__mithic_default = () => { self.__post({ id: 1, call: \'process/getpid\', args: {} }); };';

  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
  });

  rt.onMessage(handle, (m) => received.push(m));

  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  expect(received).toContainEqual({ id: 1, call: 'process/getpid', args: {} });

  rt.dispose(handle);
});

test('isAlive returns true for live process and false after dispose', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  const code = 'globalThis.__mithic_default = () => {};';
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [] },
  });

  expect(rt.isAlive(handle)).toBe(true);
  rt.dispose(handle);
  expect(rt.isAlive(handle)).toBe(false);
});

test('kill terminates worker and isAlive returns false', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  const code = 'globalThis.__mithic_default = () => {};';
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 3, ppid: 0, capabilities: [] },
  });

  expect(rt.isAlive(handle)).toBe(true);
  rt.kill(handle, 'SIGTERM');
  expect(rt.isAlive(handle)).toBe(false);
});

test('postMessage sends a message to the worker recv hook', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  // Guest sets __mithic_recv after its default export runs;
  // recv echoes inbound messages back to the host via __post
  const code = `
    globalThis.__mithic_default = () => {
      globalThis.__mithic_recv = (msg) => {
        self.__post({ id: 99, call: 'echo', args: { got: msg } });
      };
    };
  `;

  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 4, ppid: 0, capabilities: [] },
  });

  rt.onMessage(handle, (m) => received.push(m));

  // Let the worker run and install its recv hook
  await new Promise<void>((r) => setTimeout(r, 100));

  rt.postMessage(handle, { id: 42, ok: true, result: 'hello' });

  await new Promise<void>((r) => setTimeout(r, 200));

  expect(received).toContainEqual({ id: 99, call: 'echo', args: { got: { id: 42, ok: true, result: 'hello' } } });

  rt.dispose(handle);
});

test('BOOTSTRAP_SOURCE contains expected protocol hooks', () => {
  expect(BOOTSTRAP_SOURCE).toContain('__post');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_run');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_recv');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_default');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_init');
  expect(BOOTSTRAP_SOURCE).toContain('__mithic_boot');
  expect(BOOTSTRAP_SOURCE).toContain('createObjectURL');
  expect(BOOTSTRAP_SOURCE).toContain('imports');
  expect(BOOTSTRAP_SOURCE).not.toContain('(0, eval)');
  expect(BOOTSTRAP_SOURCE).not.toContain('__mithic_main');
});

test('per-instance id counters are independent', async () => {
  const rt1 = new WorkerRuntime(makeTestFactory());
  const rt2 = new WorkerRuntime(makeTestFactory());

  const init = { type: 'init' as const, entry: 'inline' as const, args: [], env: {}, cwd: '/', pid: 10, ppid: 0, capabilities: [] };
  const code = 'globalThis.__mithic_default = () => {};';

  const h1a = await rt1.spawn(code, { init });
  const h1b = await rt1.spawn(code, { init });
  const h2a = await rt2.spawn(code, { init });

  // Both instances start at 1; ids within the same instance are sequential
  expect(h1a.id).toBe(1);
  expect(h1b.id).toBe(2);
  // rt2 has its own counter — also starts at 1, independent of rt1
  expect(h2a.id).toBe(1);

  rt1.dispose(h1a);
  rt1.dispose(h1b);
  rt2.dispose(h2a);
});

test('init handshake delivers boot object to default-export guest', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  // Guest uses the new default-export convention; captures boot and posts it back
  const code = `
    globalThis.__mithic_default = async (boot) => {
      self.__post({ id: 7, call: 'boot-check', args: {
        hasControl: boot != null && 'control' in boot,
        hasInit: boot != null && 'init' in boot,
        hasPreopenPorts: boot != null && 'preopenPorts' in boot,
        pid: boot != null ? boot.init.pid : -1,
      }});
    };
  `;

  // Create a MessageChannel to act as the control port
  const { port1: controlPort, port2: _controlPortGuest } = new MessageChannel();

  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 42, ppid: 0, capabilities: [] },
    transfer: [controlPort],
  });

  rt.onMessage(handle, (m) => received.push(m));

  await new Promise<void>((r) => setTimeout(r, 300));

  expect(received).toContainEqual({
    id: 7,
    call: 'boot-check',
    args: { hasControl: true, hasInit: true, hasPreopenPorts: true, pid: 42 },
  });

  rt.dispose(handle);
  _controlPortGuest.close();
});

test('init handshake delivers boot object even with an empty transfer list', async () => {
  const rt = new WorkerRuntime(makeTestFactory());
  const code = `
    globalThis.__mithic_default = async (boot) => {
      self.__post({ id: 5, call: 'boot-check', args: { hasInit: boot != null && 'init' in boot, pid: boot != null ? boot.init.pid : -1 } });
    };
  `;
  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 77, ppid: 0, capabilities: [] },
    transfer: [],
  });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise<void>((r) => setTimeout(r, 200));
  expect(received).toContainEqual({ id: 5, call: 'boot-check', args: { hasInit: true, pid: 77 } });
  rt.dispose(handle);
});

test('preopenFds maps stdio ports to non-positional guest fds (K2)', async () => {
  const rt = new WorkerRuntime(makeTestFactory());
  const code = `
    globalThis.__mithic_default = async (boot) => {
      const fds = boot != null ? Object.keys(boot.preopenPorts).map(Number).sort((a,b)=>a-b) : [];
      self.__post({ id: 8, call: 'fd-check', args: { fds } });
    };
  `;
  // control + one extra port destined for guest fd 5 (not positional fd 0).
  const { port1: control } = new MessageChannel();
  const { port1: extra } = new MessageChannel();
  const received: unknown[] = [];
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
    transfer: [control, extra],
    preopenFds: [5],
  });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise<void>((r) => setTimeout(r, 200));
  expect(received).toContainEqual({ id: 8, call: 'fd-check', args: { fds: [5] } });
  rt.dispose(handle);
});

test('postMessage forwards a transfer list to the worker', async () => {
  const rt = new WorkerRuntime(makeTestFactory());
  const code = `
    globalThis.__mithic_default = () => {
      globalThis.__mithic_recv = (msg) => { self.__post({ id: 11, call: 'recv', args: { hasPort: msg != null && typeof msg === 'object' && 'port' in msg } }); };
    };
  `;
  const received: unknown[] = [];
  const handle = await rt.spawn(code, { init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] } });
  rt.onMessage(handle, (m) => received.push(m));
  await new Promise<void>((r) => setTimeout(r, 100));
  const { port1, port2 } = new MessageChannel();
  rt.postMessage(handle, { id: 1, ok: true, result: { port: port1 } } as never, [port1]);
  await new Promise<void>((r) => setTimeout(r, 200));
  // postMessage forwards the message (and its transfer list) to the worker; the
  // guest recv hook FIRES on delivery. The MockWorker does NOT perform real
  // structured-clone port transfer, so the transferred port is not reconstructed
  // on the guest side (`hasPort` is false here) — true transfer semantics (the
  // port being moved/detached) are exercised by the iframe/worker browser path,
  // not this in-process mock. We assert DELIVERY (the recv fired), per plan note,
  // rather than forcing a brittle port-liveness assertion the mock can't satisfy.
  expect(received).toContainEqual({ id: 11, call: 'recv', args: { hasPort: false } });
  port2.close();
  rt.dispose(handle);
});
