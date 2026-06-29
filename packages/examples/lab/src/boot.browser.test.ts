/**
 * Boot test for `@mithic/example-lab` (Task V1): the composition root wires a
 * kernel (Worker runtime + VFS: Memory on `/`, OPFS on `/persist`, Device on
 * `/dev`) with the command suite and the shell, exposing a headless `run(line)`
 * that returns the line's captured stdout. The smallest end-to-end proof is that
 * a shell builtin runs: `echo hi` -> `hi`.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from './main.ts';
import type { Lab } from './main.ts';

let lab: Lab | undefined;

afterEach(() => {
  lab?.dispose();
  lab = undefined;
});

const T = 30000;

test('createLab boots and runs `echo hi` through the shell -> hi', async () => {
  lab = await createLab();
  const out = await lab.run('echo hi');
  expect(out.trim()).toBe('hi');
}, T);

test('createLab runs an external coreutils command end-to-end (echo hi | grep h)', async () => {
  lab = await createLab();
  const out = await lab.run('echo hi | grep h');
  expect(out).toContain('hi');
}, T);

test('createLab exposes the kernel and the VFS for the loop to compose on', async () => {
  lab = await createLab();
  expect(lab.kernel).toBeDefined();
  expect(lab.vfs).toBeDefined();
  // The device tree is mounted so utilities can open `/dev/*`.
  const out = await lab.run('head -c 8 /dev/zero | base64');
  expect(out).toContain('AAAAAAAAAAA=');
}, T);
