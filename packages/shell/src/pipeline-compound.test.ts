/* eslint-disable @typescript-eslint/no-explicit-any -- pipeline tests use a mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mk(ctx: Record<string, unknown> = {}) {
  const spawned: any[] = [];
  const k = {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, spawned, get out() { return out; }, get err() { return err; } };
}

// ── M1: compound commands in a pipeline (parse without SyntaxError) ──────────

test('(subshell) | builtin does not throw SyntaxError', async () => {
  const h = mk();
  // The subshell emits two lines; `cat` (builtin, stdin) passes them through.
  const code = await h.ex.exec('(echo a; echo b) | cat');
  expect(code).toBe(0);
  expect(h.out).toBe('a\nb\n');
});

test('{ group; } | builtin pipes group output', async () => {
  const h = mk();
  const code = await h.ex.exec('{ echo x; echo y; } | cat');
  expect(code).toBe(0);
  expect(h.out).toBe('x\ny\n');
});

test('if ... | builtin pipes the if-branch output', async () => {
  const h = mk();
  const code = await h.ex.exec('if true; then echo hit; fi | cat');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('hit');
});

test('builtin | (subshell consuming stdin)', async () => {
  const h = mk();
  // First stage is a builtin echo; second a subshell running cat.
  const code = await h.ex.exec('echo hello | (cat)');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('hello');
});

// ── H8: |& pipes stdout AND stderr into the next stage ───────────────────────

test('|& routes stage stderr into next stage stdin', async () => {
  const h = mk();
  // A function writing to stderr; |& should funnel it to cat.
  const code = await h.ex.exec('errcmd() { echo oops >&2; }; errcmd |& cat');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('oops');
});

test('|& rejected in POSIX mode', async () => {
  const h = mk();
  h.ex.setOption('posix', true);
  const code = await h.ex.exec('echo a |& cat');
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

// ── M6: C-style for ((init; cond; incr)) ─────────────────────────────────────

test('C-style for ((i=0; i<3; i++)) iterates', async () => {
  const h = mk();
  const code = await h.ex.exec('for ((i=0; i<3; i++)); do echo $i; done');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('0\n1\n2');
});

test('C-style for with no init/cond/incr (infinite) honors break', async () => {
  const h = mk();
  const code = await h.ex.exec('n=0; for ((;;)); do echo $n; n=$((n+1)); if [ $n -ge 2 ]; then break; fi; done');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('0\n1');
});
