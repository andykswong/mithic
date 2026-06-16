import { expect, test } from 'vitest';
import { isIvmAvailable, IvmRuntime } from './ivm.ts';

// Test 1: isIvmAvailable() must always return a boolean — never throw.
// This passes regardless of whether the native addon is installed.
test('isIvmAvailable() returns a boolean without throwing', async () => {
  const result = await isIvmAvailable();
  expect(typeof result).toBe('boolean');
});

// Test 2: Real execution — only runs when the native addon is present.
// If isolated-vm is not installed/built, this test is skipped gracefully.
test.skipIf(!(await isIvmAvailable()))(
  'IvmRuntime spawns a process that posts a syscall request via __mithic_syscall',
  async () => {
    const rt = await IvmRuntime.create(64);

    // Guest code: calls __mithic_syscall with a JSON-encoded syscall request.
    const code = '__mithic_syscall(JSON.stringify({ id: 1, call: \'process/getpid\', args: {} }));';

    const received: unknown[] = [];
    const handle = await rt.spawn(code, {
      init: {
        type: 'init',
        entry: 'inline',
        args: [],
        env: {},
        cwd: '/',
        pid: 1,
        ppid: 0,
        capabilities: [],
      },
    });

    rt.onMessage(handle, (m) => received.push(m));

    // Give async callbacks time to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(received).toContainEqual({ id: 1, call: 'process/getpid', args: {} });

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
