import { expect, test } from 'vitest';
import { QuickJSRuntime } from './quickjs.ts';

test('quickjs process performs an async syscall via the asyncified bridge', async () => {
  const rt = await QuickJSRuntime.create();
  const code = `
    const r = await __isola_syscall('process/getpid', {});
    __isola_done(r.pid);
  `;
  let resolved: number | undefined;
  rt.onResult((v) => { resolved = v as number; });
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 77, ppid: 0, capabilities: [] },
    onSyscall: async () => ({ pid: 77 }),
  });
  await new Promise(r => setTimeout(r, 300));
  expect(resolved).toBe(77);
  rt.dispose(h);
});

test('memory limit aborts an over-allocating process', async () => {
  const rt = await QuickJSRuntime.create();
  const code = 'const a=[]; while(true){ a.push(new Array(100000).fill(0)); }';
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [], limits: { memoryMb: 16, timeoutMs: 2000 } },
    onSyscall: async () => ({}),
  });
  const exit = await rt.waitExit(h);
  expect(exit.code).not.toBe(0);
}, 10000);
