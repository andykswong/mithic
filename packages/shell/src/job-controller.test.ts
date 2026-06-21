/**
 * C4 — JobController unit tests. Exercises the extracted job table directly:
 * registration / `$!`, wait / wait-all / wait-next reaping, disown removal, and
 * kill signal delivery (via the injected kill callback) + state transitions.
 */
import { expect, test } from 'vitest';
import { JobController } from './job-controller.ts';

test('register allocates ascending ids and tracks $!', () => {
  const jc = new JobController(undefined);
  const a = jc.register('sleep 1', [4242]);
  const b = jc.register('sleep 2', [4243]);
  expect(a.id).toBe(1);
  expect(b.id).toBe(2);
  expect(jc.list()).toHaveLength(2);
  jc.setLastBgPid(4243);
  expect(jc.lastBgPid()).toBe(4243);
});

test('waitJob resolves a job by id and by pid', async () => {
  const jc = new JobController(undefined);
  const j = jc.register('cmd', [555]);
  j.promise = Promise.resolve(3);
  expect(await jc.waitJob(j.id)).toBe(3);
  expect(await jc.waitJob(555)).toBe(3);
});

test('waitJob for an unknown spec returns 0; waitAll returns the last code', async () => {
  const jc = new JobController(undefined);
  expect(await jc.waitJob(99)).toBe(0);
  const a = jc.register('a'); a.promise = Promise.resolve(0);
  const b = jc.register('b'); b.promise = Promise.resolve(5);
  expect(await jc.waitAll()).toBe(5);
});

test('waitNext returns 127 with no jobs, else reaps the first finisher', async () => {
  const jc = new JobController(undefined);
  expect(await jc.waitNext()).toBe(127);
  const slow = jc.register('slow'); slow.promise = new Promise((r) => setTimeout(() => r(2), 20));
  const fast = jc.register('fast'); fast.promise = Promise.resolve(7);
  expect(await jc.waitNext()).toBe(7);
  // The fast job is reaped; the slow one remains.
  expect(jc.list().map((j) => j.command)).toEqual(['slow']);
});

test('remove (disown) deletes a job by id or pid', () => {
  const jc = new JobController(undefined);
  jc.register('a', [10]);
  expect(jc.remove(10)).toBe(true);
  expect(jc.list()).toHaveLength(0);
  expect(jc.remove(123)).toBe(false);
});

test('killJob delivers a SIG-prefixed signal to every pid and updates state', () => {
  const sent: Array<{ pid: number; sig: string }> = [];
  const jc = new JobController((pid, sig) => sent.push({ pid, sig }));
  jc.register('cmd', [11, 12]);
  expect(jc.killJob(1, 'TERM')).toBe(true);
  expect(sent).toEqual([{ pid: 11, sig: 'SIGTERM' }, { pid: 12, sig: 'SIGTERM' }]);
  expect(jc.list()[0].state).toBe('done');
});

test('killJob CONT/STOP change run state without terminating', () => {
  const jc = new JobController(() => {});
  const j = jc.register('cmd', [11]);
  jc.killJob(1, 'STOP');
  expect(j.state).toBe('stopped');
  jc.killJob(1, 'CONT');
  expect(j.state).toBe('running');
});

test('killJob with no kernel kill still updates the table best-effort', () => {
  const jc = new JobController(undefined);
  jc.register('cmd', [11]);
  expect(jc.killJob(1, 'TERM')).toBe(true);
  expect(jc.list()[0].state).toBe('done');
  expect(jc.killJob(99, 'TERM')).toBe(false);
});
