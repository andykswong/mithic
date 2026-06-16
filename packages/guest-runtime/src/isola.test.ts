import { expect, test } from 'vitest';
import { initIsola } from './isola.ts';

function makeInitMessage() {
  return {
    type: 'init',
    entry: 'test.wasm',
    args: ['test', '--flag'],
    env: { HOME: '/home/test', PATH: '/usr/bin' },
    cwd: '/home/test',
    pid: 42,
    ppid: 1,
    capabilities: [],
  };
}

test('initIsola resolves with correct pid/ppid/args/env/cwd', async () => {
  const { port1, port2 } = new MessageChannel();

  const runtimeP = initIsola(port1);

  // Send init message from "kernel"
  port2.postMessage(makeInitMessage());

  // Wait for ready
  const ready = await new Promise<unknown>(resolve => {
    port2.onmessage = (e) => resolve(e.data);
  });
  expect(ready).toEqual({ type: 'ready' });

  const runtime = await runtimeP;
  expect(runtime.pid).toBe(42);
  expect(runtime.ppid).toBe(1);
  expect(runtime.args).toEqual(['test', '--flag']);
  expect(runtime.env).toEqual({ HOME: '/home/test', PATH: '/usr/bin' });
  expect(runtime.cwd).toBe('/home/test');

  port1.close(); port2.close();
});

test('initIsola syscall forwards to kernel and resolves', async () => {
  const { port1, port2 } = new MessageChannel();
  const runtimeP = initIsola(port1);

  port2.postMessage(makeInitMessage());

  // Consume ready
  await new Promise<void>(resolve => {
    port2.onmessage = (e) => {
      if ((e.data as { type?: string }).type === 'ready') { resolve(); return; }
      // Handle syscall
      const req = e.data as { id: number; call: string };
      port2.postMessage({ id: req.id, ok: true, result: { pid: 42 } });
    };
  });

  const runtime = await runtimeP;

  // Reset handler for syscalls
  port2.onmessage = (e) => {
    const req = e.data as { id: number; call: string };
    port2.postMessage({ id: req.id, ok: true, result: { pid: 42 } });
  };

  const result = await runtime.syscall('process/getpid', {});
  expect(result).toEqual({ pid: 42 });

  port1.close(); port2.close();
});
