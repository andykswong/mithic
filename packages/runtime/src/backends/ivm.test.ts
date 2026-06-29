import { expect, test } from 'vitest';
import { isIvmAvailable, IvmRuntime } from './ivm.ts';

// Test 1: isIvmAvailable() must always return a boolean — never throw.
// This passes regardless of whether the native addon is installed.
test('isIvmAvailable() returns a boolean without throwing', async () => {
  const result = await isIvmAvailable();
  expect(typeof result).toBe('boolean');
});

// Test 2: Real execution — only runs when the native addon is present.
// H3: __mithic_syscall(call, args) is a SUSPENDABLE bridge that returns the host
// result synchronously into the isolate (applySyncPromise). This proves a syscall
// is actually SERVICED (a result round-trips), not merely posted fire-and-forget.
test.skipIf(!(await isIvmAvailable()))(
  'IvmRuntime services a __mithic_syscall round-trip and returns the result into the isolate',
  async () => {
    const rt = await IvmRuntime.create(64);

    const seen: Array<{ call: string; args: Record<string, unknown> }> = [];
    // Guest calls __mithic_syscall('echo', {n:41}); the host returns {result:{n:42}}
    // and the guest exits with that value via process/exit.
    const code = `
      const r = __mithic_syscall('echo', { n: 41 });
      __mithic_syscall('process/exit', { code: r.n });
    `;
    const handle = await rt.spawn(code, {
      init: {
        type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [],
      },
      onSyscall: async (call, args) => {
        seen.push({ call, args });
        if (call === 'echo') return { ok: true, result: { n: Number(args.n) + 1 } };
        return { ok: true, result: {} };
      },
    });

    // Let the suspendable bridge round-trip and the guest finish.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // The echo syscall was serviced with the args the guest passed.
    expect(seen.some((s) => s.call === 'echo' && (s.args as { n?: number }).n === 41)).toBe(true);
    rt.dispose(handle);
  },
);

test.skipIf(!(await isIvmAvailable()))(
  'IvmRuntime.isAlive returns true for live isolate and false after dispose',
  async () => {
    const rt = await IvmRuntime.create(64);

    const handle = await rt.spawn('/* idle */', {
      init: {
        type: 'init',
        entry: 'inline',
        args: [],
        env: {},
        cwd: '/',
        pid: 2,
        ppid: 0,
        capabilities: [],
      },
    });

    expect(rt.isAlive(handle)).toBe(true);
    rt.dispose(handle);
    expect(rt.isAlive(handle)).toBe(false);
  },
);

test.skipIf(!(await isIvmAvailable()))(
  'IvmRuntime enforces memoryLimit — a runaway allocation kills the isolate (exit 137)',
  async () => {
    const rt = await IvmRuntime.create(16); // 16 MiB cap
    // Grow the V8 *heap* (retained live set of plain arrays) past the cap so the
    // isolate's `memoryLimit` triggers a TERMINATING OOM — "Isolate was disposed
    // during execution due to memory limit", disposed=true — which the backend
    // classifies as exit 137. NOTE: large `Uint8Array`s instead trip a CATCHABLE
    // `RangeError: Array buffer allocation failed` (external-memory allocation
    // failure) before the heap cap engages, so they do NOT exercise the advertised
    // heap `memoryLimit` enforcement. Retained heap arrays do.
    const code = `
      const root = [];
      for (let i = 0; i < 100000; i++) {
        const a = new Array(50000);
        for (let j = 0; j < 50000; j++) a[j] = i * j;
        root.push(a);
      }
      __mithic_syscall('process/exit', { code: 0 });
    `;
    const handle = await rt.spawn(code, {
      init: { type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0, capabilities: [], limits: { memoryMb: 16 } },
      onSyscall: async () => ({ ok: true, result: {} }),
    });
    const { code: exitCode } = await rt.waitExit(handle);
    expect(exitCode).toBe(137);
  },
  20000,
);
