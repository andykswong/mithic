import { expect, test } from 'vitest';
import { ProcessManager } from './process-manager.ts';

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
