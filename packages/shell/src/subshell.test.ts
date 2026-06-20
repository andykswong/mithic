/* eslint-disable @typescript-eslint/no-explicit-any -- subshell tests use a minimal mock kernel typed as any */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import { parse } from './parser.ts';

function mockKernel() {
  const spawned: any[] = [];
  return {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
}

function run(src: string, ctx: Record<string, unknown> = {}) {
  const k = mockKernel();
  let out = '';
  let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; },
    onStderr: (s) => { err += s; },
  });
  return { ex, run: () => ex.run(parse(src)), get out() { return out; }, get err() { return err; } };
}

// ── CRITICAL: subshell `exit` must not abort the parent ─────────────────────

test('(exit 42); echo ok — subshell exit does NOT exit parent', async () => {
  const h = run('(exit 42); echo "still here: $?"');
  const code = await h.run();
  expect(h.out.trim()).toBe('still here: 42');
  expect(code).toBe(0);
});

test('(exit 1); echo still_running — parent continues, exits 0', async () => {
  const h = run('(exit 1)\necho still_running');
  const code = await h.run();
  expect(h.out.trim()).toBe('still_running');
  expect(code).toBe(0);
});

test('subshell exit code is propagated to $?', async () => {
  const h = run('(exit 42)\necho $?');
  await h.run();
  expect(h.out.trim()).toBe('42');
});

// ── M2: subshell isolation ──────────────────────────────────────────────────

test('subshell does not leak env changes', async () => {
  const h = run('X=outer; (X=inner; echo $X); echo $X');
  await h.run();
  expect(h.out.trim()).toBe('inner\nouter');
});

test('subshell does not leak cd', async () => {
  const h = run('cd /; (cd /tmp; echo $PWD); echo $PWD');
  await h.run();
  expect(h.out.trim()).toBe('/tmp\n/');
});

test('subshell does not leak set -e', async () => {
  const h = run('(set -e; false); echo ok');
  const code = await h.run();
  expect(h.out.trim()).toBe('ok');
  expect(code).toBe(0);
});

test('subshell does not leak functions', async () => {
  const h = run('(f() { echo inner; }); type f 2>/dev/null || echo no_func');
  await h.run();
  expect(h.out).toContain('no_func');
});

test('subshell does not leak break to parent loop', async () => {
  const h = run('for x in a b c; do (break); echo $x; done');
  await h.run();
  expect(h.out.trim()).toBe('a\nb\nc');
});

test('subshell does not leak positional params', async () => {
  const h = run('set -- a b c; (set -- x y; echo $#); echo $#');
  await h.run();
  expect(h.out.trim()).toBe('2\n3');
});

test('subshell does not leak arrays', async () => {
  const h = run('arr=(a b c); (arr=(x y); echo ${#arr[@]}); echo ${#arr[@]}');
  await h.run();
  expect(h.out.trim()).toBe('2\n3');
});
