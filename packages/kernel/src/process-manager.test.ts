import { expect, test } from 'vitest';
import { ProcessManager } from './process-manager.ts';

// Fix 1: wait() must not hang on unknown or already-reaped PIDs
test('wait() on an unknown pid resolves immediately (does not hang)', async () => {
  const pm = new ProcessManager();
  const TIMEOUT_MS = 200;
  const result = await Promise.race([
    pm.wait(9999),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS),
    ),
  ]);
  expect(result).toMatchObject({ pid: 9999, status: 'no-child', code: -1 });
});

test('wait() twice on the same child — second call resolves immediately, not hang', async () => {
  const pm = new ProcessManager();
  const child = pm.allocate(0);
  pm.markReady(child);
  // First wait: normal path
  const w1 = pm.wait(child);
  pm.markExit(child, 0);
  await w1;
  // Second wait: child is gone (reaped+deleted); must resolve immediately
  const TIMEOUT_MS = 200;
  const result = await Promise.race([
    pm.wait(child),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS),
    ),
  ]);
  expect(result).toMatchObject({ status: 'no-child', code: -1 });
});

// Fix 5: EXITING state — markExit sets EXITING before DEAD
test('markExit transitions through EXITING then DEAD', () => {
  const pm = new ProcessManager();
  const pid = pm.allocate(0);
  pm.markReady(pid);
  const states: string[] = [];
  // Capture state at the moment waiters fire (which is after EXITING but during DEAD transition)
  pm.wait(pid).then(r => states.push(`waited:${r.code}`));
  // We'll check state inside a signal listener (fires before waiters are resolved)
  pm.onSignal(0, () => {
    // At SIGCHLD delivery point, state should be EXITING
    const entry = pm.get(pid);
    if (entry) states.push(`signal:${entry.state}`);
  });
  pm.markExit(pid, 0);
  // After markExit, process is DEAD (or removed from map)
  expect(states).toContain('signal:EXITING');
});

test('allocates monotonic PIDs and tracks LOADING→RUNNING→DEAD', () => {
  const pm = new ProcessManager();
  const pid = pm.allocate(0);
  expect(pid).toBeGreaterThan(0);
  expect(pm.get(pid)?.state).toBe('LOADING');
  pm.markReady(pid);
  expect(pm.get(pid)?.state).toBe('RUNNING');
  pm.markExit(pid, 0);
  expect(pm.get(pid)?.state).toBe('DEAD');
  expect(pm.get(pid)?.exitCode).toBe(0);
});

test('wait resolves with exit status; SIGCHLD fired to parent', async () => {
  const pm = new ProcessManager();
  const parent = pm.allocate(0); pm.markReady(parent);
  const child = pm.allocate(parent); pm.markReady(child);
  const childSignals: string[] = [];
  pm.onSignal(parent, (s) => childSignals.push(s));
  const waitP = pm.wait(child);
  pm.markExit(child, 3);
  expect(await waitP).toEqual({ pid: child, status: 'exited', code: 3 });
  expect(childSignals).toContain('SIGCHLD');
});

test('orphans reparent to kernel (ppid 0) when parent dies', () => {
  const pm = new ProcessManager();
  const parent = pm.allocate(0); pm.markReady(parent);
  const child = pm.allocate(parent); pm.markReady(child);
  pm.markExit(parent, 0);
  expect(pm.get(child)?.ppid).toBe(0);
});
