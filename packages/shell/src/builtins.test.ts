/* eslint-disable @typescript-eslint/no-explicit-any -- builtin tests use an ad-hoc ctx shape */
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

// ── printf (SH-3) ────────────────────────────────────────────────────────────

/** Run printf and return what it wrote to stdout. */
async function printf(...args: string[]): Promise<string> {
  let out = '';
  const ctx: any = { cwd: '/', env: {}, write: (s: string) => (out += s) };
  await runBuiltin('printf', args, ctx);
  return out;
}

test('printf basic %s %d %% and \\n escapes', async () => {
  expect(await printf('%s=%d%%\n', 'x', '5')).toBe('x=5%\n');
});

test('printf format-string RECYCLING over extra args', async () => {
  expect(await printf('%s\n', 'a', 'b', 'c')).toBe('a\nb\nc\n');
  expect(await printf('%s-%s ', 'a', 'b', 'c', 'd')).toBe('a-b c-d ');
});

test('printf missing args treat %s as empty and %d as 0', async () => {
  expect(await printf('[%s][%d]')).toBe('[][0]');
});

test('printf width and left-justify for %s', async () => {
  expect(await printf('[%5s]', 'ab')).toBe('[   ab]');
  expect(await printf('[%-5s]', 'ab')).toBe('[ab   ]');
});

test('printf precision truncates %s', async () => {
  expect(await printf('[%.3s]', 'abcdef')).toBe('[abc]');
});

test('printf %d width, zero-pad, and sign', async () => {
  expect(await printf('[%5d]', '42')).toBe('[   42]');
  expect(await printf('[%05d]', '42')).toBe('[00042]');
  expect(await printf('[%-5d]', '42')).toBe('[42   ]');
  expect(await printf('[%+d]', '42')).toBe('[+42]');
});

test('printf %x %X %o hex/octal', async () => {
  expect(await printf('%x', '255')).toBe('ff');
  expect(await printf('%X', '255')).toBe('FF');
  expect(await printf('%o', '8')).toBe('10');
  expect(await printf('[%04x]', '255')).toBe('[00ff]');
});

test('printf %f %e %g floats with precision', async () => {
  expect(await printf('%.2f', '3.14159')).toBe('3.14');
  expect(await printf('%.0f', '2.7')).toBe('3');
  expect(await printf('%f', '1')).toBe('1.000000');
  expect(await printf('%e', '12345')).toBe('1.234500e+04');
});

test('printf %c prints first char of string arg', async () => {
  expect(await printf('%c', 'hello')).toBe('h');
});

test('printf %b interprets backslash escapes in the ARG', async () => {
  expect(await printf('%b', 'a\\tb')).toBe('a\tb');
});

test('printf interprets \\xNN and \\0nn in the FORMAT', async () => {
  expect(await printf('\\x41\\x42')).toBe('AB');
  expect(await printf('\\101')).toBe('A'); // octal 101 = 'A'
});

test('printf integer arg accepts hex 0x and char code \'c', async () => {
  expect(await printf('%d', '0xff')).toBe('255');
  expect(await printf('%d', '\'A')).toBe('65');
});

test('printf %i is an alias for %d', async () => {
  expect(await printf('%i', '7')).toBe('7');
});
