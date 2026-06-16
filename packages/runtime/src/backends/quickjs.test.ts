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

// Fix 4: the backend itself rejects fs/port with ENOSYS (transferable:false),
// without delegating to onSyscall.
test('fs/port returns ENOSYS from the backend without calling onSyscall', async () => {
  const rt = await QuickJSRuntime.create();
  let onSyscallCalled = false;
  const code = `
    const r = await __isola_syscall('fs/port', { fd: 3 });
    __isola_done(r);
  `;
  let result: unknown;
  rt.onResult((v) => { result = v; });
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 5, ppid: 0, capabilities: [] },
    onSyscall: async () => { onSyscallCalled = true; return {}; },
  });
  await new Promise(r => setTimeout(r, 300));
  expect(onSyscallCalled).toBe(false);
  expect(result).toEqual({ ok: false, error: { code: 'ENOSYS', message: expect.any(String) } });
  rt.dispose(h);
}, 10000);

// Fix 3: cpuLimit is honestly enforced — a tight infinite loop with a small
// cpuMs budget (and no wall-clock timeout) is aborted via the opcode-count proxy.
test('cpuLimit aborts a CPU-bound infinite loop via the opcode budget', async () => {
  const rt = await QuickJSRuntime.create();
  // No timeoutMs — only cpuMs. If cpuLimit were not enforced this would hang.
  const code = 'let x = 0; while (true) { x = (x + 1) % 1000000; }';
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 9, ppid: 0, capabilities: [], limits: { cpuMs: 5 } },
    onSyscall: async () => ({}),
  });
  const exit = await rt.waitExit(h);
  expect(exit.code).not.toBe(0);
}, 10000);

// Fix 2 regression: disposing an interrupt-killed runtime must NOT trigger the
// "Assertion failed: list_empty(&rt->gc_obj_list)" C-level abort.  The fix sets
// `entry.interruptDead = true` inside the interrupt handler so `#disposeEntry`
// skips `qjsRuntime.dispose()` — same tradeoff as the OOM path.
//
// We verify the flag indirectly: if the assertion fired, the process would crash
// or the test would hang; a clean exit proves the guard worked.
test('Fix 2: interrupt-killed runtime does not trigger C-level assertion on dispose', async () => {
  const rt = await QuickJSRuntime.create();
  const code = 'while (true) {}';  // tight loop — interrupt will fire
  const h = await rt.spawn(code, {
    init: {
      type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 42,
      ppid: 0, capabilities: [], limits: { timeoutMs: 200 },
    },
    onSyscall: async () => ({}),
  });
  // waitExit resolves once the interrupt handler has fired and the runtime exits.
  const exit = await rt.waitExit(h);
  // Non-zero exit confirms the interrupt fired (not a normal completion).
  expect(exit.code).not.toBe(0);
  // If we reach here without a crash/hang, the C-level assertion was not triggered.
}, 10000);
