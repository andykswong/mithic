/* eslint-disable @typescript-eslint/no-explicit-any -- low-fix tests use a mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import { Expander } from './expander.ts';
import type { ShellEnv } from './expander.ts';

function mk(ctx: Record<string, unknown> = {}) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

function mkEnv(vars: Record<string, string>): ShellEnv {
  const env = { ...vars };
  return {
    get: (n) => env[n], set: (n, v) => { env[n] = v; }, has: (n) => n in env,
    getSpecial: () => undefined, runCommandSub: async () => '', listDir: async () => undefined,
    statPath: async () => undefined,
    names: () => Object.keys(env),
  } as ShellEnv;
}

// ── LOW: syntax-error messages include "syntax error" ────────────────────────

test('unterminated if reports a syntax error', async () => {
  const h = mk();
  const code = await h.ex.exec('if true; then echo hi');
  expect(code).not.toBe(0);
  expect(h.err.toLowerCase()).toContain('syntax error');
});

test('unexpected token reports a syntax error', async () => {
  const h = mk();
  const code = await h.ex.exec('for; do echo x; done');
  expect(code).not.toBe(0);
  expect(h.err.toLowerCase()).toContain('syntax error');
});

// ── LOW: ${!prefix*} name-prefix expansion ───────────────────────────────────

test('${!prefix*} lists variable names with the prefix', async () => {
  const e = new Expander(mkEnv({ USER_a: '1', USER_b: '2', OTHER: '3' }));
  const fields = await e.expandWord('${!USER*}');
  expect(fields.sort()).toEqual(['USER_a', 'USER_b']);
});

test('${!prefix@} also lists names with the prefix', async () => {
  const e = new Expander(mkEnv({ X1: 'a', X2: 'b' }));
  const fields = await e.expandWord('${!X@}');
  expect(fields.sort()).toEqual(['X1', 'X2']);
});

// ── LOW: jobs format / subshell exit code ─────────────────────────────────────

test('subshell exit code propagates to $?', async () => {
  const h = mk();
  await h.ex.exec('(exit 7); echo $?');
  expect(h.out.trim()).toBe('7');
});
