import { expect, test } from 'vitest';
import { BUILTINS, runBuiltin } from './builtins.ts';

test('cd updates cwd; pwd reports it', async () => {
  const ctx: any = { cwd: '/', env: {}, stdout: [] as string[], write: (s: string) => ctx.stdout.push(s) };
  await runBuiltin('cd', ['/tmp'], ctx);
  expect(ctx.cwd).toBe('/tmp');
  await runBuiltin('pwd', [], ctx);
  expect(ctx.stdout.join('')).toContain('/tmp');
});

test('export sets an env var', async () => {
  const ctx: any = { cwd: '/', env: {}, write: () => {} };
  await runBuiltin('export', ['FOO=bar'], ctx);
  expect(ctx.env.FOO).toBe('bar');
});

test('echo writes args; true/false set exit code', async () => {
  const ctx: any = { cwd: '/', env: {}, out: '', write: (s: string) => (ctx.out += s) };
  await runBuiltin('echo', ['hello', 'world'], ctx);
  expect(ctx.out).toBe('hello world\n');
  expect(await runBuiltin('true', [], ctx)).toBe(0);
  expect(await runBuiltin('false', [], ctx)).toBe(1);
});

test('BUILTINS lists the documented set', () => {
  for (const b of ['cd', 'pwd', 'export', 'unset', 'echo', 'true', 'false', 'exit', 'test', 'eval']) {
    expect(BUILTINS).toContain(b);
  }
});
