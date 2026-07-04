import { expect, test } from 'vitest';
import { QuickJSRuntime } from './quickjs.ts';

test('onResult fires every registered callback with the __mithic_done value', async () => {
  const rt = await QuickJSRuntime.create();
  const seen: unknown[] = [];
  rt.onResult((v) => seen.push(v));
  rt.onResult((v) => seen.push(v));
  const code = `
    __mithic_done({ a: 1, list: [1,2,3] });
    __mithic_syscall('process/exit', { code: 0 });
  `;
  await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
    onSyscall: async () => ({ ok: true, result: {} }),
  });
  await new Promise<void>((r) => setTimeout(r, 300));
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual({ a: 1, list: [1, 2, 3] });
});

test('isAlive/dispose/kill/waitExit tolerate a non-existent handle', async () => {
  const rt = await QuickJSRuntime.create();
  const ghost = { id: 9999 };
  expect(rt.isAlive(ghost)).toBe(false);
  expect(() => rt.dispose(ghost)).not.toThrow();
  expect(() => rt.kill(ghost, 'SIGKILL')).not.toThrow();
  await expect(rt.waitExit(ghost)).resolves.toEqual({ code: 1 });
});

test('quickjs process performs an async syscall via the asyncified bridge', async () => {
  const rt = await QuickJSRuntime.create();
  const code = `
    const r = await __mithic_syscall('process/getpid', {});
    __mithic_done(r.pid);
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

test('QuickJSRuntime rejects a URL entry with a clear error (no module loader)', async () => {
  const rt = await QuickJSRuntime.create();
  await expect(rt.spawn(new URL('https://example.com/x.js'), {
    init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [] },
    onSyscall: async () => ({ ok: true, result: {} }),
  })).rejects.toThrow(/URL entry/i);
});

test('memory limit aborts an over-allocating process', async () => {
  const rt = await QuickJSRuntime.create();
  // Allocate in chunks that each dwarf the 16 MB cap so the loop OOMs on its FIRST
  // iteration. Small chunks (e.g. Array(100000)) instead creep toward the ceiling,
  // forcing QuickJS to run a full mark-sweep GC on every push that nears the limit
  // (the arrays are retained, so nothing is reclaimed) — near-O(n²) thrashing that
  // takes ~4.5s in isolation and times out under parallel-suite load. A single
  // over-cap chunk aborts in tens of ms with the same exit-137 outcome. Keep the
  // chunk large.
  const code = 'const a=[]; while(true){ a.push(new Array(4000000).fill(0)); }';
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
    const r = await __mithic_syscall('fs/port', { fd: 3 });
    __mithic_done(r);
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

// R1 regression: an EXTERNAL kill() while the guest is SUSPENDED mid-syscall
// (Asyncify-suspended, awaiting a host handler that never resolves) must NOT
// trigger the "Assertion failed: list_empty(&rt->gc_obj_list)" C-level abort in
// JS_FreeRuntime. This is the exact kernel output-cap SIGKILL scenario: the
// output-drain hits maxOutputBytes and calls kill() while the guest is parked in
// a syscall. The fix tracks "suspended in a syscall" and skips qjsRuntime.dispose()
// exactly like the OOM/interrupt paths.
//
// We verify indirectly: if the assertion fired, the worker process would crash
// (taking unrelated tests with it under forks-pool reuse) or this test would hang.
// A clean teardown — exit code recorded as the kill code, the process not alive,
// and this test continuing — proves the guard worked.
test('R1: kill() while guest is suspended mid-syscall tears down cleanly (no native abort)', async () => {
  const rt = await QuickJSRuntime.create();
  // The guest awaits a syscall whose host handler never resolves, so the WASM
  // call stack stays Asyncify-suspended awaiting the host. This is the state in
  // which disposing the runtime aborts at the C level.
  const code = `
    await __mithic_syscall('slow/never', {});
    __mithic_done('unreachable');
  `;
  let entered = false;
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 101, ppid: 0, capabilities: [] },
    // Never resolves — the guest stays suspended in the asyncified bridge.
    onSyscall: () => {
      entered = true;
      return new Promise<Record<string, unknown>>(() => { /* never resolves */ });
    },
  });
  // Register the exit waiter BEFORE killing — mirrors the kernel launcher, which
  // calls runtime.waitExit(handle).then(...) right after spawn. (kill() deletes
  // the entry, so a waiter registered AFTER the kill would see the no-entry
  // fallback rather than the recorded kill code.)
  const exitP = rt.waitExit(h);
  // Wait until the guest has actually entered (and is parked in) the syscall.
  const deadline = Date.now() + 2000;
  while (!entered && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(entered).toBe(true);
  // Kill WHILE suspended — this is the path that aborts without the latch.
  rt.kill(h, 'SIGKILL');
  // Teardown was clean: exit recorded with the kill code, process not alive.
  const exit = await exitP;
  expect(exit.code).toBe(137);
  expect(rt.isAlive(h)).toBe(false);
  // Let any pending microtasks settle; if the assertion had fired we would not
  // reach a passing assertion here.
  await new Promise((r) => setTimeout(r, 50));
}, 10000);

// R1 control: a NORMAL (non-suspended) dispose still disposes the runtime cleanly
// — the fix must not leak runtimes in the common case by over-broadly skipping
// dispose. A guest that completes without ever suspending in a syscall is torn
// down via dispose(); a subsequent spawn must still work.
test('R1: a non-suspended process still disposes cleanly (no leak in the common case)', async () => {
  const rt = await QuickJSRuntime.create();
  const code = '__mithic_done(123);';
  let resolved: number | undefined;
  rt.onResult((v) => { resolved = v as number; });
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 102, ppid: 0, capabilities: [] },
    onSyscall: async () => ({}),
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(resolved).toBe(123);
  rt.dispose(h);
  expect(rt.isAlive(h)).toBe(false);
  // A fresh spawn on the same backend module still works after a clean dispose.
  const code2 = '__mithic_done(456);';
  let resolved2: number | undefined;
  rt.onResult((v) => { resolved2 = v as number; });
  const h2 = await rt.spawn(code2, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 103, ppid: 0, capabilities: [] },
    onSyscall: async () => ({}),
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(resolved2).toBe(456);
  rt.dispose(h2);
}, 10000);

// R1 regression: an UNCAUGHT guest throw must NOT trigger the
// "Assertion failed: list_empty(&rt->gc_obj_list)" C-level abort in JS_FreeRuntime.
// The async wrapper rejects; the rejection ERROR handle is caller-owned and was
// never disposed, leaving a live object on the runtime's gc_obj_list so the
// subsequent qjsRuntime.dispose() aborted at the C level. The fix disposes the
// rejection error handle before disposing the runtime. (This is the path the
// @mithic/server "guest uncaught throw" test exercises.)
test('R1: an uncaught guest throw exits non-zero without a native abort', async () => {
  const rt = await QuickJSRuntime.create();
  const code = 'throw new Error("guest crash");';
  const h = await rt.spawn(code, {
    init: { type: 'init', entry: 'inline', args: ['p'], env: {}, cwd: '/', pid: 201, ppid: 0, capabilities: [] },
    onSyscall: async () => ({}),
  });
  const exit = await rt.waitExit(h);
  // Non-zero exit (the throw was not swallowed); reaching this assertion without
  // a crash/hang proves the C-level assertion did not fire.
  expect(exit.code).not.toBe(0);
  await new Promise((r) => setTimeout(r, 50));
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
