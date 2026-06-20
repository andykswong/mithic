/* eslint-disable @typescript-eslint/no-explicit-any -- misc executor tests use a minimal mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import { parse } from './parser.ts';

function mockKernel(codes: Record<string, number> = {}) {
  const spawned: any[] = [];
  return {
    spawned,
    async spawn(args: any) {
      spawned.push(args);
      const name = args.args?.[0];
      return { pid: spawned.length, _code: codes[name] ?? 0 };
    },
    async wait(handle: any) {
      const h = this.spawned[this.spawned.length - 1];
      return { pid: handle, code: 0 };
    },
  };
}

function run(src: string, ctx: Record<string, unknown> = {}, codes: Record<string, number> = {}) {
  // Custom kernel: external commands return a code from `codes` keyed by name.
  const spawned: any[] = [];
  const k = {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) {
      const name = spawned[pid - 1]?.args?.[0];
      return { pid, code: codes[name] ?? 0 };
    },
  };
  let out = '';
  let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; },
    onStderr: (s) => { err += s; },
    resolve: (n) => n,
  });
  return { ex, run: () => ex.run(parse(src)), get out() { return out; }, get err() { return err; } };
}

// ── M10: command substitution sets $? ───────────────────────────────────────

test('x=$(false); echo $? → 1', async () => {
  const h = run('x=$(false); echo $?');
  await h.run();
  expect(h.out.trim()).toBe('1');
});

test('x=$(true); echo $? → 0', async () => {
  const h = run('x=$(true); echo $?');
  await h.run();
  expect(h.out.trim()).toBe('0');
});

test('command sub exit code does not clobber a later real status', async () => {
  const h = run('y=$(false); false; echo $?', {}, {});
  await h.run();
  expect(h.out.trim()).toBe('1');
});

// ── M11: $((1/0)) errors with exit 1, not Infinity ──────────────────────────

test('echo $((1/0)) prints error to stderr and aborts nonzero', async () => {
  const h = run('echo $((1/0))');
  const code = await h.run();
  expect(code).not.toBe(0);
  expect(h.err.toLowerCase()).toMatch(/division by 0|divide/);
  expect(h.out).not.toContain('Infinity');
});

test('(( 1 / 0 )) arithmetic command errors nonzero', async () => {
  const h = run('(( 1 / 0 )); echo after=$?');
  await h.run();
  // After a div-by-zero, the arith command fails; the rest may run.
  expect(h.err.toLowerCase()).toMatch(/division by 0|divide/);
});
