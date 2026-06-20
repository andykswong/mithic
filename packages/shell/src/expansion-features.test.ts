import { expect, test } from 'vitest';
import { Expander } from './expander.ts';
import type { ShellEnv } from './expander.ts';

function mkEnv(vars: Record<string, string> = {}, hooks: Partial<ShellEnv> = {}): ShellEnv {
  const env = { ...vars };
  return {
    get: (n) => env[n],
    set: (n, v) => { env[n] = v; },
    has: (n) => n in env,
    getSpecial: () => undefined,
    runCommandSub: async () => '',
    listDir: async () => undefined,
    statPath: async () => undefined,
    ...hooks,
  } as ShellEnv;
}
const E = (vars?: Record<string, string>, hooks?: Partial<ShellEnv>) => new Expander(mkEnv(vars, hooks));

// ── H7: case modification ${x^^} ${x,,} ${x^} ${x,} ─────────────────────────

test('${x^^} uppercases all (quoted, single field)', async () => {
  const e = E({ x: 'heLLo World' });
  expect(await e.expandWord('"${x^^}"')).toEqual(['HELLO WORLD']);
});

test('${x,,} lowercases all (quoted, single field)', async () => {
  const e = E({ x: 'heLLo World' });
  expect(await e.expandWord('"${x,,}"')).toEqual(['hello world']);
});

test('${x^} uppercases first char', async () => {
  const e = E({ x: 'hello' });
  expect(await e.expandWord('${x^}')).toEqual(['Hello']);
});

test('${x,} lowercases first char', async () => {
  const e = E({ x: 'HELLO' });
  expect(await e.expandWord('${x,}')).toEqual(['hELLO']);
});

test('${x^^pattern} uppercases only matching chars', async () => {
  const e = E({ x: 'hello' });
  expect(await e.expandWord('${x^^l}')).toEqual(['heLLo']);
});

// ── H7: brace expansion must NOT consume parameter-expansion commas ─────────

test('${x,,} is NOT split into spurious fields by brace expansion', async () => {
  const e = E({ x: 'heLLoWorld' });
  // The bug produced spurious `$` fields; correct: a single lowercased field.
  expect(await e.expandWord('${x,,}')).toEqual(['helloworld']);
});

test('${x^^} survives brace expansion intact', async () => {
  const e = E({ x: 'abc' });
  expect(await e.expandWord('${x^^}')).toEqual(['ABC']);
});

test('real brace expansion still works alongside param expansion', async () => {
  const e = E({ x: 'v' });
  expect(await e.expandWord('{a,b}')).toEqual(['a', 'b']);
  expect(await e.expandWord('pre${x}{1,2}')).toEqual(['prev1', 'prev2']);
});

// ── H6: tilde expansion ──────────────────────────────────────────────────────

test('~ alone expands to $HOME', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~')).toEqual(['/home/me']);
});

test('~/foo expands to $HOME/foo', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~/foo')).toEqual(['/home/me/foo']);
});

test('~ only expands at word start, unquoted', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('a~')).toEqual(['a~']);
  expect(await e.expandWord('"~"')).toEqual(['~']);
});

test('~user form is left literal when no user db', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandWord('~root/x')).toEqual(['~root/x']);
});

test('tilde expands in expandToString (redirect/assignment targets)', async () => {
  const e = E({ HOME: '/home/me' });
  expect(await e.expandToString('~/out.txt')).toBe('/home/me/out.txt');
});
