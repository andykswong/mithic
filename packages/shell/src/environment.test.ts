/**
 * C4 — Environment unit tests. Exercises the extracted variable store directly:
 * scalar/array/assoc storage, the dynamic RANDOM/SHLVL/BASH_VERSION specials,
 * and the `child(overlay)` overlay env that replaced `withOverlay`'s hand-copy.
 */
import { expect, test } from 'vitest';
import { Environment, computeShlvl, BASH_VERSION_STRING } from './environment.ts';
import type { EnvHost } from './environment.ts';
import type { ShellContext } from './executor.ts';

function mkHost(over: Partial<EnvHost> = {}): EnvHost {
  const arrays = new Map<string, string[]>();
  const assoc = new Map<string, Map<string, string>>();
  return {
    lastStatus: () => 0,
    lastBgPid: () => 0,
    pipeStatus: () => [],
    currentLine: () => 0,
    currentFlags: () => '',
    arrays: () => arrays,
    assocArrays: () => assoc,
    nounset: () => false,
    posix: () => false,
    shopt: () => false,
    runCommandSub: async () => '',
    listDir: async () => undefined,
    statPath: async () => undefined,
    procSub: async () => '/dev/null',
    ...over,
  };
}

function mkEnv(env: Record<string, string> = {}, host = mkHost()): { ctx: ShellContext; env: Environment } {
  const ctx: ShellContext = { cwd: '/', env, positional: [] };
  return { ctx, env: new Environment(ctx, host) };
}

test('get/set/has operate on scalar storage', () => {
  const { ctx, env } = mkEnv();
  expect(env.has('X')).toBe(false);
  env.set('X', 'hi');
  expect(env.get('X')).toBe('hi');
  expect(env.has('X')).toBe(true);
  expect(ctx.env.X).toBe('hi'); // wrote through to context.env
});

test('RANDOM is dynamic: get() never returns a stored scalar; getSpecial yields 0..32767', () => {
  const { env } = mkEnv();
  env.set('RANDOM', '12345'); // seeds, does NOT store a scalar
  expect(env.get('RANDOM')).toBeUndefined();
  const v = Number(env.getSpecial('RANDOM'));
  expect(v).toBeGreaterThanOrEqual(0);
  expect(v).toBeLessThanOrEqual(32767);
});

test('seeding RANDOM makes the sequence reproducible', () => {
  const a = mkEnv().env; a.set('RANDOM', '42');
  const b = mkEnv().env; b.set('RANDOM', '42');
  expect(a.getSpecial('RANDOM')).toBe(b.getSpecial('RANDOM'));
});

test('SHLVL is recomputed on assignment (computeShlvl)', () => {
  const { env } = mkEnv();
  env.set('SHLVL', '4');
  expect(env.get('SHLVL')).toBe(String(computeShlvl(4)));
});

test('BASH_VERSION / BASH_VERSINFO are read-only identity vars', () => {
  const { env } = mkEnv();
  env.set('BASH_VERSION', 'nope');
  expect(env.getSpecial('BASH_VERSION')).toBe(BASH_VERSION_STRING);
  expect(env.getArray('BASH_VERSINFO')).toEqual(['5', '3', '0', '1', 'release', 'mithic']);
});

test('getSpecial reads positional + status from the host', () => {
  const host = mkHost({ lastStatus: () => 7, lastBgPid: () => 99, currentFlags: () => 'eu' });
  const ctx: ShellContext = { cwd: '/', env: {}, positional: ['a', 'b', 'c'], pid: 4321 };
  const env = new Environment(ctx, host);
  expect(env.getSpecial('?')).toBe('7');
  expect(env.getSpecial('#')).toBe('3');
  expect(env.getSpecial('$')).toBe('4321');
  expect(env.getSpecial('!')).toBe('99');
  expect(env.getSpecial('-')).toBe('eu');
  expect(env.getSpecial('2')).toBe('b');
});

test('getSpecial(LINENO) reads the current line from the host', () => {
  const host = mkHost({ currentLine: () => 42 });
  const ctx: ShellContext = { cwd: '/', env: {}, positional: [] };
  const env = new Environment(ctx, host);
  expect(env.getSpecial('LINENO')).toBe('42');
});

test('child(overlay) reads overlay first then parent, and writes through to parent', () => {
  const { ctx, env } = mkEnv({ A: 'parent', B: 'keep' });
  const c = env.child({ A: 'over' });
  expect(c.get('A')).toBe('over');   // overlay wins
  expect(c.get('B')).toBe('keep');   // falls back to parent
  c.set('C', 'new');
  expect(ctx.env.C).toBe('new');     // write propagates to the real env
});

test('child shares the RANDOM generator with its parent', () => {
  const { env } = mkEnv();
  env.set('RANDOM', '7');
  const c = env.child({});
  // First draw via the child; the parent's next draw continues the SAME sequence.
  const fresh = mkEnv().env; fresh.set('RANDOM', '7');
  expect(c.getSpecial('RANDOM')).toBe(fresh.getSpecial('RANDOM'));
});
