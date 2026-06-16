import { expect, test } from 'vitest';
import { MockWorker } from '@mithic/worker/mock';
import type { MockWorkerInner } from '@mithic/worker/mock';
import { WorkerRuntime, BOOTSTRAP_SOURCE, type WorkerFactory, type WorkerLike } from './worker.ts';

/**
 * A test factory that creates MockWorkers and simulates the bootstrap protocol:
 * - Listens for `{ __isola_run: string }` messages from the runtime
 * - Evaluates the guest code in a minimal scope with `self.__post` and `onmessage`
 * - Routes inbound (non-run) messages to `__isola_recv`
 */
function makeTestFactory(): WorkerFactory {
  return {
    create(_src: string): WorkerLike {
      // State for the simulated worker scope
      let isoMain: (() => void) | null = null;
      let isoRecv: ((msg: unknown) => void) | null = null;

      let innerRef: MockWorkerInner;

      const mock = new MockWorker((inner) => {
        innerRef = inner;

        // Wire inbound messages from runtime → bootstrap simulation
        inner.onmessage = (e: MessageEvent<{ __isola_run?: string } | unknown>) => {
          const data = e.data;
          if (
            data != null &&
            typeof data === 'object' &&
            '__isola_run' in (data as object) &&
            typeof (data as Record<string, unknown>)['__isola_run'] === 'string'
          ) {
            // Evaluate guest code in a scope that provides self.__post
            const guestScope = {
              __isola_main: null as (() => void) | null,
              __isola_recv: null as ((msg: unknown) => void) | null,
            };

            // The __post function sends to the host (outer side)
            const selfObj = {
              __post: (msg: unknown) => { inner.postMessage(msg); },
            };

            // Run guest code: it may set globalThis.__isola_main or __isola_recv
            const guestCode = (data as Record<string, unknown>)['__isola_run'] as string;
            try {

              new Function(
                'globalThis', 'self',
                guestCode
              )(guestScope, selfObj);
            } catch { /* ignore eval errors in tests */ }

            isoMain = guestScope.__isola_main;
            isoRecv = guestScope.__isola_recv;

            if (typeof isoMain === 'function') {
              try { isoMain(); } catch { /* ignore */ }
              // After main(), capture any updated recv
              isoRecv = guestScope.__isola_recv;
            }
          } else {
            // Forward kernel response/event to guest recv hook
            if (typeof isoRecv === 'function') {
              isoRecv(data);
            }
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

  const code = 'globalThis.__isola_main = () => { self.__post({ id: 1, call: \'process/getpid\', args: {} }); };';

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

  const code = 'globalThis.__isola_main = () => {};';
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [] },
  });

  expect(rt.isAlive(handle)).toBe(true);
  rt.dispose(handle);
  expect(rt.isAlive(handle)).toBe(false);
});

test('kill terminates a running worker', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  const code = 'globalThis.__isola_main = () => {};';
  const handle = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 3, ppid: 0, capabilities: [] },
  });

  // kill should not throw
  rt.kill(handle, 'SIGTERM');
  rt.dispose(handle);
});

test('postMessage sends a message to the worker recv hook', async () => {
  const rt = new WorkerRuntime(makeTestFactory());

  // Guest sets __isola_recv after __isola_main runs;
  // recv echoes inbound messages back to the host via __post
  const code = `
    globalThis.__isola_main = () => {
      globalThis.__isola_recv = (msg) => {
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
  expect(BOOTSTRAP_SOURCE).toContain('__isola_run');
  expect(BOOTSTRAP_SOURCE).toContain('__isola_main');
  expect(BOOTSTRAP_SOURCE).toContain('__isola_recv');
});
