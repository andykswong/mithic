/* eslint-disable @typescript-eslint/no-explicit-any -- loop-control tests use a mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mk() {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

// ── M8: break/continue/return outside loop/function ─────────────────────────

test('break outside a loop prints a diagnostic and continues', async () => {
  const h = mk();
  const code = await h.ex.exec('break\necho after');
  expect(h.err).toMatch(/only meaningful in a.*loop/);
  expect(h.out.trim()).toBe('after');
  expect(code).toBe(0);
});

test('continue outside a loop prints a diagnostic and continues', async () => {
  const h = mk();
  await h.ex.exec('continue\necho after');
  expect(h.err).toMatch(/only meaningful in a.*loop/);
  expect(h.out.trim()).toBe('after');
});

test('return outside a function prints a diagnostic and continues', async () => {
  const h = mk();
  await h.ex.exec('return\necho after');
  expect(h.err).toMatch(/can only .*return/);
  expect(h.out.trim()).toBe('after');
});

test('break inside a loop still works', async () => {
  const h = mk();
  await h.ex.exec('for i in a b c; do echo $i; if [ $i = b ]; then break; fi; done');
  expect(h.out.trim()).toBe('a\nb');
});

test('break 2 exits two loop levels', async () => {
  const h = mk();
  await h.ex.exec('for i in a b; do for j in 1 2 3; do if [ $j = 2 ]; then break 2; fi; echo $i$j; done; done');
  expect(h.out.trim()).toBe('a1');
});

test('return from a function returns its code', async () => {
  const h = mk();
  await h.ex.exec('f() { echo before; return 42; echo after; }\nf\necho $?');
  expect(h.out.trim()).toBe('before\n42');
});
